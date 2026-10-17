import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getStripe } from '@/lib/stripe/client';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sendOrderInvoice } from '@/lib/orders/internal';
import { recordPayment } from '@/lib/payments/ledger';
import { cancelOrderSaga } from '@/lib/orders/stripe-handoff';
import { confirmStripeRefunds } from '@/lib/finance/refunds';
import { confirmedExpiredApi } from '@/lib/stripe/session-api';
import { notifyAdmins, notifyUser, logError, audit } from '@/lib/observability';
import { primaryHold, stripeAmountMatches } from '@/lib/checkout/engine';
import { releaseExpiredCardSession } from '@/lib/checkout/card';
import { sellQuoteUnit } from '@/lib/quotes/stock';

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

      // A24: the money Stripe captured must be exactly the order total, in the
      // order's currency. Anything else is NOT a payment of this order: it is
      // recorded as received, the order is held for staff (PAYMENT_REVIEW) and
      // never marked paid / invoiced automatically.
      const expected = await prisma.order.findUnique({
        where: { id: orderId },
        select: { totalCents: true, currency: true, orderNumber: true, shippingAddress: true, billingAddress: true, stripeSessionId: true },
      });
      const match = expected ? stripeAmountMatches(expected, session) : { ok: false as const, reason: 'order vanished' };
      if (expected && !match.ok) {
        const claim = await prisma.order.updateMany({
          // Once per session: a redelivery finds the hold already set and stops.
          where: { id: orderId, status: 'PENDING_PAYMENT', stripeSessionId: session.id, OR: [{ holdReason: null }, { holdReason: { not: 'PAYMENT_REVIEW' } }] },
          data: {
            financialStatus: 'UNDER_REVIEW',
            holdReason: 'PAYMENT_REVIEW',
            holdNote: `PAYMENT_REVIEW: Stripe payment does not match the order: ${match.reason} (session ${session.id}). Check it in Stripe; refund or correct before fulfilment.`.slice(0, 2000),
            holdAt: new Date(),
            stripePaymentIntentId: paymentIntentId,
            openHolds: { push: 'PAYMENT_REVIEW' },
          },
        });
        if (claim.count === 1 && typeof session.amount_total === 'number' && session.amount_total > 0) {
          await recordPayment(prisma, {
            orderId,
            amountCents: session.amount_total,
            currency: (session.currency || expected.currency).toUpperCase(),
            method: 'STRIPE',
            reference: paymentIntentId ?? session.id,
            source: 'STRIPE',
            stripePaymentIntentId: paymentIntentId ?? null,
            note: `Amount/currency mismatch: ${match.reason}`,
          }).catch((e) => logError('stripe.webhook.ledger-mismatch', e));
          await notifyAdmins(
            `Order ${expected.orderNumber}: Stripe amount does NOT match`,
            `${match.reason} The order is on hold (payment review) and was not marked paid.`,
            `/admin/orders/${orderId}`,
            'SYSTEM',
          );
          await audit('order.stripe.mismatch', expected.orderNumber, match.reason);
        }
        return NextResponse.json({ received: true, skipped: 'amount_mismatch' });
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
          // The delivery and billing addresses were decided on our checkout (VAT,
          // shipping zone and country policy depend on them): Stripe's card
          // details never overwrite them — they only fill a legacy order without one.
          ...(shippingAddress && !expected?.shippingAddress ? { shippingAddress: shippingAddress as object } : {}),
          ...(billingAddress && !expected?.billingAddress ? { billingAddress: billingAddress as object } : {}),
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
        select: { orderNumber: true, totalCents: true, buyerId: true, id: true, currency: true, sourcingRequestId: true, items: { select: { productId: true, quantity: true }, take: 1 } },
      });
      if (!paid) {
        return NextResponse.json({ received: true });
      }
      // A quote order paid by card (pay-by-card on the payment page): its held
      // unit is sold now, exactly as when staff verify a bank transfer (A09).
      if (paid.sourcingRequestId) {
        const quoteId = paid.sourcingRequestId;
        const note = await prisma.$transaction((tx) => sellQuoteUnit(tx, quoteId, paid.id, paid.items[0])).catch(async (e) => {
          await logError('stripe.webhook.quote-unit', e);
          return ' Warning: the held unit could not be marked sold — check the listing before shipping.';
        });
        if (note) await notifyAdmins(`Order ${paid.orderNumber}: check the stock`, note.trim(), `/admin/orders/${paid.id}`, 'SYSTEM');
      }
      // Payments ledger: the amount Stripe actually captured (B06) — verified
      // above to equal the order total.
      await recordPayment(prisma, {
        orderId: paid.id,
        amountCents: session.amount_total as number,
        currency: (session.currency || paid.currency || 'EUR').toUpperCase(),
        method: 'STRIPE',
        reference: paymentIntentId ?? session.id,
        source: 'STRIPE',
        stripePaymentIntentId: paymentIntentId ?? null,
        note: 'Stripe checkout.session.completed',
      }).catch((e) => logError('stripe.webhook.ledger', e));
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
      // If neither our checkout nor Stripe has a shipping address for a PAID
      // order, the warehouse can't dispatch — surface that immediately.
      if (!shippingAddress && !expected?.shippingAddress) {
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
  } else if (event.type === 'charge.dispute.created') {
    // A card dispute (chargeback): hold the order and tell staff — never silent.
    const dispute = event.data.object as { payment_intent?: unknown; amount?: number; currency?: string; reason?: string; id: string };
    const pi = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : null;
    const order = pi ? await prisma.order.findUnique({ where: { stripePaymentIntentId: pi }, select: { id: true, orderNumber: true, openHolds: true, holdNote: true } }) : null;
    if (order) {
      const note = `PAYMENT_REVIEW: Card dispute ${dispute.id} opened (${dispute.reason ?? 'no reason'}; ${((dispute.amount ?? 0) / 100).toFixed(2)} ${(dispute.currency ?? '').toUpperCase()}). Do not ship until it is resolved.`;
      await prisma.order.update({
        where: { id: order.id },
        data: {
          holdReason: primaryHold([...order.openHolds, 'PAYMENT_REVIEW']),
          holdNote: [order.holdNote, note].filter(Boolean).join(' | ').slice(0, 2000),
          holdAt: new Date(),
          ...(order.openHolds.includes('PAYMENT_REVIEW') ? {} : { openHolds: { push: 'PAYMENT_REVIEW' } }),
        },
      });
      await notifyAdmins(`Order ${order.orderNumber}: card dispute opened`, `Stripe dispute ${dispute.id}. The order is on hold — answer the dispute in Stripe.`, `/admin/orders/${order.id}`, 'SYSTEM');
      await audit('order.stripe.dispute', order.orderNumber, dispute.id);
    } else {
      await logError('stripe.webhook.dispute', new Error(`dispute ${dispute.id} for unknown payment ${pi ?? '?'}`));
    }
  } else if (event.type === 'charge.refunded') {
    // A refund made in the Stripe dashboard (not through our admin) must be
    // recorded here with a credit note — tell staff instead of ignoring it.
    const charge = event.data.object as { payment_intent?: unknown; amount_refunded?: number; currency?: string; id: string };
    const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
    const order = pi ? await prisma.order.findUnique({ where: { stripePaymentIntentId: pi }, select: { id: true, orderNumber: true, amountRefundedCents: true } }) : null;
    // Card refunds we issued (refund ledger SENT) are confirmed once Stripe reports them (A28).
    if (order) await confirmStripeRefunds(order.id, charge.amount_refunded ?? 0);
    if (order && (charge.amount_refunded ?? 0) > order.amountRefundedCents) {
      await notifyAdmins(
        `Order ${order.orderNumber}: refunded in Stripe`,
        `Stripe shows ${((charge.amount_refunded ?? 0) / 100).toFixed(2)} ${(charge.currency ?? '').toUpperCase()} refunded, our records ${(order.amountRefundedCents / 100).toFixed(2)}. Record the refund on the order (credit note).`,
        `/admin/orders/${order.id}`,
        'SYSTEM',
      );
    }
  } else if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    if (orderId && session.metadata?.kind === 'existing') {
      // A card attempt on an order that was already payable (payment page):
      // only that session ends — the order stays open for payment.
      await releaseExpiredCardSession(orderId, session.id);
    } else if (orderId) {
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
