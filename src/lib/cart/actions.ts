'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { getStripe, stripeConfigured } from '@/lib/stripe/client';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sendOrderReceived } from '@/lib/orders/internal';
import { parseCheckoutCountry } from '@/lib/orders/countries';
import { reserveAndCreateOrder } from '@/lib/orders/checkout-tx';
import { stripeCheckoutHandoff, type StripeSessionApi } from '@/lib/orders/stripe-handoff';
import { safeExpire } from '@/lib/stripe/session-api';
import { logError, notifyAdmins, notifyUser } from '@/lib/observability';

export async function addToCart(productSlug: string, quantity = 1) {
  const session = await requireSession({ redirectTo: `/marketplace/${productSlug}` });
  const product = await prisma.product.findUnique({
    where: { slug: productSlug },
    select: { id: true, mode: true, priceCents: true, quantity: true, status: true },
  });
  if (!product) redirect('/marketplace?gone=1');
  if (product.mode === 'QUOTE_ONLY' || !product.priceCents || product.status !== 'PUBLISHED') {
    redirect(`/marketplace/${productSlug}?quoteonly=1`);
  }
  if (product.quantity <= 0) {
    redirect(`/marketplace/${productSlug}?sold=1`);
  }
  const existing = await prisma.cartItem.findUnique({
    where: { userId_productId: { userId: session.user.id, productId: product.id } },
    select: { quantity: true },
  });
  const want = Math.max(1, Math.floor(quantity) || 1) + (existing?.quantity ?? 0);
  const finalQty = Math.min(want, product.quantity, 99);
  await prisma.cartItem.upsert({
    where: { userId_productId: { userId: session.user.id, productId: product.id } },
    update: { quantity: finalQty },
    create: { userId: session.user.id, productId: product.id, quantity: finalQty },
  });
  revalidatePath('/app/cart');
  redirect('/app/cart?added=1');
}

export async function setCartQty(itemId: string, quantity: number) {
  const session = await requireSession({ redirectTo: '/app/cart' });
  const item = await prisma.cartItem.findUnique({
    where: { id: itemId },
    include: { product: { select: { quantity: true } } },
  });
  if (!item || item.userId !== session.user.id) throw new Error('Not found');
  const avail = Math.max(0, item.product?.quantity ?? 0);
  const qty = Math.max(1, Math.min(avail || 1, 99, Math.floor(quantity) || 1));
  await prisma.cartItem.update({ where: { id: itemId }, data: { quantity: qty } });
  revalidatePath('/app/cart');
}

export async function removeFromCart(itemId: string) {
  const session = await requireSession({ redirectTo: '/app/cart' });
  await prisma.cartItem.deleteMany({ where: { id: itemId, userId: session.user.id } });
  revalidatePath('/app/cart');
}

/**
 * Legacy entrypoint preserved for cached browser POSTs. Always redirects
 * to the address-collection page now. BUG-011 fix.
 */
export async function checkoutCart() {
  redirect('/checkout/cart');
}

/**
 * Cart checkout with explicit address collection — mirrors
 * `startCheckoutWithAddress` for the single-product flow. Reserves stock,
 * creates the order WITH a complete `shippingAddress`, then either hands
 * off to Stripe (when STRIPE_SECRET_KEY is set) or to the manual
 * bank-transfer path (current production posture).
 */
export async function startCartCheckoutWithAddress(formData: FormData) {
  await ensureSettingsLoaded();
  const STRIPE = stripeConfigured();
  const session = await requireSession({ redirectTo: '/checkout/cart' });

  const get = (k: string) => String(formData.get(k) ?? '').trim();
  // "Other — request a shipping quote": no order, no reservation — send the
  // buyer to the sourcing form instead (checked on the RAW value; see
  // parseCheckoutCountry). A single-item cart prefills that product.
  const country = parseCheckoutCountry(get('country'));
  if (country.kind === 'other') {
    const rows = await prisma.cartItem.findMany({
      where: { userId: session.user.id },
      select: { product: { select: { slug: true } } },
      take: 2,
    });
    const product = rows.length === 1 ? `product=${encodeURIComponent(rows[0].product.slug)}&` : '';
    redirect(`/let-us-find-it?${product}reason=shipping`);
  }
  const addr = {
    name: get('name').slice(0, 120),
    phone: get('phone').slice(0, 40),
    email: session.user.email,
    line1: get('line1').slice(0, 200),
    line2: get('line2').slice(0, 200),
    city: get('city').slice(0, 80),
    postal: get('postal').slice(0, 24),
    state: get('state').slice(0, 80),
    country: country.kind === 'ok' ? country.code : '',
  };
  const missing: string[] = [];
  if (!addr.name) missing.push('name');
  if (!addr.phone) missing.push('phone');
  if (!addr.line1) missing.push('line1');
  if (!addr.city) missing.push('city');
  if (!addr.postal) missing.push('postal');
  if (!addr.country) missing.push('country');
  if (missing.length > 0) {
    redirect(`/checkout/cart?missing=${missing.join(',')}`);
  }

  const hdrs = await headers();
  const buyerIp =
    (hdrs.get('cf-connecting-ip') ||
      hdrs.get('x-forwarded-for')?.split(',')[0] ||
      hdrs.get('x-real-ip') ||
      '').trim() || null;
  const buyerCountry = (hdrs.get('cf-ipcountry') || '').trim() || addr.country || null;

  const items = await prisma.cartItem.findMany({
    where: { userId: session.user.id },
    include: { product: { include: { brand: { select: { name: true } } } } },
  });
  // Never order a SUBSET. An empty cart is empty; if ANY row is non-buyable
  // (sold out / unpublished / QUOTE_ONLY / priceless) the whole checkout is
  // unavailable with NO write — otherwise clearing the cart would silently drop
  // the rows the buyer was shown but didn't order. (The reservation below is the
  // authoritative, TOCTOU-safe guard; this is just the fast pre-check.)
  if (items.length === 0) redirect('/app/cart?empty=1');
  const buyable = (i: (typeof items)[number]) =>
    i.product.status === 'PUBLISHED' &&
    !!i.product.priceCents &&
    i.product.mode !== 'QUOTE_ONLY' &&
    i.product.quantity >= i.quantity;
  if (!items.every(buyable)) redirect('/app/cart?unavailable=1');

  const currency = items[0].product.currency || 'EUR';
  if (items.some((i) => (i.product.currency || 'EUR') !== currency)) {
    redirect('/app/cart?mixedcurrency=1');
  }

  const subtotal = items.reduce((s, i) => s + (i.product.priceCents ?? 0) * i.quantity, 0);
  const shipping = Math.max(0, parseInt(process.env.DEFAULT_SHIPPING_CENTS || '0', 10) || 0);
  const taxPct = Math.max(0, parseFloat(process.env.DEFAULT_TAX_PERCENT || '0') || 0);
  const tax = Math.round((subtotal * taxPct) / 100);

  const shippingAddressPayload = {
    name: addr.name,
    phone: addr.phone,
    email: addr.email,
    address: {
      line1: addr.line1,
      line2: addr.line2 || null,
      city: addr.city,
      postal_code: addr.postal,
      state: addr.state || null,
      country: addr.country,
    },
  };

  // Reserve every unit, create the order, AND clear the cart in ONE transaction.
  // A partial reservation or a create failure rolls back every decrement and
  // leaves the cart intact; success decrements once, creates one order, and
  // clears the cart once. Concurrent quantity=1 checkouts cannot oversell, and an
  // orderNumber collision retries the WHOLE transaction. Replaces the old
  // decrement-loop → create → separate cart-delete, whose windows leaked stock on
  // a crash and could partially reserve.
  const result = await reserveAndCreateOrder(prisma, {
    reservations: items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      expectedPriceCents: i.product.priceCents ?? 0,
      expectedCurrency: i.product.currency,
    })),
    orderData: {
      buyerId: session.user.id,
      status: 'PENDING_PAYMENT',
      subtotalCents: subtotal,
      shippingCents: shipping,
      taxCents: tax,
      totalCents: subtotal + shipping + tax,
      currency,
      paidAt: null,
      buyerIp,
      buyerCountry,
      shippingAddress: shippingAddressPayload,
    },
    items: items.map((i) => ({
      productId: i.productId,
      titleSnapshot: i.product.title,
      brandSnapshot: i.product.brand?.name ?? null,
      priceCentsSnapshot: i.product.priceCents ?? 0,
      quantity: i.quantity,
    })),
    // Exact snapshot: clear only these rows at these quantities, in the same tx.
    cartClear: { userId: session.user.id, items: items.map((i) => ({ id: i.id, quantity: i.quantity })) },
  });
  if (!result.ok) {
    if (result.reason === 'unavailable') redirect('/app/cart?unavailable=1');
    if (result.reason === 'cart-changed') redirect('/app/cart?changed=1');
    await logError('checkoutCart.createOrder', result.error);
    redirect('/checkout/cart?err=order');
  }
  const order = result.order;

  const itemSummary = `${items.length} item${items.length === 1 ? '' : 's'}`;
  const fmtTotal = (() => {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: (currency || 'EUR').toUpperCase(),
        maximumFractionDigits: 2,
      }).format((subtotal + shipping + tax) / 100);
    } catch {
      return `${(currency || 'EUR').toUpperCase()} ${((subtotal + shipping + tax) / 100).toFixed(2)}`;
    }
  })();

  if (!STRIPE) {
    // Manual mode: order committed + cart cleared — announce now.
    await notifyAdmins(
      `New order ${order.orderNumber} — ${fmtTotal} awaiting payment`,
      `${itemSummary} · ship to ${addr.city}, ${addr.country}. Send bank-transfer details to the buyer.`,
      `/admin/orders/${order.id}`,
      'ORDER_NEW',
    );
    await notifyUser(
      session.user.id,
      `Order ${order.orderNumber} received`,
      `We have your order (${itemSummary}). We will send bank-transfer details and coordinate delivery.`,
      `/app/orders/${order.orderNumber}`,
    );
    await sendOrderReceived(order.id);
    redirect(`/checkout/success?order=${order.orderNumber}&pending=1`);
  }

  return _legacyStripeCartHandoff(order, items, currency, {
    itemSummary,
    fmtTotal,
    city: addr.city,
    country: addr.country,
    buyerId: session.user.id,
  });
}

/**
 * Stripe hand-off — only used when STRIPE_SECRET_KEY is set. Manual mode
 * never reaches this. Kept future-ready.
 */
async function _legacyStripeCartHandoff(
  order: { id: string; orderNumber: string },
  items: Array<{ productId: string; product: { title: string; priceCents: number | null }; quantity: number }>,
  currency: string,
  notifyCtx: { itemSummary: string; fmtTotal: string; city: string; country: string; buyerId: string },
): Promise<never> {
  const stripe = getStripe();
  const baseUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  // Same shared saga as the single path — no divergent failure handling.
  const api: StripeSessionApi | null = stripe
    ? {
        create: async () => {
          const s = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'], // synchronous card-only
            line_items: items.map((i) => ({
              price_data: {
                currency: currency.toLowerCase(),
                unit_amount: i.product.priceCents ?? 0,
                product_data: { name: i.product.title },
              },
              quantity: i.quantity,
            })),
            metadata: { orderId: order.id, orderNumber: order.orderNumber },
            success_url: `${baseUrl}/checkout/success?order=${order.orderNumber}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/app/cart?canceled=1`,
          });
          return { id: s.id, url: s.url };
        },
        expire: (id) => safeExpire(stripe, id),
      }
    : null;
  // CAS persist — single winner vs a concurrent cancel/persist; idempotent on retry.
  const handoff = await stripeCheckoutHandoff(prisma, api, order.id, async (sid) => {
    const r = await prisma.order.updateMany({
      where: { id: order.id, status: 'PENDING_PAYMENT', OR: [{ stripeSessionId: null }, { stripeSessionId: sid }] },
      data: { stripeSessionId: sid },
    });
    return r.count;
  });
  if (!handoff.ok) {
    await logError('checkoutCart.stripe', new Error(`handoff ${handoff.reason} order=${order.orderNumber} session=${handoff.sessionId ?? 'none'}`));
    redirect('/app/cart?payment=error');
  }
  // Handoff succeeded — stripeSessionId already persisted; announce + redirect now.
  await notifyAdmins(
    `New order ${order.orderNumber} — ${notifyCtx.fmtTotal} awaiting payment`,
    `${notifyCtx.itemSummary} · ship to ${notifyCtx.city}, ${notifyCtx.country}. Buyer is completing card payment.`,
    `/admin/orders/${order.id}`,
    'ORDER_NEW',
  );
  await notifyUser(
    notifyCtx.buyerId,
    `Order ${order.orderNumber} received`,
    `We have your order (${notifyCtx.itemSummary}). Complete payment to confirm.`,
    `/app/orders/${order.orderNumber}`,
  );
  redirect(handoff.url);
}
