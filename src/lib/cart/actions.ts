'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { getStripe, stripeConfigured } from '@/lib/stripe/client';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sendOrderReceived, createOrderWithUniqueNumber } from '@/lib/orders/actions';
import { notifyAdmins, notifyUser } from '@/lib/observability';

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
  const addr = {
    name: get('name').slice(0, 120),
    phone: get('phone').slice(0, 40),
    email: session.user.email,
    line1: get('line1').slice(0, 200),
    line2: get('line2').slice(0, 200),
    city: get('city').slice(0, 80),
    postal: get('postal').slice(0, 24),
    state: get('state').slice(0, 80),
    country: get('country').slice(0, 2).toUpperCase(),
  };
  if (addr.country === '__OTHER' || addr.country === 'OT') {
    redirect('/let-us-find-it?reason=shipping');
  }
  const missing: string[] = [];
  if (!addr.name) missing.push('name');
  if (!addr.phone) missing.push('phone');
  if (!addr.line1) missing.push('line1');
  if (!addr.city) missing.push('city');
  if (!addr.postal) missing.push('postal');
  if (addr.country.length !== 2) missing.push('country');
  if (missing.length > 0) {
    redirect(`/checkout/cart?missing=${missing.join(',')}`);
  }

  const hdrs = await import('next/headers').then((m) => m.headers());
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
  const valid = items.filter(
    (i) =>
      i.product.status === 'PUBLISHED' &&
      i.product.priceCents &&
      i.product.mode !== 'QUOTE_ONLY' &&
      i.product.quantity > 0,
  );
  if (valid.length === 0) redirect('/app/cart?empty=1');

  const currency = valid[0].product.currency || 'EUR';
  if (valid.some((i) => (i.product.currency || 'EUR') !== currency)) {
    redirect('/app/cart?mixedcurrency=1');
  }

  const reserved: typeof valid = [];
  for (const i of valid) {
    const r = await prisma.product.updateMany({
      where: { id: i.productId, quantity: { gte: i.quantity } },
      data: { quantity: { decrement: i.quantity } },
    });
    if (r.count === 1) reserved.push(i);
  }
  if (reserved.length !== valid.length) {
    for (const i of reserved) {
      await prisma.product.update({
        where: { id: i.productId },
        data: { quantity: { increment: i.quantity } },
      });
    }
    redirect('/app/cart?unavailable=1');
  }

  const subtotal = valid.reduce((s, i) => s + (i.product.priceCents ?? 0) * i.quantity, 0);
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

  const order = await createOrderWithUniqueNumber({
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
    items: {
      create: valid.map((i) => ({
        productId: i.productId,
        titleSnapshot: i.product.title,
        brandSnapshot: i.product.brand?.name ?? null,
        priceCentsSnapshot: i.product.priceCents ?? 0,
        quantity: i.quantity,
      })),
    },
  });
  await prisma.cartItem.deleteMany({ where: { userId: session.user.id } });

  const itemSummary = `${valid.length} item${valid.length === 1 ? '' : 's'}`;
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

  if (!STRIPE) {
    await sendOrderReceived(order.id);
    redirect(`/checkout/success?order=${order.orderNumber}&pending=1`);
  }

  return _legacyStripeCartHandoff(order, valid, currency, subtotal);
}

/**
 * Stripe hand-off — only used when STRIPE_SECRET_KEY is set. Manual mode
 * never reaches this. Kept future-ready.
 */
async function _legacyStripeCartHandoff(
  order: { id: string; orderNumber: string },
  valid: Array<{ productId: string; product: { title: string; priceCents: number | null }; quantity: number }>,
  currency: string,
  _subtotal: number,
): Promise<never> {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');
  const baseUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  let checkout;
  try {
    checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: valid.map((i) => ({
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
  } catch {
    for (const i of valid) {
      await prisma.product.update({
        where: { id: i.productId },
        data: { quantity: { increment: i.quantity } },
      });
    }
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELED' } });
    redirect('/app/cart?payment=error');
  }
  await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: checkout.id } });
  if (!checkout.url) throw new Error('Stripe session URL missing');
  redirect(checkout.url);
}
