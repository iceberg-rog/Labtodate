import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sendInternalEmail, trySendEmail, isDeliverableEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { audit, notifyAdmins, notifyUser, logError } from '@/lib/observability';
import { formatPrice } from '@/lib/utils';
import { documentAttachment, getOrderDocuments, snapshotOf } from '@/lib/documents/issue';
import { cancelAndRestockOrder } from '@/lib/orders/checkout-tx';
import { releaseExpiredReservations } from '@/lib/stock/reserve';
import { cancelQuoteOrder } from '@/lib/quotes/cancel';
import { QUOTE_REF } from '@/lib/quotes/offer';
import { offerAmounts } from '@/lib/quotes/pricing';
import {
  autoCancelUnpaid, offerExpiredStaffAlert, offerExpiryReminderDays, paymentGraceDays, paymentOverdueNotice, paymentReminderDays, paymentTermDays,
} from '@/lib/quotes/policy';
import { mailLayout, mailTable, siteBase } from '@/lib/quotes/mail';
import { cancelAfter, daysUntil, duePhase, effectiveDueDate, fmtDueDate, remindersToSend } from './payment-due';
import { heldMoneyCents, LIVE_REFUNDS_SELECT } from '@/lib/finance/held';

/**
 * The payment-due sweep (A25), run by the sla-sweep cron:
 *  1. unpaid bank-transfer orders: reminders before the due date
 *     (PAYMENT_REMINDER_DAYS_BEFORE), one overdue notice, and — only after
 *     due date + PAYMENT_GRACE_DAYS with AUTO_CANCEL_UNPAID on — the
 *     cancellation (proforma voided, stock released, buyer + staff emailed).
 *     A receipt in review, any hold (pre-payment holds of lib/checkout/holds.ts,
 *     payment review) or an invoice-terms request always stops it.
 *  2. open offers: buyer reminders before they expire (OFFER_EXPIRY_REMINDER_DAYS)
 *     and one staff alert when one expired unanswered.
 *  3. expired stock holds of open offers are released.
 * Every notice is sent at most once (ReminderLog unique per subject/kind/step).
 * Only candidate rows are selected (no unbounded re-selection of finished deals).
 */

const BATCH = 300;
// Hard floor for checkout orders (Stripe session max lifetime 24 h + margin).
const CHECKOUT_FLOOR_MS = 25 * 3600_000;

/** Claim a notice (unique per subject/kind/step): true only for the one sweep that may send it. */
async function claim(subjectType: 'ORDER' | 'QUOTE', subjectId: string, kind: string, step = 0, detail?: string): Promise<boolean> {
  const r = await prisma.reminderLog.createMany({ data: [{ subjectType, subjectId, kind, step, detail: detail?.slice(0, 300) }], skipDuplicates: true });
  return r.count === 1;
}

async function markSent(subjectType: string, subjectId: string, kind: string, step: number, ok: boolean): Promise<void> {
  await prisma.reminderLog.updateMany({ where: { subjectType, subjectId, kind, step }, data: { emailOk: ok } }).catch(() => {});
}

export interface DueSweepResult {
  paymentReminders: number;
  overdueNotices: number;
  canceled: number;
  offerReminders: number;
  offerExpiredAlerts: number;
  holdsReleased: number;
  errors: number;
}

export async function runPaymentDueSweep(
  now = new Date(),
  /** Tests only: restrict the sweep to these rows. */
  only?: { orderIds?: string[]; quoteIds?: string[] },
): Promise<DueSweepResult> {
  await ensureSettingsLoaded();
  const out: DueSweepResult = { paymentReminders: 0, overdueNotices: 0, canceled: 0, offerReminders: 0, offerExpiredAlerts: 0, holdsReleased: 0, errors: 0 };
  const term = paymentTermDays();
  const grace = paymentGraceDays();
  const steps = paymentReminderDays();
  const autoCancel = autoCancelUnpaid();
  const overdueNotice = paymentOverdueNotice();
  const horizon = new Date(now.getTime() + (Math.max(0, ...steps) + 1) * 86_400_000);

  // ── 1. unpaid bank-transfer orders near / past their due date ──
  const orders = await prisma.order.findMany({
    where: {
      ...(only ? { id: { in: only.orderIds ?? [] } } : {}),
      status: 'PENDING_PAYMENT',
      stripeSessionId: null,
      paymentSubmittedAt: null,
      holdReason: null,
      archivedAt: null,
      OR: [{ paymentVerificationStatus: null }, { paymentVerificationStatus: 'REJECTED' }],
      AND: [
        // No due date yet: the term counts from payableSince (an order that was on
        // a pre-payment hold) or, for older rows, from the order date.
        { OR: [
          { dueAt: { lte: horizon } },
          { dueAt: null, payableSince: { lte: new Date(horizon.getTime() - term * 86_400_000) } },
          { dueAt: null, payableSince: null, createdAt: { lte: new Date(horizon.getTime() - term * 86_400_000) } },
        ] },
        // A legacy order on an offer the buyer never accepted is handled as an offer.
        { OR: [{ sourcingRequestId: null }, { sourcingRequest: { is: { status: { not: 'RESPONDED' } } } }] },
      ],
    },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    take: BATCH,
    select: {
      id: true, orderNumber: true, createdAt: true, dueAt: true, payableSince: true, totalCents: true, currency: true, sourcingRequestId: true,
      amountPaidCents: true, refunds: LIVE_REFUNDS_SELECT,
      buyer: { select: { id: true, email: true, name: true } },
      items: { select: { productId: true, quantity: true } },
      sourcingRequest: { select: { validUntilAt: true } },
    },
  });

  for (const o of orders) {
    try {
      const due = effectiveDueDate({ dueAt: o.dueAt, createdAt: o.createdAt, payableSince: o.payableSince, legacyValidUntil: o.sourcingRequest?.validUntilAt ?? null }, term);
      const phase = duePhase(now, due, grace);
      // A part payment was received: reminders name what is still open, and the order is never auto-canceled.
      const kept = heldMoneyCents(o.amountPaidCents, o.refunds);
      const money = formatPrice(Math.max(0, o.totalCents - kept), o.currency);
      const payUrl = `${siteBase()}/app/orders/${o.orderNumber}/payment`;
      const docs = await getOrderDocuments(o.id);
      const pf = docs.proforma ? snapshotOf(docs.proforma) : null;
      const ref = docs.proforma?.number ?? o.orderNumber;

      if (phase === 'OPEN') {
        const sent = (await prisma.reminderLog.findMany({ where: { subjectType: 'ORDER', subjectId: o.id, kind: 'PAYMENT_DUE_SOON' }, select: { step: true } })).map((r) => r.step);
        const plan = remindersToSend(now, due, steps, sent);
        for (const k of plan.skip) await claim('ORDER', o.id, 'PAYMENT_DUE_SOON', k, 'skipped (a later reminder was due)');
        if (plan.send != null && (await claim('ORDER', o.id, 'PAYMENT_DUE_SOON', plan.send))) {
          const left = daysUntil(now, due);
          const att = docs.proforma ? await documentAttachment(docs.proforma) : { attachment: null };
          const bank = pf?.bank;
          const r = await trySendEmail({
            to: o.buyer.email,
            subject: `Reminder: payment for order ${o.orderNumber} is due ${left <= 0 ? 'today' : `on ${fmtDueDate(due)}`}`,
            html: mailLayout({
              heading: `Payment due ${left <= 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`}`,
              body: [
                `Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,`,
                `A friendly reminder: please pay <strong>${escapeHtml(money)}</strong> for order <strong>${o.orderNumber}</strong> by <strong>${escapeHtml(fmtDueDate(due))}</strong>.`,
                mailTable([
                  ...(bank ? [['IBAN', `<span style="font-family:ui-monospace,monospace;">${escapeHtml(bank.iban)}</span>`] as [string, string], ['Beneficiary', escapeHtml(bank.beneficiary)] as [string, string]] : []),
                  ['Reference', `<strong>${escapeHtml(ref)}</strong>`],
                  ['Amount', escapeHtml(money), true],
                ]),
                'Already paid? Then upload your bank receipt on the payment page so we can verify it — or ignore this email if you did that already.',
              ],
              cta: { href: payUrl, label: 'Go to the payment page' },
              footer: [att.attachment ? `Proforma ${escapeHtml(ref)} is attached.` : ''],
            }),
            attachments: att.attachment ? [att.attachment] : [],
          }, 'orders:payment-reminder');
          await markSent('ORDER', o.id, 'PAYMENT_DUE_SOON', plan.send, r.ok);
          await audit('order.payment.reminder', o.orderNumber, `${plan.send}d before ${fmtDueDate(due)} · email ${r.ok ? 'ok' : `failed: ${r.error}`}`);
          out.paymentReminders++;
        }
        continue;
      }

      if (phase === 'OVERDUE') {
        if (overdueNotice && (await claim('ORDER', o.id, 'PAYMENT_OVERDUE'))) {
          const cancelOn = cancelAfter(due, grace);
          const r = await trySendEmail({
            to: o.buyer.email,
            subject: `Payment overdue — order ${o.orderNumber}`,
            html: mailLayout({
              heading: 'Your payment is overdue',
              body: [
                `Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,`,
                `Payment of <strong>${escapeHtml(money)}</strong> for order <strong>${o.orderNumber}</strong> was due on <strong>${escapeHtml(fmtDueDate(due))}</strong> (reference <strong>${escapeHtml(ref)}</strong>).`,
                autoCancel && kept === 0
                  ? `Please pay now and upload the receipt. Without a payment or receipt by <strong>${escapeHtml(fmtDueDate(cancelOn))}</strong> the order is canceled automatically and the item goes back on sale.`
                  : 'Please pay now and upload the receipt, or reply to this email if you need more time.',
                'If you already paid, upload the bank receipt so we can match it.',
              ],
              cta: { href: payUrl, label: 'Pay / upload receipt' },
            }),
          }, 'orders:payment-overdue');
          await markSent('ORDER', o.id, 'PAYMENT_OVERDUE', 0, r.ok);
          await notifyAdmins(`Payment overdue — order ${o.orderNumber}`, `${money} was due ${fmtDueDate(due)}.${kept > 0 ? ` Part paid (${formatPrice(kept, o.currency)} received) — never auto-canceled.` : autoCancel ? ` Auto-cancel on ${fmtDueDate(cancelOn)} unless paid.` : ' Auto-cancel is off — follow up.'}`, `/admin/orders/${o.id}`, 'SYSTEM');
          await audit('order.payment.overdue', o.orderNumber, `due ${fmtDueDate(due)} · email ${r.ok ? 'ok' : `failed: ${r.error}`}`);
          out.overdueNotices++;
        }
        continue;
      }

      // CANCEL_DUE
      if (kept > 0) {
        if (await claim('ORDER', o.id, 'PAYMENT_OVERDUE_STAFF')) {
          await notifyAdmins(`Part paid, rest overdue — order ${o.orderNumber}`, `${formatPrice(kept, o.currency)} was received, ${money} is still open (due ${fmtDueDate(due)}). Not canceled automatically: chase the rest, or refund what was received and cancel.`, `/admin/orders/${o.id}`, 'SYSTEM');
        }
        continue;
      }
      if (!autoCancel) {
        if (await claim('ORDER', o.id, 'PAYMENT_OVERDUE_STAFF')) {
          await notifyAdmins(`Unpaid past the grace period — order ${o.orderNumber}`, `${money} was due ${fmtDueDate(due)}. Auto-cancel is off: cancel the order or extend the due date.`, `/admin/orders/${o.id}`, 'SYSTEM');
        }
        continue;
      }
      const reason = `Not paid by the due date (${fmtDueDate(due)}, plus ${grace} day${grace === 1 ? '' : 's'} grace)`;
      if (o.sourcingRequestId) {
        const r = await cancelQuoteOrder(o.id, { kind: 'SYSTEM', id: null, email: null }, {
          reason,
          lostReason: 'Not paid by the due date',
          buyerEmailHtml: ({ orderNumber, voided, total }) => ({
            subject: `Order ${orderNumber} canceled — not paid by ${fmtDueDate(due)}`,
            html: mailLayout({
              heading: `Order ${orderNumber} was canceled`,
              body: [
                `Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,`,
                `We did not receive the payment of <strong>${escapeHtml(total)}</strong> for order <strong>${orderNumber}</strong> (due ${escapeHtml(fmtDueDate(due))}), so the order was canceled and the item went back on sale.`,
                `<strong>No payment is due any more.</strong>${voided.length ? ` Proforma ${voided.map((n) => `<strong>${escapeHtml(n)}</strong>`).join(', ')} is void — please do not transfer money for it.` : ''} If your transfer is already on its way, reply to this email or contact support and we sort it out (refund or a new offer).`,
              ],
              cta: { href: `${siteBase()}/app/orders/${orderNumber}`, label: 'View the order' },
            }),
          }),
        });
        if (r.ok) {
          await claim('ORDER', o.id, 'ORDER_AUTO_CANCELED', 0, r.buyerEmailed ? 'buyer emailed' : `buyer email failed: ${r.buyerEmailError}`);
          await markSent('ORDER', o.id, 'ORDER_AUTO_CANCELED', 0, r.buyerEmailed);
          out.canceled++;
        }
        continue;
      }
      if (now.getTime() - o.createdAt.getTime() < CHECKOUT_FLOOR_MS) continue;
      const res = await cancelAndRestockOrder(prisma, o.id, { requireNoProof: true, expectedStripeSessionId: null });
      if (res !== 'canceled') continue;
      const voided = docs.proforma ? [docs.proforma.number] : [];
      const r = await trySendEmail({
        to: o.buyer.email,
        subject: `Order ${o.orderNumber} canceled — not paid by ${fmtDueDate(due)}`,
        html: mailLayout({
          heading: `Order ${o.orderNumber} was canceled`,
          body: [
            `Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,`,
            `We did not receive the payment of <strong>${escapeHtml(money)}</strong> for order <strong>${o.orderNumber}</strong> (due ${escapeHtml(fmtDueDate(due))}), so the order was canceled and the items went back on sale.`,
            `<strong>No payment is due any more.</strong>${voided.length ? ` Proforma <strong>${escapeHtml(voided[0])}</strong> is void.` : ''} If your transfer is already on its way, contact support and we sort it out.`,
          ],
          cta: { href: `${siteBase()}/app/orders/${o.orderNumber}`, label: 'View the order' },
        }),
      }, 'orders:auto-cancel');
      await claim('ORDER', o.id, 'ORDER_AUTO_CANCELED', 0, r.ok ? 'buyer emailed' : `buyer email failed: ${r.error}`);
      await markSent('ORDER', o.id, 'ORDER_AUTO_CANCELED', 0, r.ok);
      await notifyUser(o.buyer.id, `Order ${o.orderNumber} canceled — not paid`, 'No payment is due any more. The items went back on sale.', `/app/orders/${o.orderNumber}`);
      await notifyAdmins(`Order ${o.orderNumber} canceled — not paid by ${fmtDueDate(due)}`, `${money} · stock released · buyer ${r.ok ? 'emailed' : `email FAILED (${r.error})`}.`, `/admin/orders/${o.id}`, 'ORDER_CANCELED');
      await audit('order.auto-cancel', o.orderNumber, `${reason} · items=${o.items.length} · email ${r.ok ? 'ok' : `failed: ${r.error}`}`);
      out.canceled++;
    } catch (e) {
      out.errors++;
      await logError('due-sweep:order', e);
    }
  }

  // ── 2. open offers: expiry reminders + staff alert ──
  const offerSteps = offerExpiryReminderDays();
  if (offerSteps.length) {
    const soon = new Date(now.getTime() + (Math.max(...offerSteps) + 1) * 86_400_000);
    const offers = await prisma.sourcingRequest.findMany({
      where: { ...(only ? { id: { in: only.quoteIds ?? [] } } : {}), status: 'RESPONDED', quotedPriceCents: { not: null }, archivedAt: null, validUntilAt: { gt: now, lte: soon }, order: { is: null } },
      orderBy: { validUntilAt: 'asc' },
      take: BATCH,
      select: {
        id: true, buyerEmail: true, buyerName: true, submittedById: true, accessToken: true, validUntilAt: true, quotedCurrency: true, quotedPriceCents: true,
        offerSubtotalCents: true, offerShippingCents: true, offerVatTreatment: true, offerVatRateBp: true, offerVatCents: true, offerTotalCents: true,
        productCategory: true, product: { select: { title: true } },
      },
    });
    for (const q of offers) {
      try {
        const until = q.validUntilAt!;
        const sent = (await prisma.reminderLog.findMany({ where: { subjectType: 'QUOTE', subjectId: q.id, kind: 'OFFER_EXPIRING' }, select: { step: true } })).map((r) => r.step);
        const plan = remindersToSend(now, until, offerSteps, sent);
        for (const k of plan.skip) await claim('QUOTE', q.id, 'OFFER_EXPIRING', k, 'skipped');
        if (plan.send == null || !(await claim('QUOTE', q.id, 'OFFER_EXPIRING', plan.send))) continue;
        const a = offerAmounts(q);
        const item = q.product?.title ?? q.productCategory ?? 'the requested equipment';
        const link = q.submittedById || !q.accessToken ? `${siteBase()}/app/quotes/${q.id}` : `${siteBase()}/quotes/t/${q.accessToken}`;
        const r = await trySendEmail({
          to: q.buyerEmail,
          subject: `[${QUOTE_REF(q.id)}] Your offer expires on ${fmtDueDate(until)}`,
          html: mailLayout({
            heading: 'Your offer expires soon',
            body: [
              `Hi <span dir="auto">${escapeHtml(q.buyerName)}</span>,`,
              `Our offer for <strong dir="auto">${escapeHtml(item)}</strong> (${escapeHtml(formatPrice(a.totalCents, q.quotedCurrency || 'EUR'))}${a.vatDecided ? '' : ' excl. VAT'}) is valid until <strong>${escapeHtml(fmtDueDate(until))}</strong>.`,
              'Accept it before then, or tell us in the conversation what would make it work for you.',
            ],
            cta: { href: link, label: 'Review the offer' },
          }),
        }, 'quotes:offer-reminder');
        await markSent('QUOTE', q.id, 'OFFER_EXPIRING', plan.send, r.ok);
        await audit('quote.offer.reminder', QUOTE_REF(q.id), `${plan.send}d before ${fmtDueDate(until)} · email ${r.ok ? 'ok' : `failed: ${r.error}`}`);
        out.offerReminders++;
      } catch (e) {
        out.errors++;
        await logError('due-sweep:offer', e);
      }
    }
  }
  if (offerExpiredStaffAlert()) {
    const expired = await prisma.sourcingRequest.findMany({
      where: { ...(only ? { id: { in: only.quoteIds ?? [] } } : {}), status: 'RESPONDED', quotedPriceCents: { not: null }, archivedAt: null, validUntilAt: { lt: now, gt: new Date(now.getTime() - 30 * 86_400_000) }, order: { is: null } },
      orderBy: { validUntilAt: 'asc' },
      take: BATCH,
      select: { id: true, validUntilAt: true, assignedToId: true, assignedTo: { select: { email: true, role: true } }, productCategory: true, product: { select: { title: true } } },
    });
    for (const q of expired) {
      if (!(await claim('QUOTE', q.id, 'OFFER_EXPIRED_STAFF'))) continue;
      const item = q.product?.title ?? q.productCategory ?? 'sourcing request';
      const body = `${item}: the offer expired on ${fmtDueDate(q.validUntilAt!)} without an answer. Follow up with the buyer or send a new offer.`;
      if (q.assignedToId) await notifyUser(q.assignedToId, `Offer expired — ${QUOTE_REF(q.id)}`, body, q.assignedTo?.role === 'SELLER' ? `/app/seller/inbox/${q.id}` : `/admin/quotes/${q.id}`);
      await notifyAdmins(`Offer expired — ${QUOTE_REF(q.id)}`, body, `/admin/quotes/${q.id}`, 'SYSTEM');
      if (q.assignedTo?.role === 'SELLER' && isDeliverableEmail(q.assignedTo.email)) {
        await sendInternalEmail({ to: q.assignedTo.email, subject: `[${QUOTE_REF(q.id)}] The offer expired`, html: mailLayout({ heading: 'The offer expired', body: [escapeHtml(body)], cta: { href: `${siteBase()}/app/seller/inbox/${q.id}`, label: 'Open the request' } }) }, 'quotes:offer-expired');
      }
      out.offerExpiredAlerts++;
    }
  }

  // ── 3. stock holds of open offers past their expiry ──
  if (!only) out.holdsReleased = await releaseExpiredReservations(now).catch(async (e) => { await logError('due-sweep:holds', e); return 0; });
  return out;
}
