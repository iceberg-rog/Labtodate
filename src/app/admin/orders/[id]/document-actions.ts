'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireCapability, requireSession } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { isDeliverableEmail } from '@/lib/email';
import { audit } from '@/lib/observability';
import { documentAttachment, prePaymentHoldMessage, sellerDetailsMissing } from '@/lib/documents/issue';
import { documentMail, mailOrderDocument, recipientsLabel } from '@/lib/orders/internal';
import { releaseHold } from '@/lib/checkout/holds';

/**
 * Staff actions of an order's Documents panel (components/documents/
 * OrderDocumentsPanel.tsx). Every action returns { ok, message } — shown next
 * to the button — and is audited.
 *
 *  resendDocumentAction      e-mail the STORED PDF of an issued proforma,
 *                            invoice or credit note again — to the order's
 *                            document recipients or to an address staff type
 *  issueHeldProformaAction   the proforma that waited for the seller's own
 *                            details (Settings → Company / Payments): issue and
 *                            e-mail it now that they are complete
 */

type R = { ok: boolean; message: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function actor() {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCapability('orders:fulfil', { redirectTo: '/admin' });
  return { id: session.user.id, email: session.user.email };
}

function done(order: { id: string; orderNumber: string }, r: R): R {
  revalidatePath(`/admin/orders/${order.id}`);
  revalidatePath(`/app/orders/${order.orderNumber}`);
  return r;
}

/**
 * Re-send one issued document (its stored, integrity-checked PDF — never a new
 * rendering) by e-mail. A void or replaced proforma, or one of an order that is
 * paid or on a pre-payment hold, is not a payment request any more and is not
 * re-sent. The first send time (sentAt) is kept; every send is in the e-mail
 * log and the audit trail.
 */
export async function resendDocumentAction(formData: FormData): Promise<R> {
  const a = await actor();
  await ensureSettingsLoaded();
  const docId = String(formData.get('docId') ?? '');
  const typed = String(formData.get('to') ?? '').trim().toLowerCase().slice(0, 200);
  if (typed && !EMAIL.test(typed)) return { ok: false, message: `“${typed}” is not an e-mail address — nothing was sent.` };
  if (typed && !isDeliverableEmail(typed)) return { ok: false, message: `${typed} can not receive e-mail (placeholder or blocked domain) — nothing was sent.` };
  const doc = docId ? await prisma.fiscalDocument.findUnique({ where: { id: docId } }) : null;
  if (!doc?.orderId) return { ok: false, message: 'Document not found.' };
  const order = await prisma.order.findUnique({
    where: { id: doc.orderId },
    select: { id: true, orderNumber: true, status: true, holdReason: true, openHolds: true, invoiceEmail: true, billingAddress: true, buyer: { select: { email: true, name: true } } },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  if (doc.kind === 'PROFORMA') {
    if (doc.voidedAt || doc.supersededById) {
      return { ok: false, message: `${doc.number} is ${doc.voidedAt ? 'void' : 'replaced by a newer revision'}: it is not payable, so it is not re-sent. Resend the current proforma instead.` };
    }
    if (order.status !== 'PENDING_PAYMENT') {
      return { ok: false, message: `Order ${order.orderNumber} is ${order.status.toLowerCase().replace(/_/g, ' ')} — a proforma (payment request) is only sent for an unpaid order${order.status === 'CANCELED' ? '' : '; resend the invoice instead'}.` };
    }
    const held = prePaymentHoldMessage(order);
    if (held) return { ok: false, message: `${held} It is e-mailed when the hold is released.` };
  }
  const att = await documentAttachment(doc);
  if (!att.attachment) return { ok: false, message: `The stored PDF of ${doc.number} could not be read (${att.error ?? 'unknown error'}) — nothing was sent.` };
  const content = documentMail(doc, { orderNumber: order.orderNumber, buyerName: order.buyer.name, attached: true, again: true });
  const mail = await mailOrderDocument({
    doc,
    order,
    subject: content.subject,
    html: content.html,
    attachment: att.attachment,
    context: 'documents:resend',
    to: typed || null,
    companyCopy: false,
  });
  await audit('document.resend', doc.number, `order ${order.orderNumber} → ${recipientsLabel(mail)}${typed ? ' (address typed by staff)' : ''} by ${a.email}: ${mail.emailed ? 'sent' : `failed (${mail.error})`}`);
  return done(order, mail.emailed
    ? { ok: true, message: `${doc.number} (the stored PDF) was sent to ${recipientsLabel(mail)}.` }
    : { ok: false, message: `${doc.number} could not be delivered to ${mail.to} (${mail.error}). Check the address, or type another one.` });
}

/**
 * The proforma of an unpaid order waited on the INVOICE_PENDING hold because
 * the seller's details were incomplete: once Settings → Company / Payments are
 * complete, release the hold — the order becomes payable and the proforma is
 * issued and e-mailed (lib/checkout/notify.ts sendHoldReleased), or it waits
 * for the other holds still open.
 */
export async function issueHeldProformaAction(formData: FormData): Promise<R> {
  const a = await actor();
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  const o = id ? await prisma.order.findUnique({ where: { id }, select: { id: true, orderNumber: true, status: true, openHolds: true, holdReason: true, paymentMethodManual: true } }) : null;
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.status !== 'PENDING_PAYMENT') return { ok: false, message: `Order ${o.orderNumber} is ${o.status.toLowerCase().replace(/_/g, ' ')} — only an unpaid order waits for its proforma.` };
  if ((o.paymentMethodManual ?? '').toUpperCase() === 'INVOICE') return { ok: false, message: `Order ${o.orderNumber} is approved on invoice terms — it gets an invoice, not a proforma (“Try issuing again” under Invoice, refunds & corrections).` };
  if (!o.openHolds.includes('INVOICE_PENDING') && o.holdReason !== 'INVOICE_PENDING') return { ok: false, message: `Order ${o.orderNumber} is not waiting for its proforma.` };
  const missing = sellerDetailsMissing();
  if (missing.length) return { ok: false, message: `Still missing: ${missing.join(', ')}. Complete them first — nothing was issued.` };
  const r = await releaseHold(o.id, 'INVOICE_PENDING', a, 'Seller details complete — the proforma can be issued.');
  await audit('order.proforma.release', o.orderNumber, `${r.ok ? 'released' : 'not released'} by ${a.email}: ${r.message}`.slice(0, 500));
  return done(o, r);
}
