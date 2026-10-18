import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { escapeHtml } from '@/lib/email-html';
import { audit, logError, notifyAdmins, notifyUser } from '@/lib/observability';
import { fmtDocMoney } from '@/lib/documents/render';
import { ensureLegacyDocuments } from '@/lib/documents/issue';
import { cancelOrderSaga } from '@/lib/orders/stripe-handoff';
import { orderReservedStock } from '@/lib/orders/checkout-tx';
import { expireOnlyApi } from '@/lib/stripe/session-api';
import { getStripe } from '@/lib/stripe/client';
import { cancelQuoteOrder, cancelSummary, type CancelActor } from '@/lib/quotes/cancel';
import { quoteOrderTookStock } from '@/lib/quotes/stock';
import { isoDay } from '@/lib/quotes/offer';
import { restockOnPaidCancel } from './policy';
import {
  creditAndRefundTx,
  creditSummary,
  emailCreditOutcome,
  heldMoneyCents,
  LIVE_REFUNDS_SELECT,
  loadMoney,
  refundDocContext,
  Refused,
  stripeRefund,
  type CreditOutcome,
  type RefundMethod,
} from '@/lib/finance/refunds';
import { refundCapacity, withoutFinalStop } from './rules';
import { isValidIban } from '@/lib/settings/defs';
import { siteName } from '@/lib/brand/identity';
import { notifySupplierOfSale } from '@/lib/sellers/sale-notice';
import { contactUsHtml, mailOutcomeText, orderUrl, sendBuyerMail } from './mail';

/**
 * Cancellation at every legitimate stage (owner report 6):
 *  - unpaid (checkout or quote order) → cancelUnpaidOrder: proforma void, unit
 *    released, any card session expired first, buyer emailed with the reason;
 *  - paid / approved on terms, nothing shipped → cancelPaidOrder: the invoice
 *    is credited (credit note), money refunded through the ledger (bank transfer
 *    REQUESTED until sent, or a card refund), an unpaid NET invoice is only
 *    cancelled (no money refund; part paid → only that part is refunded), stock
 *    back per setting, buyer emailed — all through THE refund / credit core
 *    (lib/finance/refunds.ts);
 *  - money received on an unpaid order (a part payment) → no cancel until that
 *    money is refunded (Refund / credit on the order page): canceling would
 *    keep it silently;
 *  - anything shipped → not a cancellation: a return (RMA).
 * Server-internal: callers check who may do this.
 */

export type Result = { ok: true; message: string } | { ok: false; message: string };

function stripeApi() {
  const stripe = getStripe();
  return stripe ? expireOnlyApi(stripe) : null;
}

export async function cancelUnpaidOrder(orderId: string, actor: CancelActor, opts: { reason: string; note?: string | null }): Promise<Result> {
  await ensureSettingsLoaded();
  const reason = opts.reason.trim().slice(0, 300);
  const note = (opts.note ?? '').trim().slice(0, 500) || null;
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, status: true, sourcingRequestId: true, paymentSubmittedAt: true, totalCents: true, currency: true, adminNotes: true, amountPaidCents: true, refunds: LIVE_REFUNDS_SELECT, buyer: { select: { id: true, name: true, email: true } }, items: { select: { titleSnapshot: true }, take: 1 } },
  });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.status === 'CANCELED') return { ok: false, message: `Order ${o.orderNumber} is already canceled.` };
  if (o.status !== 'PENDING_PAYMENT') return { ok: false, message: actor.kind === 'BUYER' ? `Order ${o.orderNumber} is already paid — contact us to cancel it; we refund the payment.` : `Order ${o.orderNumber} is paid — use “Cancel & refund” (a credit note and the refund are recorded).` };
  if (o.paymentSubmittedAt) {
    return { ok: false, message: actor.kind === 'BUYER'
      ? `You already sent a payment receipt for order ${o.orderNumber}. Contact support to cancel it — we check the payment first.`
      : `A payment receipt for order ${o.orderNumber} is waiting for verification — verify or reject it first.` };
  }
  // Money already received (a part payment) and not refunded: canceling would keep it silently.
  const kept = heldMoneyCents(o.amountPaidCents, o.refunds);
  if (kept > 0) {
    const got = fmtDocMoney(kept, o.currency);
    return { ok: false, message: actor.kind === 'BUYER'
      ? `We already received ${got} for order ${o.orderNumber}, so it can not be canceled online. Contact support — we cancel it and refund what you paid.`
      : `${got} was already received for order ${o.orderNumber} (part payment). Refund it first (Refund / credit on the order page), then cancel.` };
  }
  if (o.sourcingRequestId) {
    const r = await cancelQuoteOrder(o.id, actor, { reason, note, lostReason: actor.kind === 'BUYER' ? `Canceled by the buyer: ${reason}` : 'Canceled by lab2date after acceptance' });
    return r.ok ? { ok: true, message: cancelSummary(r, actor.kind === 'BUYER' ? 'BUYER' : 'STAFF') } : { ok: false, message: r.message };
  }
  const outcome = await cancelOrderSaga(prisma, stripeApi(), o.id, { requireNoProof: true });
  if (outcome === 'expire-failed') return { ok: false, message: 'The open card-payment session could not be closed, so the order was left as it is — try again in a minute.' };
  if (outcome !== 'canceled') return { ok: false, message: `Order ${o.orderNumber} changed meanwhile (paid, receipt sent or already canceled) — reload and check.` };
  const who = actor.kind === 'BUYER' ? 'the buyer' : actor.kind === 'SYSTEM' ? 'the system' : actor.email ?? 'staff';
  await prisma.order.update({ where: { id: o.id }, data: { adminNotes: `${o.adminNotes ? `${o.adminNotes}\n` : ''}[${isoDay(new Date())}] Canceled by ${who}: ${reason}${note ? ` — ${note}` : ''}.`.slice(0, 4000) } }).catch(() => {});
  const total = fmtDocMoney(o.totalCents, o.currency);
  // The DB trigger voided its proforma(s): name them — nobody should pay them.
  const voided = await prisma.fiscalDocument.findMany({ where: { orderId: o.id, kind: 'PROFORMA', voidedAt: { not: null }, supersededById: null }, select: { number: true } });
  const pfNames = voided.map((d) => d.number).join(', ');
  const mail = await sendBuyerMail({
    to: o.buyer.email,
    subject: `Order ${o.orderNumber} canceled — no payment due`,
    heading: `Order ${o.orderNumber} is canceled`,
    html: [
      `<p style="margin:0 0 12px;">Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,</p>`,
      `<p style="margin:0 0 12px;">${actor.kind === 'BUYER' ? 'As you asked, we canceled' : 'We canceled'} order <strong>${escapeHtml(o.orderNumber)}</strong> (<span dir="auto">${escapeHtml(o.items[0]?.titleSnapshot ?? '')}</span>, ${escapeHtml(total)}).</p>`,
      `<p style="margin:0 0 12px;">Reason: <span dir="auto">${escapeHtml(note && actor.kind !== 'SYSTEM' ? reason : withoutFinalStop(reason))}</span>${note && actor.kind !== 'SYSTEM' ? ` — <span dir="auto">${escapeHtml(withoutFinalStop(note))}</span>` : ''}.</p>`,
      `<p style="margin:0 0 12px;"><strong>No payment is due</strong> and nothing was charged. ${pfNames ? `Proforma <strong>${escapeHtml(pfNames)}</strong> is void` : 'The proforma for this order is void'} — please do not transfer money for it. If you already sent a transfer, ${contactUsHtml()} and we refund it.</p>`,
    ],
    cta: { href: orderUrl(o.orderNumber), label: 'View the order' },
    context: 'orders:cancel-unpaid',
  });
  await notifyUser(o.buyer.id, `Order ${o.orderNumber} canceled`, `No payment is due.${pfNames ? ` Proforma ${pfNames} is void — please do not transfer money for it.` : ''}`, `/app/orders/${o.orderNumber}`);
  await notifyAdmins(`Order ${o.orderNumber} canceled by ${actor.kind === 'BUYER' ? 'the buyer' : 'staff'} (unpaid)`, `${total} · ${reason}${orderReservedStock(o) ? ' · stock released' : ''}`, `/admin/orders/${o.id}`, 'ORDER_CANCELED');
  await audit('order.cancel', o.orderNumber, `unpaid · by ${who} · ${reason}${note ? ` · "${note.slice(0, 120)}"` : ''} · email ${mail.ok ? 'ok' : mail.error}`);
  if (actor.kind === 'BUYER') {
    return { ok: true, message: `Order ${o.orderNumber} is canceled — nothing is due. ${mail.ok ? 'We emailed you a confirmation.' : 'We could not email you a confirmation right now — this page is your confirmation.'}` };
  }
  return { ok: true, message: `Order ${o.orderNumber} canceled; the proforma is void and the reserved stock released. ${mailOutcomeText(mail)}` };
}

/**
 * Cancel an order that is paid (or approved on invoice terms) and NOT shipped:
 * credit the invoice in full, refund the money through the ledger, restock per
 * Settings → Stock & reservation, close the quote, email the buyer.
 */
export async function cancelPaidOrder(
  p: { orderId: string; reason: string; note?: string | null; method: RefundMethod | null; payeeIban?: string | null },
  actor: { id: string | null; email: string | null },
): Promise<Result> {
  await ensureSettingsLoaded();
  const reason = p.reason.trim().slice(0, 300);
  if (reason.length < 3) return { ok: false, message: 'Choose or write the reason — it goes to the buyer and on the credit note.' };
  // Older invoices are frozen as issued first: the cancellation credits the invoice of record.
  await ensureLegacyDocuments(p.orderId);
  const m = await loadMoney(prisma, p.orderId);
  if (!m) return { ok: false, message: 'Order not found.' };
  const o = m.order;
  if (!['PAID', 'PROCESSING'].includes(o.status)) {
    return { ok: false, message: o.status === 'PENDING_PAYMENT' ? `Order ${o.orderNumber} is not paid — use “Cancel order”.` : o.status === 'SHIPPED' || o.status === 'DELIVERED' ? `Order ${o.orderNumber} has shipped — it can not be canceled any more: open a return (RMA) instead.` : `Order ${o.orderNumber} is ${o.status.toLowerCase()}.` };
  }
  const shipped = await prisma.shipment.count({ where: { orderId: o.id } });
  if (shipped) return { ok: false, message: `Part of order ${o.orderNumber} has already shipped — cancel is not possible; open a return (RMA) for the shipped items and refund the rest.` };
  const cap = refundCapacity(m.state);
  const moneyToReturn = cap.moneyCents;
  if (moneyToReturn > 0 && !p.method) return { ok: false, message: 'Choose how the money is refunded (bank transfer or the original card).' };
  if (p.method === 'STRIPE' && !o.stripePaymentIntentId) return { ok: false, message: 'This order was not paid by card — refund by bank transfer.' };
  const iban = (p.payeeIban ?? '').replace(/\s+/g, '').toUpperCase() || null;
  if (iban && !isValidIban(iban)) return { ok: false, message: 'The buyer’s IBAN is not valid — check it (or leave it empty and add it when you send the transfer).' };
  const tookStock = orderReservedStock(o) || (!!o.sourcingRequestId && (await quoteOrderTookStock(o.id)));
  // The unit(s) go back to stock at most once per order (an earlier full refund may have done it).
  const alreadyRestocked = (await prisma.refund.count({ where: { orderId: o.id, restock: true } })) > 0;
  const restock = tookStock && !alreadyRestocked && restockOnPaidCancel();
  let stripeId: string | null = null;
  if (p.method === 'STRIPE' && moneyToReturn > 0) {
    const s = await stripeRefund(o.id, o.stripePaymentIntentId as string, moneyToReturn, `cancel-${moneyToReturn}`);
    if (!s.ok) return { ok: false, message: s.message };
    stripeId = s.id;
  }
  const docCtx = await refundDocContext();
  let out: CreditOutcome;
  try {
    out = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${o.id} FOR UPDATE`;
      if (await tx.shipment.count({ where: { orderId: o.id } })) throw new Refused('Something was shipped meanwhile — reload; use a return (RMA).');
      const flip = await tx.order.updateMany({
        where: { id: o.id, status: { in: ['PAID', 'PROCESSING'] } },
        data: { status: 'CANCELED' },
      });
      if (flip.count !== 1) throw new Refused('The order changed meanwhile — reload and check.');
      const fresh = await loadMoney(tx, o.id);
      const amount = fresh ? refundCapacity(fresh.state).maxCents : 0;
      // Stock goes back with the credit (the refund row records it: at most once per order).
      const credit: CreditOutcome = amount > 0
        ? await creditAndRefundTx(tx, { orderId: o.id, amountCents: amount, reason: `Order canceled: ${reason}`, method: p.method, stripeRefundId: stripeId, expectedRefundCents: stripeId ? moneyToReturn : undefined, payeeIban: iban, restock, actor, ctx: docCtx })
        : { creditNote: null, creditNoteNote: 'Nothing left to credit or refund.', refund: null, creditCents: 0, receivableCents: 0, refundCents: 0, restocked: false };
      if (restock && !credit.restocked) {
        const items = await tx.orderItem.findMany({ where: { orderId: o.id }, select: { productId: true, quantity: true } });
        for (const it of items) if (it.productId) await tx.product.updateMany({ where: { id: it.productId }, data: { quantity: { increment: it.quantity } } });
      }
      const cur = await tx.order.findUnique({ where: { id: o.id }, select: { adminNotes: true } });
      await tx.order.update({ where: { id: o.id }, data: { adminNotes: `${cur?.adminNotes ? `${cur.adminNotes}\n` : ''}[${isoDay(new Date())}] Canceled${m.state.paidCents > 0 ? ' after payment' : ' (invoice terms, unpaid part credited)'} by ${actor.email ?? 'staff'}: ${reason}${p.note ? ` — ${p.note}` : ''}.`.slice(0, 4000) } });
      if (o.sourcingRequestId) {
        await tx.sourcingRequest.updateMany({ where: { id: o.sourcingRequestId, status: { in: ['ACCEPTED', 'RESPONDED'] } }, data: { status: 'CLOSED', lostReason: credit.refund ? 'Canceled by lab2date after payment' : 'Canceled by lab2date after acceptance', lostNote: reason, dueAt: null } });
        await tx.quoteMessage.create({ data: { sourcingRequestId: o.sourcingRequestId, authorId: actor.id, fromStaff: true, body: `Order ${o.orderNumber} was canceled by ${siteName()}${credit.refund ? ' after payment' : ''}: ${withoutFinalStop(reason)}. ${credit.creditNote ? `The invoice is credited in full (credit note ${credit.creditNote.number}). ` : ''}${credit.refund ? `A refund of ${fmtDocMoney(credit.refund.amountCents, o.currency)} is ${credit.refund.method === 'STRIPE' ? 'issued to the card' : 'recorded and will be sent by bank transfer'}${credit.receivableCents > 0 ? '; the rest is no longer due' : ''}.` : 'Nothing is due.'}` } });
      }
      return credit;
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, message: stripeId ? `The card refund WAS issued (${stripeId}) but the cancellation could not be recorded: ${e.message} Do not refund again.` : e.message };
    await logError('fulfilment:cancel-paid', e);
    return { ok: false, message: stripeId ? `The card refund WAS issued (${stripeId}) but recording the cancellation failed — do not refund again; contact a developer.` : `Nothing was changed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}` };
  }
  const mail = await emailCreditOutcome(o, out, { kind: 'CANCEL', reason });
  // The supplier who was told the unit sold must not prepare / ship it any more.
  await notifySupplierOfSale(o.id, 'CANCELED').catch((e) => logError('fulfilment:cancel-supplier-notice', e));
  await notifyUser(o.buyer.id, `Order ${o.orderNumber} canceled`, out.refund ? (out.refund.method === 'STRIPE' ? 'Your payment is refunded to your card.' : 'A refund is approved — the bank transfer is not sent yet; we email you when it is.') : 'Nothing is due.', `/app/orders/${o.orderNumber}`);
  await notifyAdmins(`Order ${o.orderNumber} canceled${out.refund ? ' after payment' : ' — invoice credited, nothing refunded'}`, `${creditSummary(out, o.currency)}${restock ? (out.restocked ? '' : ' Stock returned.') : tookStock ? (alreadyRestocked ? ' Stock was returned earlier.' : ' Stock NOT returned (Settings).') : ''}`.slice(0, 480), `/admin/orders/${o.id}`, 'ORDER_CANCELED');
  await audit('order.cancel.paid', o.orderNumber, `by ${actor.email ?? 'staff'} · ${reason} · cn=${out.creditNote?.number ?? 'none'} · receivable ${out.receivableCents} · refund ${out.refundCents} ${p.method ?? ''}${stripeId ? ` ${stripeId}` : ''} · restock=${restock}`);
  const stock = restock ? (out.restocked ? '' : ' The unit(s) are back in stock.') : tookStock ? (alreadyRestocked ? ' Stock was already returned earlier — not returned twice.' : ' Stock was NOT put back (Settings → Stock & reservation) — do it by hand after checking the unit.') : '';
  return { ok: true, message: `Order ${o.orderNumber} canceled. ${creditSummary(out, o.currency)}${stock} ${mailOutcomeText(mail)}` };
}
