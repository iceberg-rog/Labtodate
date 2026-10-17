import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { getStripe } from '@/lib/stripe/client';
import { safeExpire } from '@/lib/stripe/session-api';
import { logError } from '@/lib/observability';
import { vatTreatmentLabel } from '@/lib/tax/determine';
import { stripeLineItems } from './engine';
import { availablePaymentMethods } from './server';
import { hasPrePaymentHold } from './holds';
import { orderDetailsProblems } from '@/lib/orders/details';
import { duePhase, effectiveDueDate } from '@/lib/orders/payment-due';
import { autoCancelUnpaid, paymentGraceDays, paymentTermDays, requireDetailsBeforePayment, vatIdRule } from '@/lib/quotes/policy';

/**
 * Card payment for an order that already exists and is payable (e.g. after
 * staff released its holds, or a buyer who prefers card over the transfer).
 * The Stripe session is marked `kind: existing`: when it expires unpaid, only
 * the session is dropped — the order stays open for payment (the checkout's
 * own card sessions still cancel + restock an abandoned checkout).
 */
export type CardFailCode = 'unavailable' | 'notfound' | 'notpayable' | 'held' | 'review' | 'submitted' | 'completed' | 'failed' | 'changed' | 'details' | 'terms' | 'expired';
export type CardStart = { ok: true; url: string } | { ok: false; code: CardFailCode; message: string };
export const CARD_FAIL_MESSAGE: Record<CardFailCode, string> = {
  unavailable: 'Card payment is not available at the moment — please pay by bank transfer.',
  notfound: 'Order not found.',
  notpayable: 'This order is not waiting for a payment.',
  held: 'This order is not payable yet — our team confirms the final total first.',
  review: 'A payment for this order is being checked — please do not pay again.',
  submitted: 'You already sent a bank-transfer receipt for this order; we are verifying it.',
  completed: 'This card payment was completed — the confirmation is on its way.',
  failed: 'The card payment page could not be opened right now. Nothing was charged — please try again in a minute or pay by bank transfer.',
  changed: 'The order changed meanwhile — reload the page. Nothing was charged.',
  details: 'Add your billing and delivery details first — we need them for the invoice and the delivery. Nothing was charged.',
  terms: 'You asked to pay this order on invoice — our team is reviewing that request. Nothing was charged.',
  expired: 'The payment deadline of this order has passed, so it can no longer be paid. Nothing was charged — contact us.',
};
const fail = (code: CardFailCode): CardStart => ({ ok: false, code, message: CARD_FAIL_MESSAGE[code] });

export async function startCardPaymentForOrder(orderId: string, buyerEmail: string): Promise<CardStart> {
  await ensureSettingsLoaded();
  if (!availablePaymentMethods().includes('STRIPE_CARD')) return fail('unavailable');
  const stripe = getStripe();
  if (!stripe) return fail('unavailable');
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true, sourcingRequest: { select: { status: true, validUntilAt: true } } } });
  if (!o) return fail('notfound');
  if (o.status !== 'PENDING_PAYMENT') return fail('notpayable');
  if (o.sourcingRequest && ['RESPONDED', 'DECLINED', 'CLOSED'].includes(o.sourcingRequest.status)) return fail('notpayable');
  if (hasPrePaymentHold(o)) return fail('held');
  if (o.holdReason === 'PAYMENT_REVIEW') return fail('review');
  if (o.paymentSubmittedAt) return fail('submitted');
  if (o.paymentVerificationStatus === 'TERMS_REQUESTED') return fail('terms');
  const due = effectiveDueDate({ dueAt: o.dueAt, createdAt: o.createdAt, payableSince: o.payableSince, legacyValidUntil: o.sourcingRequest?.validUntilAt ?? null }, paymentTermDays());
  if (autoCancelUnpaid() && duePhase(new Date(), due, paymentGraceDays()) === 'CANCEL_DUE') return fail('expired');
  if (requireDetailsBeforePayment() && orderDetailsProblems(o, { vatIdRule: vatIdRule() }).length) return fail('details');

  // Re-use an open session instead of creating a second one.
  if (o.stripeSessionId) {
    try {
      const s = await stripe.checkout.sessions.retrieve(o.stripeSessionId);
      if (s.status === 'open' && s.url && s.amount_total === o.totalCents) return { ok: true, url: s.url };
      if (s.status === 'complete') return fail('completed');
      if (s.status === 'open') await safeExpire(stripe, s.id); // stale amount: never pay an old total
    } catch (e) {
      await logError('checkout.card.retrieve', e);
      return fail('failed');
    }
  }
  const base = (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
  const lines = stripeLineItems({
    currency: o.currency,
    items: o.items.map((i) => ({ title: i.titleSnapshot, qty: i.quantity, unitCents: i.priceCentsSnapshot })),
    shippingCents: o.shippingCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    vatLabel: o.vatRateBp != null ? `VAT ${(o.vatRateBp / 100).toString()}% (${vatTreatmentLabel(o.vatTreatment)})` : 'VAT',
    orderNumber: o.orderNumber,
  });
  let session: { id: string; url: string | null };
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: buyerEmail,
      line_items: lines.map((l) => ({ price_data: { currency: o.currency.toLowerCase(), unit_amount: l.unitAmount, product_data: { name: l.name } }, quantity: l.quantity })),
      metadata: { orderId: o.id, orderNumber: o.orderNumber, totalCents: String(o.totalCents), currency: o.currency, kind: 'existing' },
      success_url: `${base}/checkout/success?order=${o.orderNumber}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/app/orders/${o.orderNumber}/payment?card=canceled`,
    });
  } catch (e) {
    await logError('checkout.card.create', e);
    return fail('failed');
  }
  // Attach only while the order is still payable and has no other live session.
  const claim = await prisma.order.updateMany({
    where: { id: o.id, status: 'PENDING_PAYMENT', paymentSubmittedAt: null, OR: [{ stripeSessionId: null }, { stripeSessionId: o.stripeSessionId }] },
    data: { stripeSessionId: session.id },
  });
  if (claim.count !== 1 || !session.url) {
    await safeExpire(stripe, session.id).catch((e) => logError('checkout.card.expire', e));
    return fail('changed');
  }
  return { ok: true, url: session.url };
}

/** Webhook: an `existing`-order card session expired unpaid → drop only the session. */
export async function releaseExpiredCardSession(orderId: string, sessionId: string): Promise<void> {
  await prisma.order.updateMany({ where: { id: orderId, status: 'PENDING_PAYMENT', stripeSessionId: sessionId }, data: { stripeSessionId: null } });
}
