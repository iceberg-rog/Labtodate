'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { getStripe, stripeConfigured } from '@/lib/stripe/client';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sendEmail } from '@/lib/email';
import { renderInvoiceHtml } from '@/lib/invoice';
import { audit, logError, notifyAdmins, notifyUser } from '@/lib/observability';
import { withUniqueTicketRef } from '@/lib/support/actions';

/**
 * Email the buyer (and BCC billing) a real invoice for a paid order.
 * Safe to call more than once; failures never block the order.
 */
export async function sendOrderInvoice(orderId: string): Promise<void> {
  try {
    await ensureSettingsLoaded();
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { buyer: { select: { name: true, email: true } }, items: true },
    });
    if (!order) return;
    const sa = order.shippingAddress as Record<string, unknown> | null;
    let shipTo: string | null = null;
    if (sa && typeof sa === 'object') {
      const ad = ((sa.address as Record<string, unknown>) || sa) as Record<string, unknown>;
      shipTo =
        [sa.name, ad.line1, ad.line2, ad.postal_code, ad.city, ad.state, ad.country, sa.phone]
          .filter((x) => typeof x === 'string' && (x as string).trim())
          .join(', ') || null;
    }
    const { subject, html } = renderInvoiceHtml({
      kind: 'INVOICE',
      number: order.orderNumber,
      dateISO: (order.paidAt ?? order.createdAt).toISOString(),
      currency: order.currency,
      buyer: { name: order.buyer.name, email: order.buyer.email },
      lines: order.items.map((i) => ({
        title: i.titleSnapshot,
        qty: i.quantity,
        unitCents: i.priceCentsSnapshot,
      })),
      shippingCents: order.shippingCents,
      taxCents: order.taxCents,
      status: order.status === 'PAID' ? 'PAID' : order.status.replace(/_/g, ' '),
      shipTo,
    });
    await sendEmail({ to: order.buyer.email, subject, html });
    const billing = process.env.COMPANY_EMAIL;
    if (billing) await sendEmail({ to: billing, subject: `[copy] ${subject}`, html });
  } catch (e) {
    console.error('sendOrderInvoice failed', e);
    await logError('sendOrderInvoice', e);
  }
}

/**
 * Honest "we received your order" email for the no-online-payment path.
 * No invoice is issued because nothing has been paid yet — the team
 * follows up with a secure payment link. Never blocks the order.
 */
export async function sendOrderReceived(orderId: string): Promise<void> {
  try {
    await ensureSettingsLoaded();
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { buyer: { select: { name: true, email: true } }, items: true },
    });
    if (!order) return;
    const lines = order.items
      .map((i) => `<li>${i.titleSnapshot} × ${i.quantity}</li>`)
      .join('');
    await sendEmail({
      to: order.buyer.email,
      subject: `Order ${order.orderNumber} received — bank transfer details to follow`,
      html: `<p>Hi ${order.buyer.name || 'there'},</p>
<p>We&rsquo;ve received your order <strong>${order.orderNumber}</strong>. <strong>No charge has been taken.</strong> Payment for this order is by bank transfer, manually verified by our team.</p>
<p><strong>Next steps:</strong></p>
<ol>
  <li>Our team will email you our bank-transfer details (IBAN, reference) within one business day.</li>
  <li>Send the wire for the full order amount, quoting the reference.</li>
  <li>Upload the bank receipt from your order page once the transfer is sent.</li>
  <li>An admin will verify the transfer and we will dispatch the order.</li>
</ol>
<p>Order contents:</p>
<ul>${lines}</ul>
<p>You can track everything under your account &rarr; Orders.</p>`,
    });
    const ops = process.env.SUPPORT_INTAKE_EMAIL || process.env.COMPANY_EMAIL;
    if (ops) {
      await sendEmail({
        to: ops,
        subject: `[action] New order ${order.orderNumber} — send bank-transfer details`,
        html: `<p>${order.buyer.name} (${order.buyer.email}) placed order <strong>${order.orderNumber}</strong>. Send the bank-transfer instructions (IBAN + reference) so the buyer can wire payment for manual verification.</p>`,
      });
    }
  } catch (e) {
    console.error('sendOrderReceived failed', e);
    await logError('sendOrderReceived', e);
  }
}

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
  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'DELIVERED', deliveredAt: new Date() },
  });
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

function generateOrderNumber(): string {
  const year = new Date().getFullYear();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `L2D-${year}-${rand}`;
}

/**
 * Create an order, regenerating the order number on the (rare) unique
 * collision instead of throwing an unhandled 500 at checkout.
 */
export async function createOrderWithUniqueNumber(
  data: Omit<Prisma.OrderUncheckedCreateInput, 'orderNumber'>,
) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await prisma.order.create({
        data: { ...data, orderNumber: generateOrderNumber() },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        attempt < 5
      ) {
        continue;
      }
      throw e;
    }
  }
  throw new Error('Could not allocate an order number');
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
  // "Other — request a shipping quote" → divert to the sourcing form so the
  // team can quote shipping for unusual destinations, and don't reserve stock
  // for an order that may not ship.
  if (addr.country === '__OTHER' || addr.country === 'OT') {
    redirect(`/let-us-find-it?slug=${encodeURIComponent(productSlug)}&reason=shipping`);
  }

  const missing: string[] = [];
  if (!addr.name) missing.push('name');
  if (!addr.phone) missing.push('phone');
  if (!addr.line1) missing.push('line1');
  if (!addr.city) missing.push('city');
  if (!addr.postal) missing.push('postal');
  if (addr.country.length !== 2) missing.push('country');
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

  // Atomically reserve the unit so the same used item can't be sold twice.
  const res = await prisma.product.updateMany({
    where: { id: product.id, quantity: { gte: 1 } },
    data: { quantity: { decrement: 1 } },
  });
  if (res.count !== 1) {
    redirect(`/marketplace/${productSlug}?sold=1`);
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

  const order = await createOrderWithUniqueNumber({
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
    items: {
      create: {
        productId: product.id,
        titleSnapshot: product.title,
        brandSnapshot: product.brand?.name ?? null,
        priceCentsSnapshot: product.priceCents,
        quantity: 1,
      },
    },
  });

  // Operator + buyer must find out a sale happened — in-app + webhook.
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

  if (!STRIPE_CONFIGURED) {
    // No online payment provider configured: record the order as awaiting
    // payment (NOT paid) and let the team follow up with a payment link.
    await sendOrderReceived(order.id);
    redirect(`/checkout/success?order=${order.orderNumber}&pending=1`);
  }

  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  const baseUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  let checkout;
  try {
    checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: session.user.email,
      line_items: [
        {
          price_data: {
            currency: product.currency.toLowerCase(),
            unit_amount: product.priceCents,
            product_data: {
              name: product.title,
              description: product.summary ?? undefined,
            },
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
  } catch (e) {
    // Stripe failed to start — don't strand the order or the reserved unit.
    await prisma.product.update({
      where: { id: product.id },
      data: { quantity: { increment: 1 } },
    });
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELED' } });
    logError('startCheckout.stripe', e);
    redirect(`/marketplace/${product.slug}?payment=error`);
  }

  await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: checkout.id } });
  if (!checkout.url) throw new Error('Stripe session URL missing');
  redirect(checkout.url);
}
