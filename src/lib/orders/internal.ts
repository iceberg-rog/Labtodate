import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { renderInvoiceHtml } from '@/lib/invoice';
import { logError } from '@/lib/observability';
import { generateOrderNumber } from '@/lib/orders/checkout-tx';

/**
 * Server-internal order helpers. Deliberately NOT a 'use server' module: every
 * export of a 'use server' file becomes a callable Server Action endpoint, and
 * none of these check a session — they take an arbitrary order id (or a raw
 * Prisma create input) from trusted server code only. Import them from server
 * actions / route handlers; never from a client component.
 */

function siteBase(): string {
  return (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
}

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
      .map((i) => `<li>${escapeHtml(i.titleSnapshot)} × ${i.quantity}</li>`)
      .join('');
    const base = siteBase();
    // Direct links so the buyer can reach the payment workspace (bank details +
    // receipt upload) and ops can open the order without searching for it.
    const paymentUrl = `${base}/app/orders/${order.orderNumber}/payment`;
    const orderUrl = `${base}/app/orders/${order.orderNumber}`;
    await sendEmail({
      to: order.buyer.email,
      subject: `Order ${order.orderNumber} received — bank transfer details to follow`,
      html: `<p>Hi ${escapeHtml(order.buyer.name || 'there')},</p>
<p>We&rsquo;ve received your order <strong>${order.orderNumber}</strong>. <strong>No charge has been taken.</strong> Payment for this order is by bank transfer, manually verified by our team.</p>
<p><strong>Next steps:</strong></p>
<ol>
  <li>Our team will email you our bank-transfer details (IBAN, reference) within one business day.</li>
  <li>Send the wire for the full order amount, quoting the reference.</li>
  <li>Upload the bank receipt from your <a href="${paymentUrl}">order payment page</a> once the transfer is sent.</li>
  <li>An admin will verify the transfer and we will dispatch the order.</li>
</ol>
<p>Order contents:</p>
<ul>${lines}</ul>
<p style="margin:18px 0;"><a href="${paymentUrl}" style="background:#0E4F40;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Pay &amp; upload receipt</a></p>
<p>You can track everything on your <a href="${orderUrl}">order page</a>.</p>`,
    });
    const ops = process.env.SUPPORT_INTAKE_EMAIL || process.env.COMPANY_EMAIL;
    if (ops) {
      await sendEmail({
        to: ops,
        subject: `[action] New order ${order.orderNumber} — send bank-transfer details`,
        html: `<p>${escapeHtml(order.buyer.name)} (${escapeHtml(order.buyer.email)}) placed order <strong>${order.orderNumber}</strong>. Send the bank-transfer instructions (IBAN + reference) so the buyer can wire payment for manual verification.</p>
<p><a href="${base}/admin/orders/${order.id}">Open the order in admin</a></p>`,
      });
    }
  } catch (e) {
    console.error('sendOrderReceived failed', e);
    await logError('sendOrderReceived', e);
  }
}

/**
 * Create a standalone order (no stock reservation — used by the quote/proforma
 * path), regenerating the order number on the (rare) unique collision instead of
 * throwing an unhandled 500. Each attempt is its own implicit transaction, so a
 * P2002 on one create never poisons the next. Reserving checkout paths use
 * reserveAndCreateOrder (transactional) instead.
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
