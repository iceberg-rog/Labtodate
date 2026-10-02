'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { getStripe, stripeConfigured } from '@/lib/stripe/client';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sendEmail } from '@/lib/email';
import { audit, logError, notifyAdmins, notifyUser } from '@/lib/observability';
import { reserveAndCreateOrder } from '@/lib/orders/checkout-tx';
import { sendOrderReceived } from '@/lib/orders/internal';
import { parseCheckoutCountry } from '@/lib/orders/countries';
import { stripeCheckoutHandoff, type StripeSessionApi } from '@/lib/orders/stripe-handoff';
import { safeExpire } from '@/lib/stripe/session-api';
import { withUniqueTicketRef } from '@/lib/support/actions';

export async function requestReturn(orderNumber: string, formData: FormData) {
  await ensureSettingsLoaded();
  const session = await requireSession({ redirectTo: `/app/orders/${orderNumber}` });
  const reason = String(formData.get('reason') ?? '').trim();
  const order = await prisma.order.findUnique({ where: { orderNumber } });
  if (!order || order.buyerId !== session.user.id) throw new Error('Order not found');

  // De-dupe: one active return request per order. Stops the form being
  // resubmitted into dozens of identical tickets.
  const existing = await prisma.supportTicket.findFirst({
    where: {
      submittedById: session.user.id,
      subject: `Return / refund — order ${orderNumber}`,
      status: { in: ['OPEN', 'PENDING'] },
    },
    select: { ref: true },
  });
  if (existing) {
    redirect(`/app/orders/${orderNumber}?returned=${existing.ref}&dup=1`);
  }

  const ticket = await withUniqueTicketRef((r) =>
    prisma.supportTicket.create({
      data: {
        ref: r,
        name: session.user.name,
        email: session.user.email,
        subject: `Return / refund — order ${orderNumber}`,
        category: 'Return/refund',
        submittedById: session.user.id,
        messages: {
          create: {
            fromStaff: false,
            authorId: session.user.id,
            body: `Return/refund requested for order ${orderNumber}.\n\nReason: ${reason || '(not specified)'}`,
          },
        },
      },
      select: { ref: true },
    }),
  );
  const ref = ticket.ref;

  const ops =
    process.env.SUPPORT_INTAKE_EMAIL || process.env.SUPPORT_EMAIL || process.env.COMPANY_EMAIL || 'support@lab2date.com';
  await sendEmail({
    to: ops,
    subject: `Return request ${ref} — order ${orderNumber}`,
    html: `<p>${session.user.name} (${session.user.email}) requested a return/refund for <strong>${orderNumber}</strong>.</p><p>Reason: ${reason || '—'}</p>`,
  });
  await sendEmail({
    to: session.user.email,
    subject: `[${ref}] We received your return request`,
    html: `<p>We&rsquo;ve logged your return/refund request for order ${orderNumber}. Our team will follow up by email. Reference: ${ref}.</p>`,
  });

  revalidatePath(`/app/orders/${orderNumber}`);
  revalidatePath('/admin/tickets');
  redirect(`/app/orders/${orderNumber}?returned=${ref}`);
}

/**
 * Buyer-side delivery confirmation. Only allowed once the order is SHIPPED;
 * stamps DELIVERED + deliveredAt and notifies the ops team so they know the
 * shipment is closed (no need to chase the carrier). Admin can also flip the
 * status manually via setOrderFulfillment for couriers that auto-confirm.
 */
export async function confirmDelivery(orderNumber: string): Promise<void> {
  await ensureSettingsLoaded();
  const session = await requireSession({ redirectTo: `/app/orders/${orderNumber}` });
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: { id: true, status: true, buyerId: true, trackingCarrier: true, trackingNumber: true },
  });
  if (!order || order.buyerId !== session.user.id) throw new Error('Order not found');
  if (order.status !== 'SHIPPED') {
    // Idempotent: if already DELIVERED just no-op + revalidate.
    if (order.status === 'DELIVERED') {
      revalidatePath(`/app/orders/${orderNumber}`);
      return;
    }
    throw new Error(`Cannot confirm delivery — order is ${order.status.toLowerCase()}.`);
  }
  // BUG-038: claim the SHIPPED->DELIVERED transition atomically. The status
  // guard above reads a snapshot; an unconditional update could (a) on a buyer
  // double-click, run twice -> double admin-notify + re-stamp deliveredAt, and
  // (b) race a concurrent admin refundOrder (which claims any non-REFUNDED row,
  // including SHIPPED): refund flips SHIPPED->REFUNDED + restocks + emails, then
  // this write would overwrite it back to DELIVERED -> a terminal-state
  // regression (REFUNDED->DELIVERED) violating S3/F12, with stock already
  // returned and money refunded. The conditional updateMany makes the write the
  // single source of truth: it only lands while the row is still SHIPPED. If we
  // lost the race (count!==1) we skip every side effect, same posture as the
  // admin siblings (setOrderFulfillment / cancelOrder / refundOrder).
  const res = await prisma.order.updateMany({
    where: { id: order.id, status: 'SHIPPED' },
    data: { status: 'DELIVERED', deliveredAt: new Date() },
  });
  if (res.count !== 1) {
    // Another writer (concurrent confirm, or an admin refund/cancel) already
    // moved the row out of SHIPPED. Do not regress it or re-fire notifications.
    revalidatePath(`/app/orders/${orderNumber}`);
    return;
  }
  await notifyAdmins(
    `Order ${orderNumber}: delivery confirmed by buyer`,
    `${order.trackingCarrier ?? '—'}${order.trackingNumber ? ` · ${order.trackingNumber}` : ''}`,
    `/admin/orders/${order.id}`,
    'ORDER_DELIVERED',
  );
  await audit('order.delivery.confirm', orderNumber, `buyer=${session.user.email}`);
  revalidatePath(`/app/orders/${orderNumber}`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${order.id}`);
}

/**
 * Initiate purchase of a single product.
 *
 * With STRIPE_SECRET_KEY set: creates a Stripe Checkout session and redirects.
 * Without Stripe (dev): creates the order in PAID state and redirects to success.
 */
/** Old entry — redirects to the address form. Kept so any existing
 *  `<form action={startCheckout.bind(null, slug)}>` still works. */
export async function startCheckout(productSlug: string) {
  redirect(`/checkout/${productSlug}`);
}

/** Real checkout — invoked from /checkout/[slug] form submission. We collect
 *  shipping address + phone here BEFORE Stripe so even pending-payment orders
 *  always have somewhere to ship to. */
export async function startCheckoutWithAddress(productSlug: string, formData: FormData) {
  await ensureSettingsLoaded();
  const STRIPE_CONFIGURED = stripeConfigured();
  const session = await requireSession({ redirectTo: `/checkout/${productSlug}` });

  // Pull and lightly validate the address. Fields the warehouse must have:
  //   name + phone + line1 + city + postal + country.
  const get = (k: string) => String(formData.get(k) ?? '').trim();
  // "Other — request a shipping quote" → divert to the sourcing form (product
  // prefilled) so the team can quote shipping for unusual destinations. No
  // order is created and no stock reserved for an order that may not ship.
  // Checked on the RAW value — see parseCheckoutCountry.
  const country = parseCheckoutCountry(get('country'));
  if (country.kind === 'other') {
    redirect(`/let-us-find-it?product=${encodeURIComponent(productSlug)}&reason=shipping`);
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
    redirect(`/checkout/${productSlug}?missing=${missing.join(',')}`);
  }

  // Capture buyer IP + country at order creation. Cheap forensic trail —
  // useful for chargeback dispute + fraud review. CF tunnel forwards CF-IPCountry.
  const hdrs = await headers();
  const buyerIp =
    (hdrs.get('cf-connecting-ip') ||
      hdrs.get('x-forwarded-for')?.split(',')[0] ||
      hdrs.get('x-real-ip') ||
      '').trim() || null;
  const buyerCountry = (hdrs.get('cf-ipcountry') || '').trim() || addr.country || null;

  const product = await prisma.product.findUnique({
    where: { slug: productSlug },
    include: { brand: { select: { name: true } } },
  });
  // Graceful (no error page) for non-buyable products.
  if (!product || product.status !== 'PUBLISHED') redirect('/marketplace?gone=1');
  if (product.mode === 'QUOTE_ONLY' || !product.priceCents) {
    redirect(`/marketplace/${productSlug}?quoteonly=1`);
  }

  const subtotal = product.priceCents;
  const shipping = Math.max(0, parseInt(process.env.DEFAULT_SHIPPING_CENTS || '0', 10) || 0);
  const taxPct = Math.max(0, parseFloat(process.env.DEFAULT_TAX_PERCENT || '0') || 0);
  const tax = Math.round((subtotal * taxPct) / 100);
  const total = subtotal + shipping + tax;

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

  // Reserve the unit AND create the order in ONE transaction (crash-safe). The
  // old code decremented stock, committed, then created the order separately, so
  // a throw or process death in that window leaked the unit forever (no Order
  // row → no sweep/cancel/refund can restock it). reserveAndCreateOrder rolls the
  // decrement back automatically on any failure and retries the WHOLE transaction
  // on an orderNumber collision.
  const result = await reserveAndCreateOrder(prisma, {
    reservations: [
      {
        productId: product.id,
        quantity: 1,
        expectedPriceCents: product.priceCents,
        expectedCurrency: product.currency,
      },
    ],
    orderData: {
      buyerId: session.user.id,
      status: 'PENDING_PAYMENT',
      subtotalCents: subtotal,
      shippingCents: shipping,
      taxCents: tax,
      totalCents: total,
      currency: product.currency,
      paidAt: null,
      buyerIp,
      buyerCountry,
      shippingAddress: shippingAddressPayload,
    },
    items: [
      {
        productId: product.id,
        titleSnapshot: product.title,
        brandSnapshot: product.brand?.name ?? null,
        priceCentsSnapshot: product.priceCents,
        quantity: 1,
      },
    ],
  });
  if (!result.ok) {
    // (single checkout has no cart snapshot, so 'cart-changed' can't occur here,
    // but handle it for exhaustiveness before narrowing to the error case.)
    if (result.reason === 'unavailable' || result.reason === 'cart-changed') {
      redirect(`/marketplace/${productSlug}?sold=1`);
    }
    await logError('startCheckoutWithAddress.createOrder', result.error);
    redirect(`/checkout/${productSlug}?err=order`);
  }
  const order = result.order;

  // Currency-aware total (no hardcoded € — closes invariant F13 / BUG-003).
  const fmtTotal = (() => {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: (product.currency || 'EUR').toUpperCase(),
        maximumFractionDigits: 2,
      }).format(total / 100);
    } catch {
      return `${(product.currency || 'EUR').toUpperCase()} ${(total / 100).toFixed(2)}`;
    }
  })();

  if (!STRIPE_CONFIGURED) {
    // Manual mode: the order is committed, so announce it now (in-app + webhook)
    // and follow up with a payment link out of band.
    await notifyAdmins(
      `New order ${order.orderNumber} — ${fmtTotal} awaiting payment`,
      `${product.title} · send a payment link and arrange fulfilment.`,
      `/admin/orders/${order.id}`,
      'ORDER_NEW',
    );
    await notifyUser(
      session.user.id,
      `Order ${order.orderNumber} received`,
      `We have your order for ${product.title}. We'll follow up with payment and delivery.`,
      `/app/orders/${order.orderNumber}`,
    );
    await sendOrderReceived(order.id);
    redirect(`/checkout/success?order=${order.orderNumber}&pending=1`);
  }

  // Stripe mode: hand off through the shared saga. It creates the session,
  // persists stripeSessionId BEFORE any redirect, and on ANY failure guarantees
  // no active payable session is left pointing at reserved/canceled stock and no
  // confirmed failure silently strands the unit (see stripe-handoff.ts).
  const stripe = getStripe();
  const baseUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  const unitAmount = product.priceCents; // narrowed to number above; capture for the closure
  const api: StripeSessionApi | null = stripe
    ? {
        create: async () => {
          const s = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'], // synchronous card-only: `completed` implies captured funds
            customer_email: session.user.email,
            line_items: [
              {
                price_data: {
                  currency: product.currency.toLowerCase(),
                  unit_amount: unitAmount,
                  product_data: { name: product.title, description: product.summary ?? undefined },
                },
                quantity: 1,
              },
            ],
            metadata: { orderId: order.id, orderNumber: order.orderNumber },
            phone_number_collection: { enabled: true },
            shipping_address_collection: {
              allowed_countries: [
                'NL', 'DE', 'FR', 'BE', 'GB', 'IE', 'ES', 'IT', 'PT', 'AT', 'CH',
                'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'US', 'CA', 'AU', 'AE',
              ],
            },
            success_url: `${baseUrl}/checkout/success?order=${order.orderNumber}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/marketplace/${product.slug}?canceled=1`,
          });
          return { id: s.id, url: s.url };
        },
        // safeExpire confirms via retrieve(status==='expired'), never message regex.
        expire: (id) => safeExpire(stripe, id),
      }
    : null;
  // CAS persist: attach the session id only while the order is still a pending,
  // unclaimed order (single winner vs a concurrent cancel/persist). Idempotent for
  // a transient-error retry (matches null OR our own sid).
  const handoff = await stripeCheckoutHandoff(prisma, api, order.id, async (sid) => {
    const r = await prisma.order.updateMany({
      where: { id: order.id, status: 'PENDING_PAYMENT', OR: [{ stripeSessionId: null }, { stripeSessionId: sid }] },
      data: { stripeSessionId: sid },
    });
    return r.count;
  });
  if (!handoff.ok) {
    await logError('startCheckout.stripe', new Error(`handoff ${handoff.reason} order=${order.orderNumber} session=${handoff.sessionId ?? 'none'}`));
    redirect(`/marketplace/${product.slug}?payment=error`);
  }
  // Handoff succeeded — stripeSessionId already persisted; announce + redirect now.
  await notifyAdmins(
    `New order ${order.orderNumber} — ${fmtTotal} awaiting payment`,
    `${product.title} · buyer is completing card payment.`,
    `/admin/orders/${order.id}`,
    'ORDER_NEW',
  );
  await notifyUser(
    session.user.id,
    `Order ${order.orderNumber} received`,
    `We have your order for ${product.title}. Complete payment to confirm.`,
    `/app/orders/${order.orderNumber}`,
  );
  redirect(handoff.url);
}
