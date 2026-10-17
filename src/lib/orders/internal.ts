import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingBool } from '@/lib/settings';
import { companyCopyAddress, sendInternalEmail, trySendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { logError, notifyAdmins } from '@/lib/observability';
import { generateOrderNumber } from '@/lib/orders/checkout-tx';
import { absoluteDocumentHref } from '@/lib/documents';
import { documentAttachment, issueInvoice, markDocumentSent, readableIssueError, type InvoiceVatDecision } from '@/lib/documents/issue';
import { fmtDocMoney } from '@/lib/documents/render';
import { settingString } from '@/lib/settings';
import { settingText } from '@/lib/finance/texts';

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

export type InvoiceMailResult = {
  /** An invoice exists for the order (issued now or before). */
  issued: boolean;
  /** Its number, when issued. */
  number: string | null;
  /** The buyer's email was accepted by the mail server. */
  emailed: boolean;
  /** The invoice PDF was attached. */
  pdfAttached: boolean;
  to: string | null;
  error: string | null;
  /** Why no invoice was issued (VAT review / missing details / not paid). */
  notIssuedReason: string | null;
};

/**
 * Issue the order's INVOICE (lib/documents/issue.ts: sequential number, VAT
 * checked, immutable snapshot, stored PDF) and email it to the buyer, plus a
 * copy to the billing inbox when COMPANY_EMAIL is a real address. Never
 * throws, and reports exactly what happened so the admin message is truthful:
 * when the invoice can NOT be issued (VAT review, missing legal details, a
 * technical error) no email goes out, the order is put on hold with the
 * reason and every admin is notified.
 */
export async function sendOrderInvoice(
  orderId: string,
  opts: { actorId?: string | null; vatDecision?: InvoiceVatDecision; replaceCredited?: { reason: string } } = {},
): Promise<InvoiceMailResult> {
  try {
    await ensureSettingsLoaded();
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { orderNumber: true, totalCents: true, currency: true, invoiceEmail: true, billingAddress: true, buyer: { select: { name: true, email: true } } },
    });
    if (!order) return { issued: false, number: null, emailed: false, pdfAttached: false, to: null, error: 'order not found', notIssuedReason: 'order not found' };
    // The invoice goes to the accounts-payable address given at checkout (older orders: the
    // e-mail in their billing details — the same one printed on the invoice); the account
    // e-mail gets a copy (INVOICE_EMAIL_CC_ACCOUNT).
    const bill = order.billingAddress && typeof order.billingAddress === 'object' ? (order.billingAddress as Record<string, unknown>) : {};
    const billEmail = typeof bill.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(bill.email.trim()) ? bill.email.trim() : null;
    const apEmail = order.invoiceEmail || billEmail;
    const invoiceTo = apEmail || order.buyer.email;
    const ccAccount = !!apEmail && apEmail.toLowerCase() !== order.buyer.email.toLowerCase() && settingBool('INVOICE_EMAIL_CC_ACCOUNT');
    const issued = await issueInvoice(orderId, { actorId: opts.actorId, vatDecision: opts.vatDecision, replaceCredited: opts.replaceCredited });
    if (!issued.ok) {
      if (issued.code !== 'NOT_PAID' && issued.code !== 'NOT_FOUND') {
        await notifyAdmins(
          `Order ${order.orderNumber}: paid, invoice NOT issued`,
          issued.message.slice(0, 300),
          `/admin/orders/${orderId}`,
          'SYSTEM',
        );
      }
      return { issued: false, number: null, emailed: false, pdfAttached: false, to: invoiceTo, error: null, notIssuedReason: issued.message };
    }
    const docRow = issued.document;
    const number = docRow.number;
    const att = await documentAttachment(docRow);
    const pdfUrl = absoluteDocumentHref('invoice', order.orderNumber, 'pdf');
    const snap = (docRow.snapshot ?? {}) as { payment?: { kind?: string; paidCents?: number; openCents?: number; dueDate?: string | null; amountCents?: number } | null; refs?: Array<{ label: string; value: string }> };
    const pay = snap.payment ?? null;
    const kind = pay?.kind ?? 'DUE';
    const money = (c: number) => fmtDocMoney(c, order.currency);
    const due = docRow.dueDate ? docRow.dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
    const replaces = opts.replaceCredited ? (docRow.originalDocumentId ? (await prisma.fiscalDocument.findUnique({ where: { id: docRow.originalDocumentId }, select: { number: true } }))?.number ?? null : null) : null;
    const vars = { AMOUNT: money(order.totalCents), ORDER: order.orderNumber, NUMBER: number, DUE: due };
    const bodyText = kind === 'PAID'
      ? settingText('EMAIL_INVOICE_PAID_BODY', vars, ['AMOUNT', 'ORDER'])
      : kind === 'PARTLY_PAID'
        ? settingText('EMAIL_INVOICE_PARTLY_PAID_BODY', { ...vars, PAID: money(pay?.paidCents ?? 0), OPEN: money(pay?.openCents ?? 0) }, ['OPEN', 'DUE'])
        : settingText('EMAIL_INVOICE_DUE_BODY', vars, ['AMOUNT', 'DUE']);
    const heading = kind === 'PAID' ? settingString('EMAIL_INVOICE_PAID_HEADING') || 'Payment received — thank you' : `Invoice ${number}`;
    const subject = `${replaces ? 'Corrected invoice' : 'Invoice'} ${number} — order ${order.orderNumber}${kind === 'PAID' ? ' (paid)' : ''}`;
    const footer = settingString('EMAIL_INVOICE_FOOTER');
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;">
        <h2 style="color:#0E4F40;">${escapeHtml(heading)}</h2>
        <p>Hi <span dir="auto">${escapeHtml(order.buyer.name || 'there')}</span>,</p>
        ${replaces ? `<p>This corrected invoice replaces invoice <strong>${escapeHtml(replaces)}</strong>, which is credited in full.</p>` : ''}
        <p>${bodyText.html}</p>
        <p>${att.attachment ? `Your invoice <strong>${number}</strong> is attached (PDF).` : `Your invoice <strong>${number}</strong> is ready.`}</p>
        <p><a href="${pdfUrl}">Download the invoice (PDF)</a> · <a href="${siteBase()}/app/orders/${order.orderNumber}">View your order</a></p>
        ${footer ? `<p style="color:#6b7280;font-size:12px;">${escapeHtml(footer)}</p>` : ''}
      </div>`;
    const attachments = att.attachment ? [att.attachment] : [];
    // Only send once per invoice (a retry after a bounce re-sends; a second verify click does not).
    if (!issued.created && docRow.sentAt) {
      return { issued: true, number, emailed: true, pdfAttached: !!att.attachment, to: invoiceTo, error: null, notIssuedReason: null };
    }
    const sent = await trySendEmail({ to: invoiceTo, subject, html, attachments }, 'orders:invoice');
    if (sent.ok) await markDocumentSent(docRow.id);
    if (ccAccount) await trySendEmail({ to: order.buyer.email, subject: `[copy] ${subject}`, html, attachments }, 'orders:invoice-account-copy');
    const copyTo = companyCopyAddress();
    if (copyTo) await sendInternalEmail({ to: copyTo, subject: `[copy] ${subject}`, html, attachments }, 'orders:invoice-copy');
    if (att.error) await logError('sendOrderInvoice:pdf', new Error(att.error));
    return {
      issued: true,
      number,
      emailed: sent.ok,
      pdfAttached: !!att.attachment,
      to: ccAccount ? `${invoiceTo} (copy to ${order.buyer.email})` : invoiceTo,
      error: sent.ok ? null : sent.error,
      notIssuedReason: null,
    };
  } catch (e) {
    console.error('sendOrderInvoice failed', e);
    await logError('sendOrderInvoice', e);
    const reason = readableIssueError(e, 'invoice');
    return { issued: false, number: null, emailed: false, pdfAttached: false, to: null, error: reason, notIssuedReason: reason };
  }
}

/** Admin-facing sentence for an invoice outcome. */
export function invoiceMailSummary(r: InvoiceMailResult): string {
  if (!r.issued) return `No invoice was issued: ${r.notIssuedReason ?? r.error ?? 'unknown reason'} The order is on hold (“invoice not issued”) until this is resolved on the order page, and every admin was notified.`;
  if (r.emailed) return `Invoice ${r.number} issued and emailed to ${r.to}${r.pdfAttached ? ' (PDF attached)' : ' (the PDF could not be generated — the email has the download link)'}.`;
  return `Invoice ${r.number} issued, but the email to ${r.to ?? 'the buyer'} could not be delivered (${r.error ?? 'unknown error'}); the buyer can download it from their order page.`;
}

// Checkout confirmation emails live in lib/checkout/notify.ts (they know the
// order's real state: payable with a proforma, or on hold with nothing due).

/**
 * Create a standalone order (no stock reservation — used by the quote offer
 * acceptance), never failing on the (rare) order-number collision.
 *  - Outside a transaction: each attempt is its own implicit transaction, so a
 *    P2002 on one create is retried with a fresh number.
 *  - Inside an interactive transaction (`tx`): a failed statement aborts the
 *    whole Postgres transaction, so the number is checked to be free first and
 *    the create runs once (a collision in that window aborts and the caller's
 *    transaction rolls back cleanly).
 * Reserving checkout paths use reserveAndCreateOrder (transactional) instead.
 */
export async function createOrderWithUniqueNumber(
  data: Omit<Prisma.OrderUncheckedCreateInput, 'orderNumber'>,
  opts: { tx?: Prisma.TransactionClient } = {},
) {
  if (opts.tx) {
    const tx = opts.tx;
    for (let attempt = 0; attempt < 6; attempt++) {
      const orderNumber = generateOrderNumber();
      const taken = await tx.order.findUnique({ where: { orderNumber }, select: { id: true } });
      if (taken) continue;
      return tx.order.create({ data: { ...data, orderNumber } });
    }
    throw new Error('Could not allocate an order number');
  }
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
