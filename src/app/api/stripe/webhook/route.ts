import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getStripe } from '@/lib/stripe/client';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sendOrderInvoice } from '@/lib/orders/internal';
import { cancelOrderSaga } from '@/lib/orders/stripe-handoff';
import { confirmedExpiredApi } from '@/lib/stripe/session-api';
import { notifyAdmins, notifyUser, logError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  await ensureSettingsLoaded();
  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: 'stripe not configured' }, { status: 500 });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'webhook secret missing' }, { status: 500 });

  const body = await req.text();
  const sig = (await headers()).get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'no signature' }, { status: 400 });

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err) {
    return NextResponse.json({ error: `bad signature: ${(err as Error).message}` }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    if (orderId) {
      // BUG-002 fix: webhook idempotency. Stripe redelivers events on
      // network blips / 5xx — without this guard the buyer gets multiple
      // invoice emails, notifyAdmins fires multiple times, and `paidAt`
      // drifts forward on every replay. Worst case: a REFUNDED order
      // would silently revert to PAID. We pre-check current status and
      // only proceed if it's still PENDING_PAYMENT.
      const current = await prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true, orderNumber: true },
      });
      if (!current) {
        // Unknown order — stale metadata. Acknowledge so Stripe stops retrying.
        return NextResponse.json({ received: true, skipped: 'unknown_order' });
      }
      if (current.status !== 'PENDING_PAYMENT') {
        // A payment COMPLETED for an order that already left PENDING_PAYMENT. If it
        // is a genuine replay of a PAID order, ack. But if the order is TERMINAL
        // (CANCELED/REFUNDED), Stripe may have captured money on a session we
        // canceled/restocked — never silently discard captured money.
        if (current.status === 'CANCELED' || current.status === 'REFUNDED') {
          await handleLatePaymentAnomaly(stripe, orderId, current.orderNumber, session, event.id);
        }
        return NextResponse.json({ received: true, skipped: 'already_processed' });
      }
      // Card-only Checkout is synchronous (see the create call), so `completed`
      // implies captured funds; require payment_status='paid' as defense-in-depth
      // against an unpaid/async completed ever marking the order PAID.
      if (session.payment_status !== 'paid') {
        return NextResponse.json({ received: true, skipped: 'not_paid' });
      }

      let shippingAddress: unknown = undefined;
      let billingAddress: unknown = undefined;
      let paymentMethodBrand: string | null = null;
      let paymentMethodLast4: string | null = null;
      let paymentMethodWallet: string | null = null;
      let buyerCountryFromBilling: string | null = null;
      const paymentIntentId =
        typeof session.payment_intent === 'string' ? session.payment_intent : null;

      try {
        const full = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ['customer_details'],
        });
        const ship =
          (full as { shipping_details?: unknown }).shipping_details ??
          (full.customer_details
            ? { name: full.customer_details.name, address: full.customer_details.address }
            : null);
        if (ship) {
          shippingAddress = {
            ...(ship as object),
            phone: full.customer_details?.phone ?? null,
            email: full.customer_details?.email ?? null,
          };
        }
      } catch {
        /* address optional — never block payment capture */
      }

      // Pull payment-method + billing from the underlying charge (audit trail).
      if (paymentIntentId) {
        try {
          const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ['latest_charge.payment_method_details', 'latest_charge.billing_details'],
          });
          const charge = pi.latest_charge as
            | { payment_method_details?: { card?: { brand?: string; last4?: string; wallet?: { type?: string } } ; type?: string }; billing_details?: { name?: string; email?: string; phone?: string; address?: { line1?: string; line2?: string; city?: string; state?: string; postal_code?: string; country?: string } } }
            | string | null;
          if (charge && typeof charge !== 'string') {
            const card = charge.payment_method_details?.card;
            paymentMethodBrand = card?.brand ?? charge.payment_method_details?.type ?? null;
            paymentMethodLast4 = card?.last4 ?? null;
            paymentMethodWallet = card?.wallet?.type ?? null;
            if (charge.billing_details) {
              billingAddress = {
                name: charge.billing_details.name ?? null,
                email: charge.billing_details.email ?? null,
                phone: charge.billing_details.phone ?? null,
                address: charge.billing_details.address ?? null,
              };
              buyerCountryFromBilling = charge.billing_details.address?.country ?? null;
            }
          }
        } catch {
          /* enrichment is best-effort */
        }
      }

      // Atomic conditional update — flips PENDING_PAYMENT → PAID once, CAS'd on
      // THIS session id so a stale/foreign completed event can't mark an order
      // that is attached to a different session PAID. Concurrent deliveries are
      // serialised by the row lock; only one update wins (count===1).
      const updateRes = await prisma.order.updateMany({
        where: { id: orderId, status: 'PENDING_PAYMENT', stripeSessionId: session.id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          stripePaymentIntentId: paymentIntentId,
          ...(shippingAddress ? { shippingAddress: shippingAddress as object } : {}),
          ...(billingAddress ? { billingAddress: billingAddress as object } : {}),
          ...(paymentMethodBrand ? { paymentMethodBrand } : {}),
          ...(paymentMethodLast4 ? { paymentMethodLast4 } : {}),
          ...(paymentMethodWallet ? { paymentMethodWallet } : {}),
          // Prefer billing country if we hadn't picked one up at checkout start.
          ...(buyerCountryFromBilling ? { buyerCountry: buyerCountryFromBilling } : {}),
        },
      });
      if (updateRes.count !== 1) {
        // Did NOT flip PENDING(this session)→PAID. Re-read: an admin cancel that
        // won before our update (terminal), or an order now attached to a DIFFERENT
        // session, means captured funds against a non-matching order — route to the
        // exactly-once anomaly path instead of silently discarding the payment.
        const after = await prisma.order.findUnique({
          where: { id: orderId },
          select: { status: true, orderNumber: true, stripeSessionId: true },
        });
        if (
          after &&
          (after.status === 'CANCELED' ||
            after.status === 'REFUNDED' ||
            (after.status === 'PENDING_PAYMENT' && after.stripeSessionId !== session.id))
        ) {
          await handleLatePaymentAnomaly(stripe, orderId, after.orderNumber, session, event.id);
        }
        return NextResponse.json({ received: true, skipped: 'race_lost' });
      }
      const paid = await prisma.order.findUnique({
        where: { id: orderId },
        select: { orderNumber: true, totalCents: true, buyerId: true, id: true, currency: true },
      });
      if (!paid) {
        return NextResponse.json({ received: true });
      }
      // BUG-003 fix: format with the order's actual currency, not a
      // hardcoded euro symbol.
      const fmtTotal = (() => {
        try {
          return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: (paid.currency || 'EUR').toUpperCase(),
            maximumFractionDigits: 2,
          }).format(paid.totalCents / 100);
        } catch {
          return `${(paid.currency || 'EUR').toUpperCase()} ${(paid.totalCents / 100).toFixed(2)}`;
        }
      })();
      await notifyAdmins(
        `Order ${paid.orderNumber} PAID — ${fmtTotal}`,
        'Payment confirmed. Arrange fulfilment and shipping.',
        `/admin/orders/${paid.id}`,
        'ORDER_PAID',
      );
      // If Stripe didn't return a shipping address for a PAID order, the
      // warehouse can't dispatch — surface that immediately.
      if (!shippingAddress) {
        await notifyAdmins(
          `Order ${paid.orderNumber}: PAID but no shipping address`,
          'Stripe did not return a shipping_details object — confirm with buyer before fulfilment.',
          `/admin/orders/${paid.id}`,
          'SHIPPING_MISSING',
        );
      }
      await notifyUser(
        paid.buyerId,
        `Payment received — order ${paid.orderNumber}`,
        'Thanks! Your payment is confirmed. We are preparing your order.',
        `/app/orders/${paid.orderNumber}`,
      );
      await sendOrderInvoice(orderId);
    }
  } else if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    if (orderId) {
      // Cancel + restock atomically through the Stripe-aware saga, passing THIS
      // event's session id as onlyIfSessionIs: an old expired event cannot cancel
      // an order that has since moved to a different/new session. The saga expires
      // the session (idempotent) then CAS-claims PENDING_PAYMENT + restocks in one
      // tx; a restock failure rolls back to PENDING_PAYMENT and we 500 for retry.
      try {
        // The signed `expired` event authoritatively confirms THIS session is
        // expired, so the adapter treats it as an already-confirmed no-op (any other
        // session id falls back to the retrieve-confirmed safeExpire).
        const out = await cancelOrderSaga(prisma, confirmedExpiredApi(stripe, session.id), orderId, { onlyIfSessionIs: session.id });
        if (out === 'expire-failed') {
          await logError('stripe.webhook.expired', new Error(`could not confirm expire of session ${session.id} for order ${orderId}`));
          return NextResponse.json({ error: 'expire failed, will retry' }, { status: 500 });
        }
      } catch (e) {
        await logError('stripe.webhook.expired', e);
        return NextResponse.json({ error: 'restock failed, will retry' }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ received: true });
}

/**
 * Late payment on a TERMINAL / non-matching order. EXACTLY-ONCE via the durable
 * WebhookEvent ledger (keyed on the Stripe event.id): the first processor claims
 * the row; a concurrent/replayed delivery collides on the PK and returns. On a
 * FAILED attempt the claim is deleted so a later Stripe redelivery retries. A
 * REFUNDED order whose PI already equals this session's PI is a normal refund
 * REPLAY (not a late capture) — recorded, no second refund, no CRITICAL. Never restocks.
 */
async function handleLatePaymentAnomaly(
  stripe: NonNullable<ReturnType<typeof getStripe>>,
  orderId: string,
  orderNumber: string,
  session: { id: string; payment_intent?: unknown },
  eventId: string,
): Promise<void> {
  // Claim the event (single winner). Replays / concurrent deliveries skip.
  try {
    await prisma.webhookEvent.create({ data: { id: eventId, type: 'checkout.session.completed', orderId } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return; // already claimed
    throw e;
  }
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : null;
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, stripePaymentIntentId: true },
    });
    // Normal refund replay: order already REFUNDED for THIS same PI → not a late
    // capture; record and stop (no second refund, no CRITICAL).
    if (order?.status === 'REFUNDED' && pi && order.stripePaymentIntentId === pi) {
      await prisma.webhookEvent.update({ where: { id: eventId }, data: { outcome: 'refund-replay', detail: `PI ${pi}` } });
      return;
    }
    if (!pi) throw new Error('completed session had no payment_intent to refund');
    await stripe.refunds.create(
      { payment_intent: pi },
      { idempotencyKey: `late-refund-${orderId}-${pi}` }, // Stripe-side double-refund guard
    );
    await prisma.webhookEvent.update({ where: { id: eventId }, data: { outcome: 'late-refunded', detail: `PI ${pi}` } });
    await logError('stripe.webhook.late-payment.autorefunded', new Error(`refunded PI ${pi} for terminal order ${orderNumber}`));
    await notifyAdmins(
      `Late payment auto-refunded · ${orderNumber}`,
      `Captured payment on a terminal/non-matching order; an idempotent refund was issued (PI ${pi}, session ${session.id}). Please verify.`,
      `/admin/orders/${orderId}`,
      'SYSTEM',
    );
  } catch (e) {
    // Attempt failed — DELETE the claim so a later Stripe redelivery can retry,
    // then alert. (A permanent-failure ledger row would strand the money silently.)
    await prisma.webhookEvent.delete({ where: { id: eventId } }).catch(() => null);
    await logError('stripe.webhook.late-payment.CRITICAL', e);
    await notifyAdmins(
      `CRITICAL: captured payment on terminal order · ${orderNumber}`,
      `Completed payment (session ${session.id}, PI ${pi ?? 'unknown'}) for a terminal/non-matching order and the auto-refund FAILED — manual intervention required; do not restock. Will retry on redelivery.`,
      `/admin/orders/${orderId}`,
      'SYSTEM',
    );
  }
}
