import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { getStripe } from '@/lib/stripe/client';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sendOrderInvoice } from '@/lib/orders/actions';
import { notifyAdmins, notifyUser } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  await ensureSettingsLoaded();
  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: 'stripe not configured' }, { status: 500 });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'webhook secret missing' }, { status: 500 });

  const body = await req.text();
  const sig = headers().get('stripe-signature');
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
        select: { status: true },
      });
      if (!current) {
        // Unknown order — stale metadata. Acknowledge so Stripe stops retrying.
        return NextResponse.json({ received: true, skipped: 'unknown_order' });
      }
      if (current.status !== 'PENDING_PAYMENT') {
        // Already processed (or in a terminal state). Ack-and-skip; do
        // NOT replay invoice email or status flip.
        return NextResponse.json({ received: true, skipped: 'already_processed' });
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

      // Atomic conditional update — only flips PENDING_PAYMENT → PAID
      // once. Concurrent webhook deliveries are serialised by the row
      // lock; only one update wins (count===1), the rest no-op (count===0).
      const updateRes = await prisma.order.updateMany({
        where: { id: orderId, status: 'PENDING_PAYMENT' },
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
        // Lost the race with another delivery / status changed since
        // our pre-check. Ack-and-skip side effects.
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
      const existing = await prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true, items: { select: { productId: true, quantity: true } } },
      });
      // Only release stock once, and never cancel an order that already paid.
      if (existing && existing.status === 'PENDING_PAYMENT') {
        await prisma.order.update({
          where: { id: orderId },
          data: { status: 'CANCELED' },
        });
        for (const it of existing.items) {
          if (it.productId) {
            await prisma.product.update({
              where: { id: it.productId },
              data: { quantity: { increment: it.quantity } },
            });
          }
        }
      }
    }
  }

  return NextResponse.json({ received: true });
}
