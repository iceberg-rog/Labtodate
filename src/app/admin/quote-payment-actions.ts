'use server';

import { revalidatePath } from 'next/cache';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { hasCapability, requireCapability } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { trySendEmail } from '@/lib/email';
import { escapeHtml, escapeHtmlLines } from '@/lib/email-html';
import { audit, notifyAdmins, notifyUser } from '@/lib/observability';
import { formatPrice } from '@/lib/utils';
import { fmtDocMoney } from '@/lib/documents/render';
import { recordPayment } from '@/lib/payments/ledger';
import { documentAttachment, getOrderDocuments, markDocumentSent, reissueProforma, voidProformas } from '@/lib/documents/issue';
import { sendOrderInvoice, invoiceMailSummary } from '@/lib/orders/internal';
import { orderDetailsProblems, parseDetailsInput } from '@/lib/orders/details';
import { saveOrderDetails } from '@/lib/orders/details-server';
import { effectiveDueDate, endOfDayUtc, fmtDueDate } from '@/lib/orders/payment-due';
import { creditStatusFor } from '@/lib/credit/terms';
import { cancelQuoteOrder, cancelSummary } from '@/lib/quotes/cancel';
import { cancelPaidOrder } from '@/lib/fulfilment/cancel';
import { consumeQuoteHold, holdUnitForQuote } from '@/lib/quotes/stock';
import { creditDefaults, paymentTermDays, stockReserveOn, vatIdRule } from '@/lib/quotes/policy';
import { mailLayout, siteBase } from '@/lib/quotes/mail';
import { clearComplianceHold as clearComplianceHoldCore } from '@/lib/checkout/holds';

/**
 * Staff actions for the quote / payment area (credit terms, deal
 * cancellation, order details, compliance hold, due date). Every action checks
 * its capability, reports what really happened (incl. whether the buyer was
 * emailed) and is audited.
 */

type Result = { ok: boolean; message: string; fieldErrors?: Record<string, string> };

const euros = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? '').replace(/[€\s]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

function refresh(orderId: string, quoteId?: string | null) {
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
  if (quoteId) {
    revalidatePath(`/admin/quotes/${quoteId}`);
    revalidatePath('/admin/quotes');
    revalidatePath(`/app/quotes/${quoteId}`);
  }
}

// ── Deal cancellation (owner report 6) ───────────────────────────────────────

/**
 * Cancel the deal of a quote order, whatever its stage, by the proper path:
 *  - unpaid → cancel + void proforma + release the unit + email the buyer;
 *  - approved on invoice terms, not (fully) paid, nothing shipped → credit note
 *    for the invoice + cancel (a part that was paid is refunded);
 *  - receipt waiting → refuse (verify or reject it first);
 *  - paid → refuse here: “Cancel & refund” on the order page (credit note + refund ledger).
 */
export async function adminCancelQuoteOrder(formData: FormData): Promise<Result> {
  const session = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  await ensureSettingsLoaded();
  const orderId = String(formData.get('orderId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 300);
  if (reason.length < 4) return { ok: false, message: 'Give the reason (at least 4 characters) — it goes to the buyer and on the order.' };
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, status: true, financialStatus: true, amountPaidCents: true, totalCents: true, paymentSubmittedAt: true, sourcingRequestId: true, shippedAt: true, stripePaymentIntentId: true },
  });
  if (!o) return { ok: false, message: 'Order not found.' };
  // Approved on invoice terms and not fully paid (nothing, or part paid), nothing
  // shipped: the invoice is credited in full through THE refund / credit core
  // (lib/fulfilment/cancel.ts → lib/finance/refunds.ts) — the unpaid part is no
  // longer due (no money refund for it), a part that was paid is refunded through
  // the refund ledger (REQUESTED until staff send it), the quote is closed.
  const onTermsOpen = ['INVOICED_ON_TERMS', 'OVERDUE', 'PARTIALLY_PAID'].includes(o.financialStatus) && o.amountPaidCents < o.totalCents;
  const onTermsUnpaid = onTermsOpen && o.amountPaidCents === 0;
  if (onTermsOpen && !o.shippedAt && (o.status === 'PROCESSING' || o.status === 'PAID')) {
    // Money moves only when part was paid: that needs the refund permission.
    if (o.amountPaidCents > 0 && !(await hasCapability('orders:refund'))) return { ok: false, message: 'Part of this invoice was paid: canceling refunds that part — that needs the “Refund and cancel paid orders” permission.' };
    const r = await cancelPaidOrder(
      { orderId: o.id, reason, method: o.amountPaidCents > 0 ? (o.stripePaymentIntentId ? 'STRIPE' : 'BANK_TRANSFER') : null },
      { id: session.user.id, email: session.user.email },
    );
    refresh(o.id, o.sourcingRequestId);
    return r;
  }
  if (!o.sourcingRequestId) return { ok: false, message: 'Not a quote order — use the order actions.' };
  if (o.status === 'PENDING_PAYMENT') {
    const r = await cancelQuoteOrder(o.id, { kind: 'STAFF', id: session.user.id, email: session.user.email }, { reason, lostReason: 'Canceled by lab2date after acceptance' });
    refresh(o.id, o.sourcingRequestId);
    return r.ok ? { ok: true, message: cancelSummary(r, 'STAFF') } : { ok: false, message: r.message };
  }
  if (o.status === 'CANCELED') return { ok: false, message: `Order ${o.orderNumber} is already canceled.` };
  if (o.status === 'REFUNDED') return { ok: false, message: `Order ${o.orderNumber} is already refunded.` };
  return {
    ok: false,
    message: onTermsUnpaid
      ? `Order ${o.orderNumber} was already shipped on invoice terms — handle it as a return (RMA) with a credit note on the order page.`
      : `Order ${o.orderNumber} is paid (${o.status.toLowerCase()}) — use “Cancel & refund” on the order page: it credits the invoice and records the refund.`,
  };
}

// ── Credit terms (B07 minimal) ───────────────────────────────────────────────

export async function approveBuyerCredit(formData: FormData): Promise<Result> {
  const session = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  await ensureSettingsLoaded();
  const userId = String(formData.get('userId') ?? '');
  const limit = euros(formData.get('limit'));
  const days = Number(formData.get('termDays') ?? creditDefaults().termDays);
  const note = String(formData.get('note') ?? '').trim().slice(0, 300) || null;
  if (!Number.isFinite(limit) || limit <= 0) return { ok: false, message: 'Enter a credit limit above zero (in euros).' };
  if (!Number.isInteger(days) || days < 1 || days > 120) return { ok: false, message: 'The payment term must be 1–120 days.' };
  const profile = await prisma.billingProfile.findUnique({ where: { userId }, select: { legalName: true, user: { select: { email: true, name: true } } } });
  if (!profile) return { ok: false, message: 'This buyer has no billing details yet (company, address, VAT ID). They are saved when the buyer accepts an offer or fills them in on the payment page.' };
  await prisma.billingProfile.update({
    where: { userId },
    data: { creditApproved: true, creditLimitCents: limit, creditTermDays: days, creditApprovedAt: new Date(), creditApprovedById: session.user.id, creditNote: note },
  });
  await audit('credit.approve', profile.user.email, `${profile.legalName} · limit ${formatPrice(limit, 'EUR')} · NET ${days}${note ? ` · ${note}` : ''} by ${session.user.email}`);
  await notifyAdmins(`Credit approved — ${profile.legalName}`, `Limit ${formatPrice(limit, 'EUR')}, NET ${days} (by ${session.user.email}).`, '/admin/orders', 'SYSTEM');
  revalidatePath('/admin/orders');
  return { ok: true, message: `${profile.legalName} is approved for payment on invoice: limit ${formatPrice(limit, 'EUR')}, NET ${days}. (Invoice payment is offered only while “Allow invoice payment” is on in Settings.)` };
}

export async function revokeBuyerCredit(formData: FormData): Promise<Result> {
  const session = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  const userId = String(formData.get('userId') ?? '');
  const r = await prisma.billingProfile.updateMany({ where: { userId, creditApproved: true }, data: { creditApproved: false } });
  if (r.count !== 1) return { ok: false, message: 'This buyer has no approved credit.' };
  await audit('credit.revoke', userId, `by ${session.user.email}`);
  revalidatePath('/admin/orders');
  return { ok: true, message: 'Credit approval withdrawn. Open on-terms invoices stay due; new orders prepay.' };
}

/**
 * Approve an unpaid order on invoice terms (requested by the buyer, or on the
 * buyer's behalf): NO money is recorded. The order goes to PROCESSING with
 * financialStatus INVOICED_ON_TERMS, its proforma is replaced by the tax
 * invoice — UNPAID, with the due date of the buyer's NET term — and the unit is
 * sold (hold consumed). Never "paid" without a payment.
 */
export async function approveOrderOnTerms(formData: FormData): Promise<Result> {
  const session = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  await ensureSettingsLoaded();
  const orderId = String(formData.get('orderId') ?? '');
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, status: true, buyerId: true, totalCents: true, currency: true, paymentSubmittedAt: true, holdReason: true, sourcingRequestId: true, billingAddress: true, shippingAddress: true, items: { select: { productId: true, quantity: true } } },
  });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.status !== 'PENDING_PAYMENT') return { ok: false, message: `Order ${o.orderNumber} is ${o.status.toLowerCase().replace(/_/g, ' ')} — only an unpaid order can be approved on terms.` };
  if (o.paymentSubmittedAt) return { ok: false, message: 'A payment receipt is waiting for verification — verify or reject it instead.' };
  if (o.holdReason) return { ok: false, message: `The order is on hold (${o.holdReason.toLowerCase().replace('_', ' ')}) — clear the hold first.` };
  const missing = orderDetailsProblems(o, { vatIdRule: vatIdRule() });
  if (missing.length) return { ok: false, message: `Missing ${missing.join(', ')} — add the billing and delivery details first.` };
  const credit = await creditStatusFor(o.buyerId, o.totalCents, o.currency, { excludeOrderId: o.id });
  if (!credit.eligible) return { ok: false, message: `Not possible: ${credit.reason}` };
  const mode = stockReserveOn();
  let stockNote = '';
  try {
    await prisma.$transaction(async (tx) => {
      const flip = await tx.order.updateMany({
        where: { id: o.id, status: 'PENDING_PAYMENT', paymentSubmittedAt: null, holdReason: null },
        data: {
          status: 'PROCESSING',
          financialStatus: 'INVOICED_ON_TERMS',
          paymentMethodManual: 'INVOICE',
          paymentVerificationStatus: 'TERMS_APPROVED',
          paymentVerifiedAt: new Date(),
          paymentVerifiedById: session.user.id,
          paymentTerms: { kind: 'NET', netDays: credit.termDays, approvedAt: new Date().toISOString(), approvedBy: session.user.email } as Prisma.InputJsonValue,
        },
      });
      if (flip.count !== 1) throw new Error('RACE');
      await voidProformas(o.id, `Replaced by the invoice on NET ${credit.termDays} terms (approved by staff).`, tx);
      if (o.sourcingRequestId) {
        if (mode === 'PAYMENT_VERIFIED' && o.items[0]?.productId) {
          const h = await holdUnitForQuote(tx, { quoteId: o.sourcingRequestId, productId: o.items[0].productId, qty: o.items[0].quantity, orderId: o.id });
          if (!h.ok) stockNote = ` Warning: the unit could not be reserved (${h.message}) — check stock before shipping.`;
        }
        await consumeQuoteHold(o.sourcingRequestId, tx);
        await tx.sourcingRequest.updateMany({ where: { id: o.sourcingRequestId, status: { in: ['PENDING', 'RESPONDED'] } }, data: { status: 'ACCEPTED' } });
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'RACE') return { ok: false, message: 'The order changed meanwhile. Reload and check.' };
    throw e;
  }
  const inv = await sendOrderInvoice(o.id, { actorId: session.user.id });
  await audit('order.terms.approve', o.orderNumber, `NET ${credit.termDays} · ${formatPrice(o.totalCents, o.currency)} · by ${session.user.email} · invoice ${inv.number ?? `not issued: ${inv.notIssuedReason}`}`);
  await notifyUser(o.buyerId, `Order ${o.orderNumber} approved on invoice`, `No payment is needed now: pay invoice ${inv.number ?? ''} within ${credit.termDays} days.`, `/app/orders/${o.orderNumber}`);
  refresh(o.id, o.sourcingRequestId);
  const issuedDoc = inv.issued
    ? await prisma.fiscalDocument.findFirst({ where: { orderId: o.id, kind: 'INVOICE', voidedAt: null }, orderBy: { createdAt: 'desc' }, select: { dueDate: true } })
    : null;
  const dueNote = issuedDoc?.dueDate ? ` Payment due ${fmtDueDate(issuedDoc.dueDate)}.` : '';
  return { ok: true, message: `Approved on NET ${credit.termDays} terms — no payment recorded; the order is ready to ship. ${invoiceMailSummary(inv)}${dueNote}${stockNote}` };
}

export async function declineTermsRequest(formData: FormData): Promise<Result> {
  const session = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  await ensureSettingsLoaded();
  const orderId = String(formData.get('orderId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 300);
  if (reason.length < 4) return { ok: false, message: 'Give the reason (at least 4 characters) — the buyer sees it.' };
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, sourcingRequestId: true, buyer: { select: { id: true, email: true, name: true } } } });
  if (!o) return { ok: false, message: 'Order not found.' };
  const r = await prisma.order.updateMany({
    where: { id: o.id, status: 'PENDING_PAYMENT', paymentVerificationStatus: 'TERMS_REQUESTED' },
    data: { paymentVerificationStatus: null, paymentMethodManual: null, paymentRejectionReason: `Invoice payment not approved: ${reason}` },
  });
  if (r.count !== 1) return { ok: false, message: 'There is no pending invoice-terms request on this order.' };
  const sent = await trySendEmail({
    to: o.buyer.email,
    subject: `Order ${o.orderNumber}: please pay by bank transfer`,
    html: mailLayout({
      heading: 'Invoice payment not approved',
      body: [`Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,`, `We can not approve payment on invoice for order <strong>${o.orderNumber}</strong>: ${escapeHtmlLines(reason)}`, 'Please pay by bank transfer using the details on the payment page.'],
      cta: { href: `${siteBase()}/app/orders/${o.orderNumber}/payment`, label: 'Go to the payment page' },
    }),
  }, 'orders:terms-decline');
  await notifyUser(o.buyer.id, `Order ${o.orderNumber}: please pay by bank transfer`, reason, `/app/orders/${o.orderNumber}/payment`);
  await audit('order.terms.decline', o.orderNumber, `by ${session.user.email}: ${reason}`);
  refresh(o.id, o.sourcingRequestId);
  return { ok: true, message: `Invoice terms declined. ${sent.ok ? `The buyer was emailed (${o.buyer.email}).` : `The email to ${o.buyer.email} could not be delivered (${sent.error}).`}` };
}

/** Money received for an order invoiced on terms (full or partial). */
export async function recordTermsPayment(formData: FormData): Promise<Result> {
  const session = await requireCapability('finance:manage', { redirectTo: '/admin/orders' });
  await ensureSettingsLoaded();
  const orderId = String(formData.get('orderId') ?? '');
  const amount = euros(formData.get('amount'));
  const reference = String(formData.get('reference') ?? '').trim().slice(0, 120) || null;
  const dateRaw = String(formData.get('receivedAt') ?? '');
  const receivedAt = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? new Date(`${dateRaw}T12:00:00Z`) : new Date();
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: 'Enter the amount received (in the order currency).' };
  if (receivedAt.getTime() > Date.now() + 86_400_000) return { ok: false, message: 'The value date can not be in the future.' };
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, totalCents: true, amountPaidCents: true, currency: true, financialStatus: true, sourcingRequestId: true, buyer: { select: { id: true, email: true, name: true } } } });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (!['INVOICED_ON_TERMS', 'OVERDUE', 'PARTIALLY_PAID'].includes(o.financialStatus)) return { ok: false, message: 'This order is not open on invoice terms.' };
  // Open amount = invoice total − paid − what credit notes took off the invoice.
  const docsNow = await getOrderDocuments(o.id);
  const creditedNow = docsNow.creditNotes.filter((c) => c.originalDocumentId === docsNow.invoice?.id).reduce((a2, c) => a2 - c.totalCents, 0);
  const outstanding = o.totalCents - o.amountPaidCents - creditedNow;
  if (outstanding <= 0) return { ok: false, message: 'Nothing is open on this invoice.' };
  if (amount > outstanding) return { ok: false, message: `That is more than the open amount (${fmtDocMoney(outstanding, o.currency)}).` };
  const paidInFull = amount === outstanding;
  await prisma.$transaction(async (tx) => {
    await recordPayment(tx, { orderId: o.id, amountCents: amount, currency: o.currency, method: 'BANK_TRANSFER', receivedAt, reference, verifiedById: session.user.id, note: `On-terms invoice payment recorded by ${session.user.email}` });
    await tx.order.update({ where: { id: o.id }, data: { financialStatus: paidInFull ? 'PAID' : 'PARTIALLY_PAID', ...(paidInFull ? { paidAt: receivedAt } : {}) } });
  });
  const docs = await getOrderDocuments(o.id);
  const sent = await trySendEmail({
    to: o.buyer.email,
    subject: `Payment received — ${docs.invoice ? `invoice ${docs.invoice.number}` : `order ${o.orderNumber}`}`,
    html: mailLayout({
      heading: 'Payment received — thank you',
      body: [
        `We received <strong>${escapeHtml(formatPrice(amount, o.currency))}</strong> for ${docs.invoice ? `invoice <strong>${escapeHtml(docs.invoice.number)}</strong>` : `order <strong>${o.orderNumber}</strong>`} on ${escapeHtml(fmtDueDate(receivedAt))}.`,
        paidInFull ? 'The invoice is now paid in full.' : `Still open: <strong>${escapeHtml(formatPrice(outstanding - amount, o.currency))}</strong>.`,
      ],
      cta: { href: `${siteBase()}/app/orders/${o.orderNumber}`, label: 'View the order' },
    }),
  }, 'orders:terms-payment');
  await audit('order.terms.payment', o.orderNumber, `${formatPrice(amount, o.currency)} ref=${reference ?? '-'} value=${receivedAt.toISOString().slice(0, 10)} by ${session.user.email}${paidInFull ? ' · paid in full' : ''}`);
  refresh(o.id, o.sourcingRequestId);
  return { ok: true, message: `Payment of ${fmtDocMoney(amount, o.currency)} recorded${paidInFull ? ' — the invoice is paid in full' : ` — ${fmtDocMoney(outstanding - amount, o.currency)} still open`}. ${sent.ok ? 'The buyer was emailed a confirmation.' : `The confirmation email could not be delivered (${sent.error}).`}` };
}

// ── Order details / hold / due date ──────────────────────────────────────────

export async function adminSetOrderDetails(input: { orderId: string; details: Record<string, unknown> }): Promise<Result> {
  const session = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  await ensureSettingsLoaded();
  const o = await prisma.order.findUnique({ where: { id: input.orderId }, select: { id: true, sourcingRequestId: true, orderNumber: true, customerType: true } });
  if (!o) return { ok: false, message: 'Order not found.' };
  const parsed = parseDetailsInput(input.details ?? {}, { vatIdRule: o.customerType === 'CONSUMER' ? 'OFF' : vatIdRule() });
  if (!parsed.ok) return { ok: false, message: parsed.message, fieldErrors: parsed.fieldErrors };
  const r = await saveOrderDetails(o.id, parsed.details, { actor: { id: session.user.id, email: session.user.email, kind: 'STAFF' }, saveProfile: false });
  refresh(o.id, o.sourcingRequestId);
  revalidatePath(`/app/orders/${o.orderNumber}/payment`);
  if (r.error) return { ok: false, message: r.error, fieldErrors: r.fieldErrors };
  return { ok: true, message: r.warning ?? r.notice ?? 'Details saved.' };
}

/** Clear an export-compliance hold: payment is requested now (the proforma is emailed). */
export async function clearComplianceHold(formData: FormData): Promise<Result> {
  const session = await requireCapability('compliance:clear', { redirectTo: '/admin/orders' });
  await ensureSettingsLoaded();
  const orderId = String(formData.get('orderId') ?? '');
  const note = String(formData.get('note') ?? '').trim().slice(0, 300);
  if (note.length < 4) return { ok: false, message: 'Record what was checked (at least 4 characters), e.g. “end-user statement on file”.' };
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, holdReason: true, openHolds: true, sourcingRequestId: true } });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.holdReason !== 'COMPLIANCE' && !o.openHolds.includes('COMPLIANCE')) return { ok: false, message: 'This order is not on a compliance hold.' };
  // ONE hold-release path (lib/checkout/holds.ts): when it was the last
  // pre-payment hold the payment term restarts today (new Order.dueAt), the
  // proforma is re-issued with that due date and emailed ("you can pay now"),
  // and the clearance is kept in the audit log and the order notes.
  const r = await clearComplianceHoldCore(o.id, { id: session.user.id, email: session.user.email }, note);
  if (r.ok) await audit('order.hold.clear', o.orderNumber, `COMPLIANCE by ${session.user.email}: ${note}`);
  refresh(o.id, o.sourcingRequestId);
  return { ok: r.ok, message: r.ok ? `Compliance hold cleared. ${r.message}` : r.message };
}

/** Give the buyer more time: new due date on a new proforma revision (emailed). */
export async function extendOrderDueDate(formData: FormData): Promise<Result> {
  const session = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  await ensureSettingsLoaded();
  const orderId = String(formData.get('orderId') ?? '');
  const dateRaw = String(formData.get('dueDate') ?? '');
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 300);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) return { ok: false, message: 'Choose the new due date.' };
  if (reason.length < 4) return { ok: false, message: 'Give the reason (at least 4 characters).' };
  const due = endOfDayUtc(new Date(`${dateRaw}T00:00:00Z`));
  if (due.getTime() < Date.now()) return { ok: false, message: 'The new due date must be today or later.' };
  if (due.getTime() > Date.now() + 180 * 86_400_000) return { ok: false, message: 'At most 180 days ahead.' };
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, status: true, dueAt: true, createdAt: true, payableSince: true, sourcingRequestId: true, buyer: { select: { email: true, name: true } }, sourcingRequest: { select: { validUntilAt: true } } } });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.status !== 'PENDING_PAYMENT') return { ok: false, message: 'Only an unpaid order has a payment due date.' };
  const old = effectiveDueDate({ dueAt: o.dueAt, createdAt: o.createdAt, payableSince: o.payableSince, legacyValidUntil: o.sourcingRequest?.validUntilAt ?? null }, paymentTermDays());
  await prisma.order.update({ where: { id: o.id }, data: { dueAt: due } });
  // Reminders / overdue notices restart for the new date.
  await prisma.reminderLog.deleteMany({ where: { subjectType: 'ORDER', subjectId: o.id, kind: { in: ['PAYMENT_DUE_SOON', 'PAYMENT_OVERDUE'] } } });
  const re = await reissueProforma(o.id, `Payment due date extended from ${fmtDueDate(old)} to ${fmtDueDate(due)}: ${reason}`, { actorId: session.user.id, dueDate: due });
  let mail = '';
  if (re.ok) {
    const att = await documentAttachment(re.document);
    const sent = await trySendEmail({
      to: o.buyer.email,
      subject: `New payment date for order ${o.orderNumber}: ${fmtDueDate(due)}`,
      html: mailLayout({
        heading: 'Your payment due date was extended',
        body: [`Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,`, `Order <strong>${o.orderNumber}</strong> can now be paid until <strong>${escapeHtml(fmtDueDate(due))}</strong> (was ${escapeHtml(fmtDueDate(old))}). Proforma <strong>${escapeHtml(re.document.number)}</strong>${att.attachment ? ' is attached' : ' is on the payment page'}; please quote it as the transfer reference.`],
        cta: { href: `${siteBase()}/app/orders/${o.orderNumber}/payment`, label: 'Go to the payment page' },
      }),
      attachments: att.attachment ? [att.attachment] : [],
    }, 'orders:due-extended');
    if (sent.ok) await markDocumentSent(re.document.id);
    mail = sent.ok ? ` Proforma ${re.document.number} emailed to ${o.buyer.email}.` : ` Proforma ${re.document.number} issued, but the email could not be delivered (${sent.error}).`;
  } else {
    mail = ` The proforma could not be re-issued (${re.message}) — the new date is saved on the order.`;
  }
  await audit('order.due.extend', o.orderNumber, `${fmtDueDate(old)} → ${fmtDueDate(due)} by ${session.user.email}: ${reason}`);
  refresh(o.id, o.sourcingRequestId);
  return { ok: true, message: `Due date moved to ${fmtDueDate(due)}.${mail}` };
}
