import { Prisma, type FiscalDocument } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { companyCopyAddress, sendInternalEmail, trySendEmail, type EmailAttachment } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { logError, notifyAdmins } from '@/lib/observability';
import { generateOrderNumber } from '@/lib/orders/checkout-tx';
import { absoluteDocumentHref } from '@/lib/documents';
import { documentAttachment, issueInvoice, markDocumentSent, readableIssueError, type InvoiceVatDecision } from '@/lib/documents/issue';
import { fmtDocMoney } from '@/lib/documents/render';
import { settingString } from '@/lib/settings';
import { settingText } from '@/lib/finance/texts';
import { billingEmailOf, documentRecipients, type DocumentRecipients } from '@/lib/orders/recipients';
import { mailLayout, mailTable } from '@/lib/quotes/mail';

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

// ── document e-mails (proforma, invoice, credit note) ───────────────────────

/** What a document e-mail needs from its order. */
export interface DocumentMailOrder {
  invoiceEmail: string | null;
  billingAddress: unknown;
  buyer: { email: string };
}

/** Who gets an order's documents: the accounts-payable address, the account in copy (lib/orders/recipients.ts). Read after ensureSettingsLoaded(). */
export function orderDocumentRecipients(o: DocumentMailOrder): DocumentRecipients {
  return documentRecipients({ invoiceEmail: o.invoiceEmail, billingEmail: billingEmailOf(o.billingAddress), accountEmail: o.buyer.email });
}

/** "ap@lab.nl (copy to buyer@lab.nl)" — for staff messages. */
export function recipientsLabel(r: { to: string; cc: string[] }): string {
  return r.cc.length ? `${r.to} (copy to ${r.cc.join(', ')})` : r.to;
}

export interface DocumentMailResult {
  /** The primary recipient's mail server accepted it (the document is then marked sent). */
  emailed: boolean;
  to: string;
  cc: string[];
  error: string | null;
}

/**
 * E-mail one issued document — its STORED PDF (`attachment`, from
 * documentAttachment) — the same way for every document: to the order's
 * document recipients (AP address, a "[copy]" to the account e-mail when it
 * differs and INVOICE_EMAIL_CC_ACCOUNT is on) or only to `to` when staff typed
 * an address, plus a "[copy]" to the billing inbox (COMPANY_EMAIL) unless
 * `companyCopy` is false. Marks the document sent when the primary mail went
 * out (the first send time is kept). Never throws.
 */
export async function mailOrderDocument(p: {
  doc: Pick<FiscalDocument, 'id'>;
  order: DocumentMailOrder;
  subject: string;
  html: string;
  attachment: EmailAttachment | null;
  context: string;
  to?: string | null;
  companyCopy?: boolean;
}): Promise<DocumentMailResult> {
  const r: DocumentRecipients = p.to ? { to: p.to, cc: [] } : orderDocumentRecipients(p.order);
  const attachments = p.attachment ? [p.attachment] : [];
  const sent = await trySendEmail({ to: r.to, subject: p.subject, html: p.html, attachments }, p.context);
  if (sent.ok) await markDocumentSent(p.doc.id);
  for (const cc of r.cc) await trySendEmail({ to: cc, subject: `[copy] ${p.subject}`, html: p.html, attachments }, `${p.context}-account-copy`);
  const copyTo = p.companyCopy === false ? null : companyCopyAddress();
  if (copyTo && ![r.to, ...r.cc].some((a) => a.toLowerCase() === copyTo.toLowerCase())) {
    await sendInternalEmail({ to: copyTo, subject: `[copy] ${p.subject}`, html: p.html, attachments }, `${p.context}-copy`);
  }
  return { emailed: sent.ok, to: r.to, cc: r.cc, error: sent.ok ? null : sent.error };
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
 * Subject and body of the e-mail that carries an issued document (branded
 * layout). Everything it states comes from the document's frozen snapshot:
 *  - proforma: the payment request — amount, bank details, reference, pay-by;
 *  - invoice: paid / partly paid / due texts (Settings → Email texts), the
 *    amount received (a short payment accepted within the tolerance included);
 *  - credit note: the invoice it credits and what happens to the money.
 * `again`: staff re-send the document (Documents → Resend).
 */
export function documentMail(
  doc: Pick<FiscalDocument, 'kind' | 'number' | 'currency' | 'dueDate' | 'snapshot'>,
  o: { orderNumber: string; buyerName: string | null; attached: boolean; replaces?: string | null; again?: boolean },
): { subject: string; html: string } {
  const snap = (doc.snapshot ?? {}) as {
    payment?: { kind?: string; paidCents?: number; openCents?: number; amountCents?: number; reference?: string; dueDate?: string | null; originalNumber?: string } | null;
    bank?: { beneficiary: string; bankName: string; iban: string; bic: string } | null;
    totals?: { totalCents: number };
    terms?: string[];
  };
  const pay = snap.payment ?? null;
  const money = (c: number) => fmtDocMoney(c, doc.currency);
  const fmtDay = (d: Date | string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const total = snap.totals?.totalCents ?? 0;
  const orderUrl = `${siteBase()}/app/orders/${o.orderNumber}`;
  const hi = `Hi <span dir="auto">${escapeHtml(o.buyerName || 'there')}</span>,`;
  const number = escapeHtml(doc.number);
  const again = o.again ? `We are sending you ${doc.kind === 'PROFORMA' ? 'proforma invoice' : doc.kind === 'INVOICE' ? 'invoice' : 'credit note'} <strong>${number}</strong> for order <strong>${escapeHtml(o.orderNumber)}</strong> again.` : '';
  const file = o.attached ? `<strong>${number}</strong> is attached (PDF).` : `<strong>${number}</strong> is ready to download.`;
  const footer = settingString('EMAIL_INVOICE_FOOTER');

  if (doc.kind === 'PROFORMA') {
    const b = snap.bank ?? null;
    const due = pay?.dueDate ?? (doc.dueDate ? doc.dueDate.toISOString() : null);
    const mono = (v: string) => `<span style="font-family:ui-monospace,monospace;">${escapeHtml(v)}</span>`;
    const rows: Array<[string, string, boolean?]> = [
      ['Amount', escapeHtml(money(pay?.amountCents ?? total)), true],
      ...(b
        ? [
            ['Beneficiary', `<span dir="auto">${escapeHtml(b.beneficiary)}</span>`] as [string, string],
            ...(b.bankName ? [['Bank', `<span dir="auto">${escapeHtml(b.bankName)}</span>`] as [string, string]] : []),
            ['IBAN', mono(b.iban)] as [string, string],
            ...(b.bic ? [['BIC', mono(b.bic)] as [string, string]] : []),
          ]
        : []),
      ['Reference', `<strong>${number}</strong>`],
      ...(due ? [['Pay by', `<strong>${escapeHtml(fmtDay(due))}</strong>`] as [string, string]] : []),
    ];
    return {
      subject: `Proforma invoice ${doc.number} — order ${o.orderNumber}`,
      html: mailLayout({
        heading: `Proforma invoice ${doc.number}`,
        body: [
          hi,
          again || `Here is the proforma invoice (payment request) for order <strong>${escapeHtml(o.orderNumber)}</strong>.`,
          mailTable(rows),
          b ? 'Please pay by bank transfer, quoting the reference, and upload the bank receipt on your payment page.' : 'The bank details are on the proforma invoice.',
          `Your proforma invoice ${file}`,
        ],
        cta: { href: `${orderUrl}/payment`, label: 'Go to the payment page' },
      }),
    };
  }

  if (doc.kind === 'CREDIT_NOTE') {
    return {
      subject: `Credit note ${doc.number} — order ${o.orderNumber}`,
      html: mailLayout({
        heading: `Credit note ${doc.number}`,
        body: [
          hi,
          again || `Here is credit note <strong>${number}</strong> for order <strong>${escapeHtml(o.orderNumber)}</strong>.`,
          `It credits ${pay?.originalNumber ? `invoice <strong>${escapeHtml(pay.originalNumber)}</strong>` : 'the invoice'} for <strong>${escapeHtml(money(Math.abs(total)))}</strong>.`,
          ...(snap.terms ?? []).map((t) => escapeHtml(t)),
          `Your credit note ${file}`,
        ],
        cta: { href: orderUrl, label: 'View your order' },
        footer: footer ? [escapeHtml(footer)] : [],
      }),
    };
  }

  const kind = pay?.kind ?? 'DUE';
  const vars = {
    // Paid: the amount that really came in (a short payment accepted within the tolerance is less than the total).
    AMOUNT: money(kind === 'PAID' ? pay?.amountCents ?? total : total),
    ORDER: o.orderNumber,
    NUMBER: doc.number,
    DUE: doc.dueDate ? fmtDay(doc.dueDate) : '',
  };
  const bodyText = kind === 'PAID'
    ? settingText('EMAIL_INVOICE_PAID_BODY', vars, ['AMOUNT', 'ORDER'])
    : kind === 'PARTLY_PAID'
      ? settingText('EMAIL_INVOICE_PARTLY_PAID_BODY', { ...vars, PAID: money(pay?.paidCents ?? 0), OPEN: money(pay?.openCents ?? 0) }, ['OPEN', 'DUE'])
      : settingText('EMAIL_INVOICE_DUE_BODY', vars, ['AMOUNT', 'DUE']);
  const heading = kind === 'PAID' && !o.again ? settingString('EMAIL_INVOICE_PAID_HEADING') || 'Payment received — thank you' : `Invoice ${doc.number}`;
  return {
    subject: `${o.replaces ? 'Corrected invoice' : 'Invoice'} ${doc.number} — order ${o.orderNumber}${kind === 'PAID' ? ' (paid)' : ''}`,
    html: mailLayout({
      heading,
      body: [
        hi,
        ...(again ? [again] : []),
        ...(o.replaces ? [`This corrected invoice replaces invoice <strong>${escapeHtml(o.replaces)}</strong>, which is credited in full.`] : []),
        bodyText.html,
        `Your invoice ${file} <a href="${absoluteDocumentHref('doc', doc.number, 'pdf')}">Download the invoice (PDF)</a>.`,
      ],
      cta: { href: orderUrl, label: 'View your order' },
      footer: footer ? [escapeHtml(footer)] : [],
    }),
  };
}

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
    // e-mail gets a copy (INVOICE_EMAIL_CC_ACCOUNT) — one rule for every document mail.
    const recipients = orderDocumentRecipients(order);
    const invoiceTo = recipients.to;
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
    const content = documentMail(docRow, {
      orderNumber: order.orderNumber,
      buyerName: order.buyer.name,
      attached: !!att.attachment,
      replaces: opts.replaceCredited ? (docRow.originalDocumentId ? (await prisma.fiscalDocument.findUnique({ where: { id: docRow.originalDocumentId }, select: { number: true } }))?.number ?? null : null) : null,
    });
    // Only send once per invoice (a retry after a bounce re-sends; a second verify
    // click does not). Staff re-send it on purpose with “Resend” (Documents).
    if (!issued.created && docRow.sentAt) {
      return { issued: true, number, emailed: true, pdfAttached: !!att.attachment, to: recipientsLabel(recipients), error: null, notIssuedReason: null };
    }
    const mail = await mailOrderDocument({ doc: docRow, order, subject: content.subject, html: content.html, attachment: att.attachment, context: 'orders:invoice' });
    if (att.error) await logError('sendOrderInvoice:pdf', new Error(att.error));
    return {
      issued: true,
      number,
      emailed: mail.emailed,
      pdfAttached: !!att.attachment,
      to: recipientsLabel(mail),
      error: mail.error,
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
