import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingInt } from '@/lib/settings';
import { trySendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { auditAs, notifyAdmins } from '@/lib/observability';
import { mailLayout } from '@/lib/quotes/mail';
import { buyerCanCancelUnpaid } from '@/lib/quotes/policy';
import { heldMoneyCents } from '@/lib/finance/held';

/**
 * GDPR art. 17 erasure ("delete my account") that keeps what Dutch law
 * requires: issued invoices / credit notes and the orders they belong to are
 * kept for the fiscal retention period (art. 52 AWR, 7 years — Settings →
 * Documents → retention), but the ACCOUNT is anonymised. Everything else that
 * identifies the person is removed:
 *
 *  - the account: name → "Deleted user", e-mail → deleted+…@lab2date.invalid,
 *    photo, saved bank details, marketing consent; it can never sign in again
 *    (sessions, password, authenticator and recovery codes deleted);
 *  - billing profile, cart, wish list, notifications, assistant chats;
 *  - quote requests without a deal (name / e-mail / company / description);
 *  - orders without any money or document: addresses, invoice e-mail, IP;
 *  - support tickets: the name and e-mail on the ticket.
 * Kept (legal obligation, art. 17(3)(b)): every issued fiscal document (its
 * frozen snapshot holds the bill-to the law requires) and the orders, payments
 * and refunds behind them; the audit trail.
 */

export const DELETED_EMAIL_HOST = 'lab2date.invalid';

export interface ErasurePlan {
  blockers: string[];
  /** What is removed (for the confirmation page / e-mail). */
  removed: string[];
  /** What is kept and why. */
  kept: string[];
}

/** What erasing this account would do — and what still stands in the way. */
export async function erasurePlan(userId: string, opts: { forStaff?: boolean } = {}): Promise<ErasurePlan> {
  await ensureSettingsLoaded();
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, email: true, _count: { select: { productsOwned: true } } } });
  if (!u) return { blockers: ['Account not found.'], removed: [], kept: [] };
  const blockers: string[] = [];
  if (u.email.endsWith(`@${DELETED_EMAIL_HOST}`)) blockers.push('This account was already deleted.');
  if (u.role === 'ADMIN' && !opts.forStaff) blockers.push('Staff accounts are removed by a super-admin (Admin → Users), not here.');
  if (u._count.productsOwned > 0) blockers.push(`This account owns ${u._count.productsOwned} listing${u._count.productsOwned === 1 ? '' : 's'} as a supplier — they must be handed over or archived first (contact support).`);
  const orders = await prisma.order.findMany({
    where: { buyerId: userId },
    select: { orderNumber: true, status: true, financialStatus: true, paymentSubmittedAt: true, amountPaidCents: true, sourcingRequestId: true, refunds: { where: { status: { in: ['REQUESTED', 'SENT', 'CONFIRMED'] } }, select: { id: true, status: true, amountCents: true } }, _count: { select: { documents: true } } },
  });
  for (const o of orders) {
    if (o.status === 'PENDING_PAYMENT') {
      blockers.push(o.paymentSubmittedAt
        ? `Order ${o.orderNumber}: your payment is being verified — wait until it is confirmed or rejected.`
        : heldMoneyCents(o.amountPaidCents, o.refunds) > 0
          ? `Order ${o.orderNumber} is part paid — contact support: we cancel it and refund what you paid, or you pay the rest.`
          : o.sourcingRequestId && buyerCanCancelUnpaid()
            ? `Order ${o.orderNumber} is open and unpaid — cancel it on its payment page first.`
            : `Order ${o.orderNumber} is open and unpaid — ask support to cancel it first.`);
    } else if (['PAID', 'PROCESSING', 'SHIPPED'].includes(o.status)) {
      blockers.push(`Order ${o.orderNumber} is ${o.status.toLowerCase()} and not delivered yet — the account can be deleted once it is delivered.`);
    }
    if (['INVOICED_ON_TERMS', 'OVERDUE', 'PARTIALLY_PAID'].includes(o.financialStatus) && !['CANCELED', 'PENDING_PAYMENT'].includes(o.status)) {
      blockers.push(`The invoice of order ${o.orderNumber} is not paid yet — it has to be settled first.`);
    }
    if (o.refunds.some((r) => r.status === 'REQUESTED')) blockers.push(`A refund for order ${o.orderNumber} is still being sent to you — wait until you received it.`);
  }
  const fiscal = orders.filter((o) => o._count.documents > 0 || o.amountPaidCents > 0 || ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'].includes(o.status));
  const years = settingInt('DOC_RETENTION_YEARS', 7);
  return {
    blockers: Array.from(new Set(blockers)),
    removed: [
      'your name, e-mail address and photo on the account — it can never be signed in to again',
      'your password, authenticator app and recovery codes, and every signed-in device',
      'your saved billing details, cart, wish list, notifications and assistant chats',
      'quote requests that did not lead to an order, and the addresses of orders that were never paid',
      'your name and e-mail on support tickets',
    ],
    kept: fiscal.length
      ? [
          `${fiscal.length} order${fiscal.length === 1 ? '' : 's'} with ${fiscal.length === 1 ? 'its' : 'their'} invoices / credit notes, payments and refunds: Dutch tax law requires us to keep them for ${years} years (they show the billing details as they were invoiced). They are no longer linked to a named account.`,
          'security and audit records (who did what, when) — kept to protect the platform.',
        ]
      : ['security and audit records (who did what, when) — kept to protect the platform.'],
  };
}

/**
 * Erase (anonymise) the account. `actor` = the person themselves (after a
 * fresh password / authenticator confirmation) or a staff member with
 * users:manage. Refuses while anything blocks it.
 */
export async function eraseAccount(
  userId: string,
  actor: { kind: 'SELF' | 'STAFF'; id: string; email: string; ip?: string | null },
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  const plan = await erasurePlan(userId, { forStaff: actor.kind === 'STAFF' });
  if (plan.blockers.length) return { ok: false, message: `Not deleted: ${plan.blockers.join(' ')}` };
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, role: true } });
  if (!u) return { ok: false, message: 'Account not found.' };
  if (u.role === 'ADMIN') {
    const others = await prisma.user.count({ where: { role: 'ADMIN', NOT: { id: u.id }, suspendedAt: null } });
    if (others === 0) return { ok: false, message: 'Not deleted: this is the last admin account.' };
  }
  const anonEmail = `deleted+${randomBytes(9).toString('base64url').toLowerCase()}@${DELETED_EMAIL_HOST}`;
  const oldEmail = u.email;
  const now = new Date();

  // Tell the person first (afterwards we no longer have their address).
  const mail = await trySendEmail({
    to: oldEmail,
    subject: 'Your lab2date account was deleted',
    html: mailLayout({
      heading: 'Your account was deleted',
      body: [
        `Hi <span dir="auto">${escapeHtml(u.name || 'there')}</span>,`,
        actor.kind === 'SELF' ? 'As you asked, we deleted your lab2date account.' : 'At your request, our team deleted your lab2date account.',
        `<strong>Removed:</strong><br>${plan.removed.map((r) => `• ${escapeHtml(r)}`).join('<br>')}`,
        `<strong>Kept, because the law requires it:</strong><br>${plan.kept.map((r) => `• ${escapeHtml(r)}`).join('<br>')}`,
        'If you did not ask for this, contact us right away by replying to this e-mail.',
      ],
    }),
    text: `Your lab2date account was deleted.\n\nRemoved:\n- ${plan.removed.join('\n- ')}\n\nKept (required by law):\n- ${plan.kept.join('\n- ')}`,
  }, 'gdpr:erase');

  await prisma.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });
    await tx.twoFactor.deleteMany({ where: { userId } });
    await tx.verification.deleteMany({ where: { identifier: { contains: oldEmail } } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.cartItem.deleteMany({ where: { userId } });
    await tx.wishlistItem.deleteMany({ where: { userId } });
    await tx.assistantConversation.deleteMany({ where: { userId } });
    await tx.billingProfile.deleteMany({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: {
        name: 'Deleted user',
        email: anonEmail,
        image: null,
        emailVerified: false,
        sellerBankDetails: undefined,
        marketingOptIn: false,
        marketingConsentAt: null,
        marketingConsentSource: null,
        twoFactorEnabled: false,
        adminCaps: [],
        suspendedAt: now,
        suspendedReason: 'Account deleted at the owner’s request (GDPR erasure).',
      },
    });
    await tx.$executeRaw`UPDATE "user" SET "sellerBankDetails" = NULL WHERE "id" = ${userId}`;
    // Quote requests that never became a deal: no business record to keep.
    await tx.sourcingRequest.updateMany({
      where: { submittedById: userId, proformaNumber: null, status: { not: 'ACCEPTED' } },
      data: { buyerName: 'Deleted user', buyerEmail: anonEmail, companyName: null, description: '[removed at the requester’s request]' },
    });
    await tx.sourcingRequest.updateMany({ where: { submittedById: userId, status: { in: ['PENDING', 'RESPONDED'] } }, data: { status: 'CLOSED', lostReason: 'Account deleted' } });
    // Orders without money or documents: drop the addresses.
    await tx.order.updateMany({
      where: { buyerId: userId, status: 'CANCELED', amountPaidCents: 0, documents: { none: {} } },
      data: { shippingAddress: undefined, billingAddress: undefined, invoiceEmail: null, buyerIp: null, poNumber: null },
    });
    await tx.$executeRaw`UPDATE "Order" SET "shippingAddress" = NULL, "billingAddress" = NULL WHERE "buyerId" = ${userId} AND "status" = 'CANCELED' AND "amountPaidCents" = 0 AND NOT EXISTS (SELECT 1 FROM "FiscalDocument" d WHERE d."orderId" = "Order"."id")`;
    // Support tickets: no name / e-mail.
    await tx.supportTicket.updateMany({ where: { OR: [{ submittedById: userId }, { email: oldEmail }] }, data: { name: 'Deleted user', email: anonEmail } });
  });
  await auditAs({ id: actor.id, email: actor.email, ip: actor.ip ?? null }, 'gdpr.erase', userId, `${actor.kind === 'SELF' ? 'self-service' : `by staff ${actor.email}`}: ${reason}`.slice(0, 480));
  await notifyAdmins('Account deleted (GDPR erasure)', `An account was deleted ${actor.kind === 'SELF' ? 'by its owner' : `by ${actor.email}`}. Fiscal records kept, personal data removed.`, `/admin/users/${userId}`, 'SYSTEM');
  return {
    ok: true,
    message: `The account was deleted (anonymised). ${mail.ok ? 'A confirmation was e-mailed to the old address.' : `The confirmation e-mail could not be delivered (${mail.error}).`}`,
  };
}
