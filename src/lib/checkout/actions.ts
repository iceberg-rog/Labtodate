'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { ensureSettingsLoaded, settingInt } from '@/lib/settings';
import { getStripe } from '@/lib/stripe/client';
import { safeExpire } from '@/lib/stripe/session-api';
import { allowHit } from '@/lib/security/throttle';
import { clientIpFrom } from '@/lib/ratelimit';
import { audit, logError, notifyAdmins, notifyUser } from '@/lib/observability';
import { stripeCheckoutHandoff, type StripeSessionApi } from '@/lib/orders/stripe-handoff';
import { formatPrice } from '@/lib/utils';
import { stripeLineItems } from './engine';
import { formValuesFrom, type CheckoutFormValues } from './input';
import { computeCheckout, placeCheckoutOrder, type CheckoutSource } from './server';
import { holdTitle, sendCheckoutConfirmation, sendCheckoutOnHold } from './notify';
import { startCardPaymentForOrder } from './card';
import type { CheckoutQuoteView, PlaceOrderState } from './view';

function sourceOf(v: CheckoutFormValues): CheckoutSource {
  return v.source === 'cart' ? { kind: 'cart' } : { kind: 'single', slug: v.slug };
}

function backTo(v: CheckoutFormValues): string {
  return v.source === 'cart' ? '/checkout/cart' : `/checkout/${encodeURIComponent(v.slug)}`;
}

async function throttle(kind: 'preview' | 'submit'): Promise<boolean> {
  await ensureSettingsLoaded();
  const h = await headers();
  const max = kind === 'preview' ? settingInt('CHECKOUT_PREVIEW_RATE_LIMIT', 120) : settingInt('CHECKOUT_SUBMIT_RATE_LIMIT', 20);
  const { allowed } = await allowHit(`rl:checkout-${kind}:${clientIpFrom(h)}`, max, 10 * 60_000);
  return allowed;
}

/**
 * Live summary for the checkout page: the exact total for the address, buyer
 * type and VAT ID currently typed (country policy, shipping zones, VIES, VAT
 * engine). Never writes an order.
 */
export async function previewCheckout(raw: Record<string, string>): Promise<{ ok: true; quote: CheckoutQuoteView } | { ok: false; message: string }> {
  const session = await requireSession({ redirectTo: '/app/cart' });
  if (!(await throttle('preview'))) {
    return { ok: false, message: 'Too many price checks from your connection — wait a few minutes, then change a field again.' };
  }
  const v = formValuesFrom((k) => (typeof raw[k] === 'string' ? raw[k] : null));
  try {
    const q = await computeCheckout(session.user.id, sourceOf(v), v);
    return { ok: true, quote: q.view };
  } catch (e) {
    await logError('checkout.preview', e);
    return { ok: false, message: 'The total could not be calculated just now. Please try again in a moment.' };
  }
}

/** Place the order (both checkouts). Returns an error state, or redirects. */
export async function placeOrder(_prev: PlaceOrderState, formData: FormData): Promise<PlaceOrderState> {
  const v = formValuesFrom((k) => {
    const x = formData.get(k);
    return typeof x === 'string' ? x : null;
  });
  const session = await requireSession({ redirectTo: backTo(v) });
  if (!(await throttle('submit'))) {
    return { status: 'error', message: 'Too many order attempts from your connection. Please wait a few minutes and try again.', fieldErrors: {}, quote: null };
  }
  const h = await headers();
  const buyerIp = (h.get('cf-connecting-ip') || clientIpFrom(h) || '').trim() || null;
  const buyerCountry = (h.get('cf-ipcountry') || '').trim() || v.country || null;

  let placed: Awaited<ReturnType<typeof placeCheckoutOrder>>;
  try {
    placed = await placeCheckoutOrder({ id: session.user.id, email: session.user.email, name: session.user.name }, sourceOf(v), v, { buyerIp, buyerCountry });
  } catch (e) {
    await logError('checkout.placeOrder', e);
    return { status: 'error', message: 'We could not create your order because of an error on our side. Nothing was reserved and no payment is due — please try again.', fieldErrors: {}, quote: null };
  }
  if (!placed.ok) {
    return { status: 'error', message: placed.message, fieldErrors: placed.fieldErrors, quote: placed.quote, changed: placed.changed };
  }
  const { order } = placed;
  const fmtTotal = formatPrice(placed.totalCents, placed.currency);
  await audit('order.checkout', order.orderNumber, `${placed.itemSummary} total=${placed.totalCents} holds=${placed.holds.join(',') || '-'} pay=${placed.paymentMethod}`);
  revalidatePath('/app/cart');
  revalidatePath('/admin/orders');

  // ── On hold: no payment request until staff resolve it ──
  if (placed.holds.length) {
    const titles = placed.holds.map(holdTitle).join(', ');
    await notifyAdmins(`Order ${order.orderNumber} on hold — ${titles}`, `${placed.itemSummary} · ${fmtTotal} so far. Resolve the open point(s) on the order page to send the final total.`, `/admin/orders/${order.id}`, 'ORDER_NEW');
    await notifyUser(session.user.id, `Order ${order.orderNumber} received`, `We confirm the final total before any payment (${titles}). Nothing is due yet.`, `/app/orders/${order.orderNumber}`);
    await sendCheckoutOnHold(order.id, placed.holdMessages);
    redirect(`/checkout/success?order=${order.orderNumber}`);
  }

  // ── Card via Stripe ──
  if (placed.paymentMethod === 'STRIPE_CARD') {
    const stripe = getStripe();
    const baseUrl = (process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    const lineItems = stripeLineItems({
      currency: placed.currency,
      items: placed.lines,
      shippingCents: placed.shippingCents,
      taxCents: placed.taxCents,
      totalCents: placed.totalCents,
      vatLabel: placed.vatLabel,
      orderNumber: order.orderNumber,
    });
    const api: StripeSessionApi | null = stripe
      ? {
          create: async () => {
            const s = await stripe.checkout.sessions.create({
              mode: 'payment',
              payment_method_types: ['card'], // synchronous: `completed` implies captured funds
              customer_email: session.user.email,
              // The address, VAT and shipping were decided on OUR checkout; Stripe
              // only takes the card for exactly that total (no address collection).
              line_items: lineItems.map((l) => ({
                price_data: { currency: placed.currency.toLowerCase(), unit_amount: l.unitAmount, product_data: { name: l.name } },
                quantity: l.quantity,
              })),
              metadata: { orderId: order.id, orderNumber: order.orderNumber, totalCents: String(placed.totalCents), currency: placed.currency },
              success_url: `${baseUrl}/checkout/success?order=${order.orderNumber}&session_id={CHECKOUT_SESSION_ID}`,
              cancel_url: `${baseUrl}${v.source === 'cart' ? '/app/cart' : `/marketplace/${encodeURIComponent(v.slug)}`}?canceled=1`,
            });
            return { id: s.id, url: s.url };
          },
          expire: (id) => safeExpire(stripe, id),
        }
      : null;
    const handoff = await stripeCheckoutHandoff(prisma, api, order.id, async (sid) => {
      const r = await prisma.order.updateMany({
        where: { id: order.id, status: 'PENDING_PAYMENT', OR: [{ stripeSessionId: null }, { stripeSessionId: sid }] },
        data: { stripeSessionId: sid },
      });
      return r.count;
    });
    if (!handoff.ok) {
      await logError('checkout.stripe', new Error(`handoff ${handoff.reason} order=${order.orderNumber} session=${handoff.sessionId ?? 'none'}`));
      return {
        status: 'error',
        message: `The card payment could not be started, so order ${order.orderNumber} was canceled and its items released. Nothing was charged. Please try again or choose bank transfer.`,
        fieldErrors: {},
        quote: null,
      };
    }
    await notifyAdmins(`New order ${order.orderNumber} — ${fmtTotal} awaiting card payment`, `${placed.itemSummary} · buyer is on the Stripe payment page.`, `/admin/orders/${order.id}`, 'ORDER_NEW');
    await notifyUser(session.user.id, `Order ${order.orderNumber} received`, 'Complete the card payment to confirm the order.', `/app/orders/${order.orderNumber}`);
    redirect(handoff.url);
  }

  // ── Bank transfer ──
  const mail = await sendCheckoutConfirmation(order.id);
  await notifyAdmins(`New order ${order.orderNumber} — ${fmtTotal} awaiting bank transfer`, `${placed.itemSummary}${mail.proforma ? ` · proforma ${mail.proforma}` : ''}${mail.emailed ? '' : ' · the confirmation email could NOT be sent — contact the buyer'}.`, `/admin/orders/${order.id}`, 'ORDER_NEW');
  await notifyUser(session.user.id, `Order ${order.orderNumber} received`, `Pay ${fmtTotal} by bank transfer${mail.proforma ? ` (reference ${mail.proforma})` : ''}; we dispatch once the payment is verified.`, `/app/orders/${order.orderNumber}`);
  redirect(`/checkout/success?order=${order.orderNumber}${mail.emailed ? '' : '&mail=0'}`);
}

/** Payment page: pay an existing, payable order by card (Stripe). */
export async function payOrderByCard(formData: FormData): Promise<void> {
  const orderNumber = String(formData.get('orderNumber') ?? '').trim();
  const session = await requireSession({ redirectTo: `/app/orders/${orderNumber}/payment` });
  const order = await prisma.order.findUnique({ where: { orderNumber }, select: { id: true, buyerId: true } });
  if (!order || order.buyerId !== session.user.id) redirect('/app/orders');
  if (!(await throttle('submit'))) redirect(`/app/orders/${orderNumber}/payment?card=failed`);
  const r = await startCardPaymentForOrder(order.id, session.user.email);
  if (!r.ok) redirect(`/app/orders/${orderNumber}/payment?card=${r.code}`);
  await audit('order.card.start', orderNumber, 'buyer opened the card payment page');
  redirect(r.url);
}
