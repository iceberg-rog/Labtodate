import type { FiscalDocument } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingString } from '@/lib/settings';
import { companyCopyAddress, sendInternalEmail, trySendEmail, type EmailAttachment } from '@/lib/email';
import { escapeHtml, escapeHtmlLines } from '@/lib/email-html';
import { logError } from '@/lib/observability';
import { currentProforma, documentAttachment, issueProforma, reissueProforma, snapshotOf, type IssueFailCode } from '@/lib/documents/issue';
import { vatTreatmentWithRate } from '@/lib/tax/determine';
import { formatPrice } from '@/lib/utils';
import { fmtDueDate } from '@/lib/orders/payment-due';
import { mailLayout, mailTable, siteBase } from '@/lib/quotes/mail';
import { mailOrderDocument } from '@/lib/orders/internal';

/**
 * Checkout emails — every sentence states what is actually true for THIS
 * order: a payable order gets its proforma (bank details, reference, total,
 * pay-by date — all read from the issued proforma); an order on hold is told
 * exactly what is open and that nothing is due yet; a released hold gets the
 * final total and the proforma. One branded layout (mailLayout). The proforma
 * goes to the order's document recipients (accounts-payable address, always a
 * copy to the account that ordered — lib/orders/internal.ts mailOrderDocument
 * `alwaysCopyAccount`: these are order confirmations, not only documents) and
 * is marked sent.
 * Consumers (customerType CONSUMER) also get the withdrawal information
 * (CONSUMER_WITHDRAWAL_TEXT).
 */

const HOLD_TITLE: Record<string, string> = {
  COMPLIANCE: 'Export compliance review',
  VAT_REVIEW: 'VAT to be confirmed',
  ADDRESS_REVIEW: 'Address change under review',
  SHIPPING_PENDING: 'Shipping cost to be confirmed',
  PAYMENT_REVIEW: 'Payment under review',
  // Paid order: the invoice is withheld; unpaid order: the proforma waits for the seller's details.
  INVOICE_PENDING: 'Proforma / invoice not issued yet',
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
  const money = (c: number) => escapeHtml(formatPrice(c, cur));
  const vatText = opts.vatPending
    ? 'to be confirmed'
    : `${money(o.taxCents)}${o.vatTreatment ? ` (${escapeHtml(vatTreatmentWithRate(o.vatTreatment, o.vatRateBp))})` : ''}`;
  return mailTable([
    ...o.items.map((i): [string, string] => [`<span dir="auto">${escapeHtml(i.titleSnapshot)}</span> — ${i.quantity} × ${money(i.priceCentsSnapshot)}`, money(i.priceCentsSnapshot * i.quantity)]),
    [o.vatTreatment === 'MARGIN_SCHEME' ? 'Subtotal (margin scheme: VAT included, not shown)' : 'Subtotal (excl. VAT)', money(o.subtotalCents)],
    ['Shipping', opts.shippingPending ? 'to be confirmed' : o.shippingCents ? money(o.shippingCents) : 'free'],
    ['VAT', vatText],
    [opts.shippingPending || opts.vatPending ? 'Total so far' : 'Total to pay', money(o.totalCents), true],
  ]);
}

/** How to pay — exactly what the issued proforma says (bank, reference, amount, pay-by date). */
function payBlock(pf: FiscalDocument): string {
  const snap = snapshotOf(pf);
  const b = snap.bank;
  const due = pf.dueDate ?? (snap.dueDate ? new Date(snap.dueDate) : null);
  const mono = (v: string) => `<span style="font-family:ui-monospace,monospace;">${escapeHtml(v)}</span>`;
  const rows: Array<[string, string, boolean?]> = [
    ['Amount', escapeHtml(formatPrice(snap.totals.totalCents, pf.currency)), true],
    ...(b
      ? [
          ['Beneficiary', `<span dir="auto">${escapeHtml(b.beneficiary)}</span>`] as [string, string],
          ...(b.bankName ? [['Bank', `<span dir="auto">${escapeHtml(b.bankName)}</span>`] as [string, string]] : []),
          ['IBAN', mono(b.iban)] as [string, string],
          ...(b.bic ? [['BIC', mono(b.bic)] as [string, string]] : []),
        ]
      : []),
    ['Reference', `<strong>${escapeHtml(pf.number)}</strong>`],
    ...(due ? [['Pay by', `<strong>${escapeHtml(fmtDueDate(due))}</strong>`] as [string, string]] : []),
  ];
  return `<h3 style="color:#0E4F40;margin:16px 0 6px;font-size:15px;">Pay by bank transfer</h3>${mailTable(rows)}`;
}

/** Consumers: the withdrawal right in the order confirmation (EU consumer law). */
function withdrawalBlock(o: OrderForMail): string {
  if (o.customerType !== 'CONSUMER') return '';
  const text = settingString('CONSUMER_WITHDRAWAL_TEXT').trim();
  if (!text) return '';
  return `<div style="margin:16px 0 12px;padding:10px 12px;border-radius:8px;background:#f9fafb;border:1px solid #e5e7eb;font-size:13px;"><p style="margin:0 0 6px;font-weight:700;">Your right of withdrawal</p><p style="margin:0;">${escapeHtmlLines(text)}</p></div>`;
}

type ProformaForMail = { doc: FiscalDocument | null; attachment: EmailAttachment | null; note: string | null; code: IssueFailCode | null };

async function proformaFor(orderId: string): Promise<ProformaForMail> {
  // A proforma issued before the total changed (freight / VAT / address) is
  // replaced by a revision — the buyer must never pay a stale amount. The same
  // when the payment term restarted (hold released): the printed due date must
  // be the one the reminders and the auto-cancel sweep use (Order.dueAt), and
  // for a proforma issued without bank details (before they were required).
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
  const staleBank = !!current && !snapshotOf(current).bank;
  const pf = staleTotal || staleDue || staleDetails || staleBank
    ? await reissueProforma(orderId, staleTotal ? 'Final total confirmed (shipping / VAT / address)' : staleDetails ? 'Billing / delivery details updated' : staleBank ? 'Bank details added' : 'Payable now — the payment term starts today (hold released)')
    : await issueProforma(orderId);
  if (!pf.ok) return { doc: null, attachment: null, note: pf.message, code: pf.code };
  const att = await documentAttachment(pf.document);
  if (att.error) await logError('checkout.proforma.pdf', new Error(att.error));
  return { doc: pf.document, attachment: att.attachment, note: null, code: null };
}

/** No proforma could be issued: the sentence that is true instead (the order page always has the state). */
function noProformaText(o: OrderForMail, pf: ProformaForMail): string {
  if (pf.code === 'SELLER_INCOMPLETE') {
    return '<strong>Nothing is due yet</strong> — please do not transfer any money for this order yet. We email you the proforma invoice (payment request) with our bank details as soon as it is ready.';
  }
  if (pf.code === 'MISSING_DETAILS') {
    return `Please add your billing and delivery details on your <a href="${siteBase()}/app/orders/${o.orderNumber}/payment">payment page</a> — the proforma invoice (payment request) is issued as soon as they are complete.`;
  }
  return `Your proforma invoice (payment request, with the bank details and the transfer reference) is on your <a href="${siteBase()}/app/orders/${o.orderNumber}/payment">payment page</a>.`;
}

/**
 * A payable bank-transfer order: proforma attached, bank details, next steps.
 * `code`: why no proforma was issued (SELLER_INCOMPLETE: the order is on the
 * INVOICE_PENDING hold — nothing is due), null when it was.
 */
export async function sendCheckoutConfirmation(orderId: string): Promise<{ emailed: boolean; proforma: string | null; code: IssueFailCode | null }> {
  try {
    await ensureSettingsLoaded();
    const o = await loadOrder(orderId);
    if (!o) return { emailed: false, proforma: null, code: 'NOT_FOUND' };
    const pf = await proformaFor(o.id);
    const base = siteBase();
    const paymentPage = `${base}/app/orders/${o.orderNumber}/payment`;
    const greeting = `Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,`;
    const footer = [`${o.poNumber ? `Your PO number: ${escapeHtml(o.poNumber)} · ` : ''}<a href="${base}/app/orders/${o.orderNumber}">View your order</a>`];
    let sent: { emailed: boolean };
    if (pf.doc) {
      const html = mailLayout({
        heading: `Order ${o.orderNumber} received`,
        body: [
          greeting,
          `Thank you for your order. <strong>No payment has been taken yet.</strong> Please pay by bank transfer by <strong>${escapeHtml(fmtDueDate(pf.doc.dueDate ?? o.dueAt ?? new Date()))}</strong>; we dispatch once your payment is received and verified.`,
          totalsTable(o, { shippingPending: false, vatPending: false }),
          payBlock(pf.doc),
          pf.attachment ? `Your proforma invoice <strong>${escapeHtml(pf.doc.number)}</strong> is attached (PDF).` : `Your proforma invoice <strong>${escapeHtml(pf.doc.number)}</strong> is on your payment page.`,
          'After the transfer, upload the bank receipt on your payment page — it speeds up the verification.',
          withdrawalBlock(o),
        ].filter(Boolean),
        cta: { href: paymentPage, label: 'Go to the payment page' },
        footer,
      });
      const subject = `Order ${o.orderNumber} received — pay ${formatPrice(o.totalCents, o.currency)} by bank transfer (proforma ${pf.doc.number})`;
      // The order confirmation (withdrawal information included): the account that ordered always gets it too.
      sent = await mailOrderDocument({ doc: pf.doc, order: o, subject, html, attachment: pf.attachment, context: 'checkout:confirmation', alwaysCopyAccount: true });
    } else {
      const html = mailLayout({
        heading: `Order ${o.orderNumber} received`,
        body: [
          greeting,
          `Thank you for your order. <strong>No payment has been taken yet.</strong>`,
          totalsTable(o, { shippingPending: false, vatPending: false }),
          noProformaText(o, pf),
          withdrawalBlock(o),
        ].filter(Boolean),
        cta: { href: `${base}/app/orders/${o.orderNumber}`, label: 'View your order' },
        footer,
      });
      const r = await trySendEmail({ to: o.buyer.email, subject: `Order ${o.orderNumber} received`, html }, 'checkout:confirmation');
      sent = { emailed: r.ok };
    }
    const ops = process.env.SUPPORT_INTAKE_EMAIL || companyCopyAddress();
    if (ops) {
      await sendInternalEmail({
        to: ops,
        subject: `[order] ${o.orderNumber} — ${formatPrice(o.totalCents, o.currency)} ${pf.doc ? 'awaiting bank transfer' : 'received, no proforma yet'}`,
        html: `<p>${escapeHtml(o.buyer.name)} (${escapeHtml(o.buyer.email)}) placed order <strong>${o.orderNumber}</strong>${pf.doc ? ` (proforma ${escapeHtml(pf.doc.number)})` : ''}.</p>${pf.note ? `<p>${escapeHtml(pf.note)}</p>` : ''}<p><a href="${base}/admin/orders/${o.id}">Open the order</a></p>`,
      }, 'checkout:confirmation-ops');
    }
    return { emailed: sent.emailed, proforma: pf.doc?.number ?? null, code: pf.code };
  } catch (e) {
    await logError('checkout.sendCheckoutConfirmation', e);
    return { emailed: false, proforma: null, code: 'ERROR' };
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
    const html = mailLayout({
      heading: `Order ${o.orderNumber} received — total to be confirmed`,
      body: [
        `Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,`,
        'Thank you for your order. The items are reserved for you. <strong>Nothing is due yet</strong> — please do not transfer any money for this order until we send you the final total.',
        `<ul style="margin:0 0 12px;padding-left:20px;">${messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`,
        totalsTable(o, { shippingPending: holds.includes('SHIPPING_PENDING'), vatPending: holds.includes('VAT_REVIEW') }),
        `You will receive an email with the final total and the payment details as soon as our team has completed the open point${holds.length > 1 ? 's' : ''}.`,
        withdrawalBlock(o),
      ].filter(Boolean),
      cta: { href: `${base}/app/orders/${o.orderNumber}`, label: 'View your order' },
    });
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

export interface HoldReleasedMail {
  emailed: boolean;
  proforma: string | null;
  note: string | null;
  /**
   * Why no proforma was issued, null when it was. SELLER_INCOMPLETE: the
   * seller's details are incomplete — the order is back on a pre-payment hold
   * (INVOICE_PENDING), not payable, and no mail was sent.
   */
  code: IssueFailCode | null;
}

/**
 * Every hold is resolved: the final total and the proforma. No mail when the
 * proforma still can not be issued because the seller's details are
 * incomplete (the order is back on hold; the buyer was told nothing is due).
 */
export async function sendHoldReleased(orderId: string): Promise<HoldReleasedMail> {
  try {
    await ensureSettingsLoaded();
    const o = await loadOrder(orderId);
    if (!o) return { emailed: false, proforma: null, note: 'order not found', code: 'NOT_FOUND' };
    const pf = await proformaFor(o.id);
    if (pf.code === 'SELLER_INCOMPLETE') return { emailed: false, proforma: null, note: pf.note, code: pf.code };
    const base = siteBase();
    const html = mailLayout({
      heading: `Order ${o.orderNumber} confirmed — final total`,
      body: [
        `Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,`,
        pf.doc
          ? `We completed the open points of your order. This is the final total; you can now pay — by <strong>${escapeHtml(fmtDueDate(pf.doc.dueDate ?? o.dueAt ?? new Date()))}</strong>.`
          : 'We completed the open points of your order. This is the final total.',
        totalsTable(o, { shippingPending: false, vatPending: false }),
        pf.doc ? payBlock(pf.doc) : noProformaText(o, pf),
        pf.doc ? (pf.attachment ? `Your proforma invoice <strong>${escapeHtml(pf.doc.number)}</strong> is attached (PDF).` : `Your proforma invoice <strong>${escapeHtml(pf.doc.number)}</strong> is on your payment page.`) : '',
        pf.doc ? 'After the transfer, upload the bank receipt on your payment page.' : '',
        withdrawalBlock(o),
      ].filter(Boolean),
      cta: { href: `${base}/app/orders/${o.orderNumber}/payment`, label: 'Go to the payment page' },
    });
    const subject = `Order ${o.orderNumber}: final total ${formatPrice(o.totalCents, o.currency)} — ready for payment${pf.doc ? ` (proforma ${pf.doc.number})` : ''}`;
    // "You can now pay" is an order update: the account that ordered always gets it too.
    const sent = pf.doc
      ? await mailOrderDocument({ doc: pf.doc, order: o, subject, html, attachment: pf.attachment, context: 'checkout:hold-released', alwaysCopyAccount: true })
      : await trySendEmail({ to: o.buyer.email, subject, html }, 'checkout:hold-released').then((r) => ({ emailed: r.ok }));
    return { emailed: sent.emailed, proforma: pf.doc?.number ?? null, note: pf.note, code: pf.code };
  } catch (e) {
    await logError('checkout.sendHoldReleased', e);
    return { emailed: false, proforma: null, note: e instanceof Error ? e.message : String(e), code: 'ERROR' };
  }
}
