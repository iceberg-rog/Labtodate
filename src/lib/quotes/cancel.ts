import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isDeliverableEmail, sendInternalEmail, trySendEmail } from '@/lib/email';
import { escapeHtml, escapeHtmlLines } from '@/lib/email-html';
import { audit, notifyAdmins, notifyUser } from '@/lib/observability';
import { voidProformas } from '@/lib/documents/issue';
import { formatPrice } from '@/lib/utils';
import { ensureSettingsLoaded } from '@/lib/settings';
import { siteName } from '@/lib/brand/identity';
import { QUOTE_REF, isoDay, sentence } from './offer';
import { autoArchiveOnClose, repliesReachUs } from './policy';
import { releaseQuoteHold } from './stock';
import { heldMoneyCents, LIVE_REFUNDS_SELECT } from '@/lib/finance/held';
import { mailLayout, siteBase } from './mail';

/**
 * Cancel an accepted-but-unpaid QUOTE order (owner report 6) — the one path
 * used by the buyer ("Cancel order" on the payment page), by staff (Deal panel
 * / order page) and by the due-date sweep. In one transaction: void the open
 * proforma (with the reason), cancel the order, release the held unit, close
 * the quote with the lost reason and leave a line in the conversation. Then
 * email the buyer (truthfully reported back), tell staff and the supplier.
 *
 * A receipt waiting for verification blocks it (verify or reject first); a paid
 * order is never canceled here — that is a refund + credit note.
 * Server-internal: callers check who may do this.
 */

export type CancelActor = { kind: 'BUYER' | 'STAFF' | 'SYSTEM'; id: string | null; email: string | null };

export type CancelQuoteOrderResult =
  | {
      ok: true;
      orderNumber: string;
      quoteId: string;
      quoteRef: string;
      voided: string[];
      unitsReleased: number;
      buyerEmailed: boolean;
      buyerEmailError: string | null;
      buyerEmail: string;
    }
  | { ok: false; message: string };

class CancelRefused extends Error {}

/** Why the cancel claim found the order changed — read again, said as it is. */
async function changedMeanwhile(tx: Prisma.TransactionClient, orderId: string, orderNumber: string, actor: CancelActor): Promise<string> {
  const now = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, paymentSubmittedAt: true, amountPaidCents: true, currency: true } });
  if (!now || now.status === 'CANCELED') return `Order ${orderNumber} is already canceled.`;
  if (now.status !== 'PENDING_PAYMENT') return `Order ${orderNumber} was just paid — a paid order is refunded (with a credit note), not canceled.`;
  if (now.paymentSubmittedAt) {
    return actor.kind === 'BUYER'
      ? `A payment receipt for order ${orderNumber} was just uploaded, so it can not be canceled online. Contact support — we check the payment first.`
      : `A payment receipt for order ${orderNumber} was just uploaded — verify or reject it first.`;
  }
  if (now.amountPaidCents > 0) return `A payment of ${formatPrice(now.amountPaidCents, now.currency)} was just recorded for order ${orderNumber} — refund it first, then cancel.`;
  return `Order ${orderNumber} changed a moment ago. Reload the page and check it.`;
}

export async function cancelQuoteOrder(
  orderId: string,
  actor: CancelActor,
  opts: {
    reason: string;
    note?: string | null;
    /** Stored on the quote (Lost tab). Default: "Canceled by the buyer: <reason>" / "Canceled by <brand> after acceptance". */
    lostReason?: string;
    emailBuyer?: boolean;
    buyerEmailHtml?: (ctx: { orderNumber: string; voided: string[]; total: string }) => { subject: string; html: string };
  },
): Promise<CancelQuoteOrderResult> {
  await ensureSettingsLoaded();
  const now = new Date();
  const site = siteName();
  // Callers written before the brand setting pass the old brand literal: the
  // configured brand (SITE_NAME) is what the quote shows.
  const lostReason = (opts.lostReason ?? (actor.kind === 'BUYER' ? `Canceled by the buyer: ${opts.reason}` : `Canceled by ${site} after acceptance`))
    .replace(/\blab2date\b/gi, site);
  const why = sentence(`${opts.reason}${opts.note ? ` — ${opts.note}` : ''}`);
  let out: { orderNumber: string; quoteId: string; voided: string[]; units: number; total: string; buyer: { id: string; email: string; name: string }; title: string; assigned: { id: string; role: string; email: string } | null };
  try {
    out = await prisma.$transaction(async (tx) => {
      const o = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true, orderNumber: true, status: true, paymentSubmittedAt: true, financialStatus: true, adminNotes: true,
          totalCents: true, currency: true, sourcingRequestId: true, amountPaidCents: true, amountRefundedCents: true, refunds: LIVE_REFUNDS_SELECT,
          buyer: { select: { id: true, email: true, name: true } },
          items: { select: { titleSnapshot: true }, take: 1 },
          sourcingRequest: { select: { id: true, status: true, archivedAt: true, assignedTo: { select: { id: true, role: true, email: true } } } },
        },
      });
      if (!o || !o.sourcingRequestId || !o.sourcingRequest) throw new CancelRefused('This is not a quote order.');
      if (o.status === 'CANCELED') throw new CancelRefused(`Order ${o.orderNumber} is already canceled.`);
      if (o.status !== 'PENDING_PAYMENT') {
        throw new CancelRefused(`Order ${o.orderNumber} is ${o.status.toLowerCase().replace(/_/g, ' ')} — a paid order is refunded (with a credit note), not canceled.`);
      }
      if (o.paymentSubmittedAt) {
        throw new CancelRefused(actor.kind === 'BUYER'
          ? `You already sent a payment receipt for order ${o.orderNumber}. Contact support to cancel it — we check the payment first.`
          : `A payment receipt for order ${o.orderNumber} is waiting for verification — verify or reject it first.`);
      }
      // Money already received (a part payment) and not refunded: canceling would keep it silently.
      const kept = heldMoneyCents(o.amountPaidCents, o.refunds);
      if (kept > 0) {
        const got = formatPrice(kept, o.currency);
        throw new CancelRefused(actor.kind === 'BUYER'
          ? `We already received ${got} for order ${o.orderNumber}, so it can not be canceled online. Contact support — we cancel it and refund what you paid.`
          : `${got} was already received for order ${o.orderNumber} (part payment). Refund it first (Refund / credit on the order page), then cancel.`);
      }
      const open = await tx.fiscalDocument.findMany({
        where: { orderId: o.id, kind: 'PROFORMA', voidedAt: null, supersededById: null },
        select: { number: true },
      });
      await voidProformas(o.id, `Order canceled: ${opts.reason}`.slice(0, 300), tx);
      const claim = await tx.order.updateMany({
        where: { id: o.id, status: 'PENDING_PAYMENT', paymentSubmittedAt: null, amountPaidCents: o.amountPaidCents, amountRefundedCents: o.amountRefundedCents },
        data: {
          status: 'CANCELED',
          adminNotes: `${o.adminNotes ? `${o.adminNotes}\n` : ''}[${isoDay(now)}] Canceled by ${actor.kind === 'BUYER' ? 'the buyer' : actor.kind === 'SYSTEM' ? 'the system' : actor.email ?? 'staff'}: ${sentence(`${opts.reason}${open.length ? ` — proforma ${open.map((d) => d.number).join(', ')} void` : ''}`)}`.slice(0, 4000),
        },
      });
      if (claim.count !== 1) throw new CancelRefused(await changedMeanwhile(tx, o.id, o.orderNumber, actor));
      const units = await releaseQuoteHold(o.sourcingRequestId, `Order ${o.orderNumber} canceled: ${opts.reason}`, tx);
      const archive = autoArchiveOnClose() && !o.sourcingRequest.archivedAt;
      await tx.sourcingRequest.updateMany({
        where: { id: o.sourcingRequestId, status: { in: ['ACCEPTED', 'RESPONDED'] } },
        data: {
          status: 'CLOSED', lostReason, lostNote: opts.note ?? opts.reason, dueAt: null,
          ...(archive ? { archivedAt: now, archivedById: actor.id } : {}),
        },
      });
      await tx.quoteMessage.create({
        data: {
          sourcingRequestId: o.sourcingRequestId,
          authorId: actor.id,
          fromStaff: actor.kind !== 'BUYER',
          body: `Order ${o.orderNumber} was canceled ${actor.kind === 'BUYER' ? 'by the buyer' : actor.kind === 'SYSTEM' ? 'automatically' : `by ${site}`}: ${why}${open.length ? ` Proforma ${open.map((d) => d.number).join(', ')} is void; no payment is due.` : ' No payment is due.'}${units ? ' The reserved unit is back on sale.' : ''}`,
        },
      });
      return {
        orderNumber: o.orderNumber,
        quoteId: o.sourcingRequestId,
        voided: open.map((d) => d.number),
        units,
        total: formatPrice(o.totalCents, o.currency),
        buyer: o.buyer,
        title: o.items[0]?.titleSnapshot ?? 'your order',
        assigned: o.sourcingRequest.assignedTo,
      };
    });
  } catch (e) {
    if (e instanceof CancelRefused) return { ok: false, message: e.message };
    if (e instanceof Prisma.PrismaClientKnownRequestError) return { ok: false, message: `The order could not be canceled (${e.code}). Nothing was changed.` };
    throw e;
  }

  const ref = QUOTE_REF(out.quoteId);
  let buyerEmailed = false;
  let buyerEmailError: string | null = null;
  if (opts.emailBuyer !== false) {
    const custom = opts.buyerEmailHtml?.({ orderNumber: out.orderNumber, voided: out.voided, total: out.total });
    const sent = await trySendEmail({
      to: out.buyer.email,
      subject: custom?.subject ?? `Order ${out.orderNumber} canceled — no payment due`,
      html: custom?.html ?? mailLayout({
        heading: `Order ${out.orderNumber} is canceled`,
        body: [
          `Hi <span dir="auto">${escapeHtml(out.buyer.name || 'there')}</span>,`,
          actor.kind === 'BUYER'
            ? `As you asked, we canceled order <strong>${out.orderNumber}</strong> (<span dir="auto">${escapeHtml(out.title)}</span>, ${escapeHtml(out.total)}).`
            : `We canceled order <strong>${out.orderNumber}</strong> (<span dir="auto">${escapeHtml(out.title)}</span>, ${escapeHtml(out.total)}).`,
          `Reason: ${escapeHtmlLines(opts.reason)}${opts.note && actor.kind !== 'SYSTEM' ? ` — <span dir="auto">${escapeHtml(opts.note)}</span>` : ''}`,
          `<p style="margin:0 0 12px;"><strong>No payment is due.</strong>${out.voided.length ? ` Proforma ${out.voided.map((n) => `<strong>${escapeHtml(n)}</strong>`).join(', ')} is void — please do not transfer money for it.` : ''} If you already sent a transfer, ${repliesReachUs() ? 'reply to this email or ' : ''}<a href="${escapeHtml(`${siteBase()}/support?order=${encodeURIComponent(out.orderNumber)}`)}">contact our support team</a> and we refund it.</p>`,
        ],
        cta: { href: `${siteBase()}/app/orders/${out.orderNumber}`, label: 'View the order' },
        footer: [`Reference ${ref}`],
      }),
    }, 'quotes:order-cancel');
    buyerEmailed = sent.ok;
    buyerEmailError = sent.ok ? null : sent.error;
    await notifyUser(out.buyer.id, `Order ${out.orderNumber} canceled`, `No payment is due.${out.voided.length ? ` Proforma ${out.voided.join(', ')} is void.` : ''}`, `/app/orders/${out.orderNumber}`);
  }
  const who = actor.kind === 'BUYER' ? 'the buyer' : actor.kind === 'SYSTEM' ? 'the due-date sweep' : actor.email ?? 'staff';
  await notifyAdmins(
    `Order ${out.orderNumber} canceled by ${actor.kind === 'BUYER' ? 'the buyer' : actor.kind === 'SYSTEM' ? 'the system' : 'staff'}`,
    `${ref} · ${out.total} · ${opts.reason}${out.voided.length ? ` · proforma ${out.voided.join(', ')} void` : ''}${out.units ? ' · unit released' : ''}${opts.emailBuyer === false ? '' : buyerEmailed ? ' · buyer emailed' : ` · buyer email FAILED (${buyerEmailError})`}`,
    `/admin/quotes/${out.quoteId}`,
    'ORDER_CANCELED',
  );
  if (actor.kind === 'BUYER') {
    await sendInternalEmail({
      to: process.env.QUOTE_INTAKE_EMAIL ?? '',
      subject: `[${ref}] The buyer canceled order ${out.orderNumber}`,
      html: mailLayout({
        heading: 'The buyer canceled an accepted order',
        body: [
          `Order <strong>${out.orderNumber}</strong> (${escapeHtml(out.total)}) was canceled by the buyer before payment.`,
          `Reason: <strong>${escapeHtml(opts.reason)}</strong>${opts.note ? ` — <span dir="auto">${escapeHtml(opts.note)}</span>` : ''}`,
          out.voided.length ? `Proforma ${out.voided.map(escapeHtml).join(', ')} is void.` : '',
          out.units ? 'The reserved unit is back on sale.' : '',
        ].filter(Boolean),
        cta: { href: `${siteBase()}/admin/quotes/${out.quoteId}`, label: 'Open the quote' },
      }),
    }, 'quotes:order-cancel-staff');
  }
  if (out.assigned?.role === 'SELLER') {
    await notifyUser(out.assigned.id, `Deal canceled — ${ref}`, 'The accepted order was canceled before payment. No further action is needed.', `/app/seller/inbox/${out.quoteId}`);
    if (isDeliverableEmail(out.assigned.email)) {
      await sendInternalEmail({
        to: out.assigned.email,
        subject: `[${ref}] The accepted order was canceled`,
        html: mailLayout({ heading: 'The accepted order was canceled', body: ['The order for this request was canceled before payment. The unit is no longer reserved for it.'], cta: { href: `${siteBase()}/app/seller/inbox/${out.quoteId}`, label: 'Open the request' } }),
      }, 'quotes:order-cancel-seller');
    }
  }
  await audit('order.cancel', out.orderNumber, `quote ${ref} · by ${who} · ${opts.reason}${opts.note ? ` · "${opts.note.slice(0, 120)}"` : ''} · void=${out.voided.join(',') || 'none'} · units=${out.units}${opts.emailBuyer === false ? '' : ` · buyer email ${buyerEmailed ? 'ok' : `failed: ${buyerEmailError}`}`}`);
  return {
    ok: true,
    orderNumber: out.orderNumber,
    quoteId: out.quoteId,
    quoteRef: ref,
    voided: out.voided,
    unitsReleased: out.units,
    buyerEmailed,
    buyerEmailError,
    buyerEmail: out.buyer.email,
  };
}

/** One sentence for the person who canceled (truthful about the email). */
export function cancelSummary(r: Extract<CancelQuoteOrderResult, { ok: true }>, viewer: 'BUYER' | 'STAFF'): string {
  const parts = [`Order ${r.orderNumber} is canceled.`];
  if (r.voided.length) parts.push(`Proforma ${r.voided.join(', ')} is void — no payment is due.`);
  if (r.unitsReleased) parts.push(viewer === 'STAFF' ? 'The reserved unit is back on sale.' : '');
  if (viewer === 'STAFF') {
    parts.push(r.buyerEmailed ? `The buyer was emailed (${r.buyerEmail}).` : `The buyer was notified in-app, but the email to ${r.buyerEmail} could not be delivered (${r.buyerEmailError}).`);
  } else {
    parts.push(r.buyerEmailed ? 'We emailed you a confirmation.' : 'We could not email you a confirmation right now — this page is your confirmation.');
  }
  return parts.filter(Boolean).join(' ');
}
