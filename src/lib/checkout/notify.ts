import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingString } from '@/lib/settings';
import { companyCopyAddress, sendInternalEmail, trySendEmail, type EmailAttachment } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { logError } from '@/lib/observability';
import { currentProforma, documentAttachment, issueProforma, reissueProforma } from '@/lib/documents/issue';
import { absoluteDocumentHref } from '@/lib/documents';
import { vatTreatmentWithRate } from '@/lib/tax/determine';
import { formatPrice } from '@/lib/utils';

/**
 * Checkout emails — every sentence states what is actually true for THIS
 * order: a payable order gets its proforma (bank details, reference, total);
 * an order on hold is told exactly what is open and that nothing is due yet;
 * a released hold gets the final total and the proforma.
 */

function siteBase(): string {
  return (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
}

const HOLD_TITLE: Record<string, string> = {
  COMPLIANCE: 'Export compliance review',
  VAT_REVIEW: 'VAT to be confirmed',
  ADDRESS_REVIEW: 'Address change under review',
  SHIPPING_PENDING: 'Shipping cost to be confirmed',
  PAYMENT_REVIEW: 'Payment under review',
  INVOICE_PENDING: 'Invoice not issued yet',
  STOCK_SHORTAGE: 'Stock to be confirmed',
  SUPPLIER_CONFIRMATION: 'Supplier confirmation',
  FRAUD: 'Security check',
};
export const holdTitle = (code: string | null | undefined) => (code ? HOLD_TITLE[code] ?? code : '');

type OrderForMail = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

async function loadOrder(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { buyer: { select: { name: true, email: true } }, items: true },
  });
}

function totalsTable(o: OrderForMail, opts: { shippingPending: boolean; vatPending: boolean }): string {
  const cur = o.currency;
  const row = (label: string, value: string, bold = false) =>
    `<tr><td style="padding:4px 12px 4px 0;${bold ? 'font-weight:700;' : 'color:#374151;'}">${label}</td><td style="padding:4px 0;text-align:right;${bold ? 'font-weight:700;' : ''}">${value}</td></tr>`;
  const items = o.items
    .map((i) => row(`${escapeHtml(i.titleSnapshot)} — ${i.quantity} × ${formatPrice(i.priceCentsSnapshot, cur)}`, formatPrice(i.priceCentsSnapshot * i.quantity, cur)))
    .join('');
  const vatText = opts.vatPending
    ? 'to be confirmed'
    : `${formatPrice(o.taxCents, cur)}${o.vatTreatment ? ` (${escapeHtml(vatTreatmentWithRate(o.vatTreatment, o.vatRateBp))})` : ''}`;
  return `<table style="border-collapse:collapse;font-size:14px;min-width:320px;">
${items}
${row(o.vatTreatment === 'MARGIN_SCHEME' ? 'Subtotal (margin scheme: VAT included, not shown)' : 'Subtotal (excl. VAT)', formatPrice(o.subtotalCents, cur))}
${row('Shipping', opts.shippingPending ? 'to be confirmed' : o.shippingCents ? formatPrice(o.shippingCents, cur) : 'free')}
${row('VAT', vatText)}
${row(opts.shippingPending || opts.vatPending ? 'Total so far' : 'Total to pay', formatPrice(o.totalCents, cur), true)}
</table>`;
}

function bankBlock(reference: string, amountCents: number, currency: string): string {
  const iban = settingString('BANK_IBAN');
  if (!iban) return '<p>Our team sends you the bank details for this order.</p>';
  const name = settingString('COMPANY_LEGAL_NAME') || settingString('SITE_NAME');
  return `<p style="margin:12px 0 4px;"><strong>Pay by bank transfer</strong></p>
<table style="font-size:14px;border-collapse:collapse;">
<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Amount</td><td><strong>${formatPrice(amountCents, currency)}</strong></td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Beneficiary</td><td>${escapeHtml(name)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">IBAN</td><td>${escapeHtml(iban)}</td></tr>
${settingString('BANK_SWIFT') ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">BIC</td><td>${escapeHtml(settingString('BANK_SWIFT'))}</td></tr>` : ''}
<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Reference</td><td><strong>${escapeHtml(reference)}</strong></td></tr>
</table>`;
}

async function proformaFor(orderId: string): Promise<{ number: string | null; attachment: EmailAttachment | null; note: string | null }> {
  // A proforma issued before the total changed (freight / VAT / address) is
  // replaced by a revision — the buyer must never pay a stale amount. The same
  // when the payment term restarted (hold released): the printed due date must
  // be the one the reminders and the auto-cancel sweep use (Order.dueAt).
  const [order, current] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId }, select: { totalCents: true, dueAt: true } }),
    currentProforma(prisma, orderId),
  ]);
  const staleTotal = !!current && !!order && current.totalCents !== order.totalCents;
  const staleDue = !!current && !!order?.dueAt && (!current.dueDate || current.dueDate.getTime() !== order.dueAt.getTime());
  // Billing / delivery details changed after the proforma was issued (e.g. staff
  // moved the destination while the order was on hold — no revision is issued
  // while a pre-payment hold is open): every change is an AddressChange row.
  const staleDetails = !!current && (await prisma.addressChange.count({ where: { orderId, createdAt: { gt: current.createdAt } } })) > 0;
  const pf = staleTotal || staleDue || staleDetails
    ? await reissueProforma(orderId, staleTotal ? 'Final total confirmed (shipping / VAT / address)' : staleDetails ? 'Billing / delivery details updated' : 'Payable now — the payment term starts today (hold released)')
    : await issueProforma(orderId);
  if (!pf.ok) return { number: null, attachment: null, note: pf.message };
  const att = await documentAttachment(pf.document);
  if (att.error) await logError('checkout.proforma.pdf', new Error(att.error));
  return { number: pf.document.number, attachment: att.attachment, note: null };
}

/** A payable bank-transfer order: proforma attached, bank details, next steps. */
export async function sendCheckoutConfirmation(orderId: string): Promise<{ emailed: boolean; proforma: string | null }> {
  try {
    await ensureSettingsLoaded();
    const o = await loadOrder(orderId);
    if (!o) return { emailed: false, proforma: null };
    const pf = await proformaFor(o.id);
    const base = siteBase();
    const reference = pf.number ?? o.orderNumber;
    const html = `<div style="font-family:system-ui,sans-serif;max-width:600px;">
<h2 style="color:#0E4F40;">Order ${o.orderNumber} received</h2>
<p>Hi ${escapeHtml(o.buyer.name || 'there')},</p>
<p>Thank you for your order. <strong>No payment has been taken yet.</strong> Please pay by bank transfer; we dispatch once your payment is received and verified.</p>
${totalsTable(o, { shippingPending: false, vatPending: false })}
${bankBlock(reference, o.totalCents, o.currency)}
${pf.attachment ? `<p>Your proforma invoice <strong>${escapeHtml(pf.number ?? '')}</strong> is attached (PDF).</p>` : pf.number ? `<p><a href="${absoluteDocumentHref('proforma', o.orderNumber, 'pdf')}">Download your proforma invoice ${escapeHtml(pf.number)}</a>.</p>` : ''}
<p>After the transfer, upload the bank receipt on your <a href="${base}/app/orders/${o.orderNumber}/payment">payment page</a> — it speeds up the verification.</p>
<p style="color:#6b7280;font-size:12px;">${o.poNumber ? `Your PO number: ${escapeHtml(o.poNumber)} · ` : ''}<a href="${base}/app/orders/${o.orderNumber}">View your order</a></p>
</div>`;
    const subject = `Order ${o.orderNumber} received — pay ${formatPrice(o.totalCents, o.currency)} by bank transfer`;
    const sent = await trySendEmail({ to: o.buyer.email, subject, html, attachments: pf.attachment ? [pf.attachment] : [] }, 'checkout:confirmation');
    const ops = process.env.SUPPORT_INTAKE_EMAIL || companyCopyAddress();
    if (ops) {
      await sendInternalEmail({
        to: ops,
        subject: `[order] ${o.orderNumber} — ${formatPrice(o.totalCents, o.currency)} awaiting bank transfer`,
        html: `<p>${escapeHtml(o.buyer.name)} (${escapeHtml(o.buyer.email)}) placed order <strong>${o.orderNumber}</strong>${pf.number ? ` (proforma ${escapeHtml(pf.number)})` : ''}.</p><p><a href="${base}/admin/orders/${o.id}">Open the order</a></p>`,
      }, 'checkout:confirmation-ops');
    }
    return { emailed: sent.ok, proforma: pf.number };
  } catch (e) {
    await logError('checkout.sendCheckoutConfirmation', e);
    return { emailed: false, proforma: null };
  }
}

/** An order on hold: what is open, that nothing is due, what happens next. */
export async function sendCheckoutOnHold(orderId: string, messages: string[]): Promise<boolean> {
  try {
    await ensureSettingsLoaded();
    const o = await loadOrder(orderId);
    if (!o) return false;
    const base = siteBase();
    const holds = o.openHolds;
    const html = `<div style="font-family:system-ui,sans-serif;max-width:600px;">
<h2 style="color:#0E4F40;">Order ${o.orderNumber} received — total to be confirmed</h2>
<p>Hi ${escapeHtml(o.buyer.name || 'there')},</p>
<p>Thank you for your order. The items are reserved for you. <strong>Nothing is due yet</strong> — please do not transfer any money for this order until we send you the final total.</p>
<ul>${messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
${totalsTable(o, { shippingPending: holds.includes('SHIPPING_PENDING'), vatPending: holds.includes('VAT_REVIEW') })}
<p>You will receive an email with the final total and the payment details as soon as our team has completed the open point${holds.length > 1 ? 's' : ''}.</p>
<p style="color:#6b7280;font-size:12px;"><a href="${base}/app/orders/${o.orderNumber}">View your order</a></p>
</div>`;
    const sent = await trySendEmail({ to: o.buyer.email, subject: `Order ${o.orderNumber} received — we confirm the final total before payment`, html }, 'checkout:on-hold');
    const ops = process.env.SUPPORT_INTAKE_EMAIL || companyCopyAddress();
    if (ops) {
      await sendInternalEmail({
        to: ops,
        subject: `[action] Order ${o.orderNumber} on hold — ${holds.map(holdTitle).join(', ')}`,
        html: `<p>Order <strong>${o.orderNumber}</strong> needs: ${holds.map((h) => escapeHtml(holdTitle(h))).join(', ')}.</p><p>${escapeHtml(o.holdNote ?? '')}</p><p><a href="${base}/admin/orders/${o.id}">Open the order</a></p>`,
      }, 'checkout:on-hold-ops');
    }
    return sent.ok;
  } catch (e) {
    await logError('checkout.sendCheckoutOnHold', e);
    return false;
  }
}

/** Every hold is resolved: the final total and the proforma. */
export async function sendHoldReleased(orderId: string): Promise<{ emailed: boolean; proforma: string | null; note: string | null }> {
  try {
    await ensureSettingsLoaded();
    const o = await loadOrder(orderId);
    if (!o) return { emailed: false, proforma: null, note: 'order not found' };
    const pf = await proformaFor(o.id);
    const base = siteBase();
    const reference = pf.number ?? o.orderNumber;
    const html = `<div style="font-family:system-ui,sans-serif;max-width:600px;">
<h2 style="color:#0E4F40;">Order ${o.orderNumber} confirmed — final total</h2>
<p>Hi ${escapeHtml(o.buyer.name || 'there')},</p>
<p>We completed the open points of your order. This is the final total; you can now pay.</p>
${totalsTable(o, { shippingPending: false, vatPending: false })}
${bankBlock(reference, o.totalCents, o.currency)}
${pf.attachment ? `<p>Your proforma invoice <strong>${escapeHtml(pf.number ?? '')}</strong> is attached (PDF).</p>` : ''}
<p>After the transfer, upload the bank receipt on your <a href="${base}/app/orders/${o.orderNumber}/payment">payment page</a>.</p>
</div>`;
    const sent = await trySendEmail({
      to: o.buyer.email,
      subject: `Order ${o.orderNumber}: final total ${formatPrice(o.totalCents, o.currency)} — ready for payment`,
      html,
      attachments: pf.attachment ? [pf.attachment] : [],
    }, 'checkout:hold-released');
    return { emailed: sent.ok, proforma: pf.number, note: pf.note };
  } catch (e) {
    await logError('checkout.sendHoldReleased', e);
    return { emailed: false, proforma: null, note: e instanceof Error ? e.message : String(e) };
  }
}
