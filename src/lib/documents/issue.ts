import { createHash } from 'node:crypto';
import type { IssuedDocument, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logError } from '@/lib/observability';
import { getGeneral, getNumbering, getOptions, getVatSettings } from './config';
import { companySnapshot } from './company';
import { addressLinesFrom, buildSnapshot, langOf, parseQuoteDetails, type QuoteDetails } from './build';
import { allocateNumber } from './numbering';
import { htmlToPdf } from './pdf';
import { pdfFooter, renderDocumentHtml } from './render';
import type { DocKind, DocSnapshot, Lang } from './types';

/**
 * Issuing = freezing. A document is stored with the exact snapshot it was
 * rendered from and its PDF bytes; later template, company or price changes
 * never touch it. Numbers are taken inside the storing transaction.
 */

/** Interactive transactions that take a number: room for a slow DB, never minutes. */
const TX = { timeout: 15_000, maxWait: 10_000 };

export const PAID_ORDER_STATES = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'];

/** A last address line that is a bare ISO code ("NL") prints as the country name in the document language. */
export function withCountryName(lines: string[], lang: Lang): string[] {
  if (!lines.length) return lines;
  const last = lines[lines.length - 1].trim();
  if (!/^[A-Z]{2}$/.test(last)) return lines;
  try {
    const name = new Intl.DisplayNames([lang === 'nl' ? 'nl' : 'en'], { type: 'region' }).of(last);
    return name && name !== last ? [...lines.slice(0, -1), name] : lines;
  } catch {
    return lines;
  }
}

export function snapshotOf(doc: Pick<IssuedDocument, 'snapshot'>): DocSnapshot {
  return doc.snapshot as unknown as DocSnapshot;
}

export function documentFileName(snap: DocSnapshot): string {
  const safe = `${snap.texts.title}-${snap.number}${snap.revision > 1 ? `-rev${snap.revision}` : ''}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${safe}.pdf`;
}

async function renderPdf(snap: DocSnapshot): Promise<Buffer> {
  const { footerText, pageLabel } = pdfFooter(snap);
  return htmlToPdf(renderDocumentHtml(snap), { footerText, pageLabel });
}

/** The stored PDF; rendered (and stored) now if issuing could not make it. */
export async function documentPdf(doc: IssuedDocument): Promise<Buffer> {
  if (doc.pdf && doc.pdf.length > 100) return Buffer.from(doc.pdf);
  const pdf = await renderPdf(snapshotOf(doc));
  await prisma.issuedDocument.update({
    where: { id: doc.id },
    data: { pdf, pdfSha256: createHash('sha256').update(pdf).digest('hex') },
  }).catch(() => {});
  return pdf;
}

/** Render a PDF for a fresh issue without failing the issue itself. */
async function attachPdf(doc: IssuedDocument): Promise<IssuedDocument> {
  try {
    const pdf = await renderPdf(snapshotOf(doc));
    return await prisma.issuedDocument.update({
      where: { id: doc.id },
      data: { pdf, pdfSha256: createHash('sha256').update(pdf).digest('hex') },
    });
  } catch (e) {
    await logError(`documents.pdf.${doc.kind.toLowerCase()}`, e);
    return doc;
  }
}

async function insertDoc(
  tx: Prisma.TransactionClient,
  snap: DocSnapshot,
  links: { sourcingRequestId?: string | null; orderId?: string | null; issuedById?: string | null },
) {
  return tx.issuedDocument.create({
    data: {
      kind: snap.kind,
      number: snap.number,
      revision: snap.revision,
      sourcingRequestId: links.sourcingRequestId ?? null,
      orderId: links.orderId ?? null,
      lang: snap.lang,
      snapshot: snap as unknown as Prisma.InputJsonValue,
      totalCents: snap.totalCents,
      currency: snap.currency,
      vatTreatment: snap.vat.treatment,
      issuedAt: new Date(snap.issuedAt),
      issuedById: links.issuedById ?? null,
    },
  });
}

// ─── Quote ─────────────────────────────────────────────────────────────

export interface QuoteIssueInput {
  sr: {
    id: string;
    buyerName: string;
    buyerEmail: string;
    companyName: string | null;
    proformaNumber: string | null;
    quotedCurrency: string | null;
    quotedNote: string | null;
  };
  details: QuoteDetails;
  validUntil: Date;
  issuedAt: Date;
  actorId?: string | null;
  orderNumber?: string | null;
}

/**
 * Issue (or re-issue) the quote of a request. The first issue takes a number
 * from the QUOTE series unless the request already has one (quotes issued
 * before editable documents); a re-issue keeps the number and adds a revision.
 */
export async function issueQuote(input: QuoteIssueInput): Promise<IssuedDocument> {
  const numbering = await getNumbering();
  const d = input.details;
  // Slow reads (settings, logo from storage) happen BEFORE the transaction.
  const company = await companySnapshot({ withLogo: (await getOptions('QUOTE')).showLogo });
  const doc = await prisma.$transaction(async (tx) => {
    const previous = await tx.issuedDocument.findFirst({
      where: { kind: 'QUOTE', sourcingRequestId: input.sr.id },
      orderBy: { revision: 'desc' },
      select: { number: true, revision: true },
    });
    let number = previous?.number ?? input.sr.proformaNumber ?? null;
    if (!number) {
      number = await allocateNumber(tx, 'QUOTE', numbering.QUOTE, input.issuedAt, async (n) => {
        const [a, b] = await Promise.all([
          tx.issuedDocument.count({ where: { kind: 'QUOTE', number: n } }),
          tx.sourcingRequest.count({ where: { proformaNumber: n } }),
        ]);
        return a + b > 0;
      });
    }
    const revision = (previous?.revision ?? 0) + 1;
    const snap = await buildSnapshot({
      kind: 'QUOTE',
      lang: d.lang,
      number,
      revision,
      issuedAt: input.issuedAt,
      currency: input.sr.quotedCurrency || 'EUR',
      customer: {
        name: d.billing.name || input.sr.buyerName,
        company: d.billing.company ?? input.sr.companyName,
        email: input.sr.buyerEmail,
        addressLines: withCountryName([...d.billing.addressLines, ...(d.billing.country ? [d.billing.country] : [])], d.lang),
        country: d.billing.country ?? null,
        vatId: d.billing.vatId ?? null,
      },
      lines: d.lines,
      shippingCents: d.shippingCents,
      vat: { treatment: d.vat.treatment, rateBp: d.vat.rateBp, reason: d.vat.reason },
      refs: { quoteNumber: number, orderNumber: input.orderNumber ?? null },
      note: input.sr.quotedNote,
      validUntil: input.validUntil,
      company,
    });
    if (previous) {
      await tx.issuedDocument.updateMany({
        where: { kind: 'QUOTE', sourcingRequestId: input.sr.id, supersededAt: null },
        data: { supersededAt: input.issuedAt },
      });
    }
    return insertDoc(tx, snap, { sourcingRequestId: input.sr.id, issuedById: input.actorId });
  }, TX);
  return attachPdf(doc);
}

/** The current quote document of a request (latest revision), if any. */
export async function currentQuoteDoc(srId: string): Promise<IssuedDocument | null> {
  return prisma.issuedDocument.findFirst({
    where: { kind: 'QUOTE', sourcingRequestId: srId },
    orderBy: { revision: 'desc' },
  });
}

/**
 * Quotes issued before editable documents have no stored document: freeze
 * one now from the stored price fields (one line, the VAT the order was
 * created with), under the number the buyer already has.
 */
export async function ensureLegacyQuoteDoc(srId: string): Promise<IssuedDocument | null> {
  const existing = await currentQuoteDoc(srId);
  if (existing) return existing;
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: srId },
    include: { product: { select: { title: true } }, submittedBy: { select: { docLanguage: true } } },
  });
  if (!sr || sr.quotedPriceCents == null) return null;
  const order = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: { orderNumber: true, subtotalCents: true, shippingCents: true, taxCents: true, totalCents: true },
  });
  const details = parseQuoteDetails(sr.quoteDetails);
  const number = sr.proformaNumber ?? `PRO-${new Date(sr.quotedAt ?? sr.createdAt).getFullYear()}-${sr.id.slice(-6).toUpperCase()}`;
  const issuedAt = sr.proformaIssuedAt ?? sr.quotedAt ?? sr.createdAt;
  const lines = details?.lines ?? [{
    title: sr.product?.title ?? sr.productCategory ?? 'Requested equipment',
    qty: sr.quotedQuantity ?? 1,
    unitCents: sr.quotedUnitCents ?? sr.quotedPriceCents,
  }];
  const subtotal = lines.reduce((s, l) => s + Math.round(l.unitCents * l.qty), 0);
  const snap = await buildSnapshot({
    kind: 'QUOTE',
    lang: details?.lang ?? langOf(sr.submittedBy?.docLanguage, (await getGeneral()).defaultLang),
    number,
    issuedAt,
    currency: sr.quotedCurrency || 'EUR',
    customer: { name: sr.buyerName, company: sr.companyName, email: sr.buyerEmail, addressLines: [] },
    lines,
    shippingCents: order?.shippingCents ?? 0,
    vat: details?.vat ?? { treatment: 'LEGACY', rateBp: 0, reason: 'Issued before editable documents.' },
    refs: { quoteNumber: number, orderNumber: order?.orderNumber ?? null },
    note: sr.quotedNote,
    validUntil: sr.validUntilAt,
    fixedTotals: details ? undefined : {
      subtotalCents: subtotal,
      shippingCents: order?.shippingCents ?? 0,
      vatCents: order?.taxCents ?? 0,
      totalCents: order?.totalCents ?? subtotal,
    },
  });
  try {
    const doc = await prisma.issuedDocument.create({
      data: {
        kind: 'QUOTE', number, revision: 1, sourcingRequestId: sr.id, lang: snap.lang,
        snapshot: snap as unknown as Prisma.InputJsonValue, totalCents: snap.totalCents, currency: snap.currency,
        vatTreatment: snap.vat.treatment, issuedAt,
      },
    });
    return attachPdf(doc);
  } catch {
    // A concurrent first view froze it already.
    return currentQuoteDoc(srId);
  }
}

// ─── Invoice + receipt ─────────────────────────────────────────────────

const orderInclude = {
  buyer: { select: { id: true, name: true, email: true, docLanguage: true } },
  items: true,
} satisfies Prisma.OrderInclude;

type OrderForDoc = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

async function orderSnapshotBase(order: OrderForDoc, kind: DocKind, number: string, issuedAt: Date) {
  const billing = addressLinesFrom(order.billingAddress);
  const shipping = addressLinesFrom(order.shippingAddress);
  const quote = order.sourcingRequestId
    ? await prisma.sourcingRequest.findUnique({
        where: { id: order.sourcingRequestId },
        select: { proformaNumber: true, companyName: true, buyerName: true, quoteDetails: true },
      })
    : null;
  const qd = parseQuoteDetails(quote?.quoteDetails);
  const general = await getGeneral();
  const lang: Lang = langOf(order.docLanguage, qd?.lang, order.buyer.docLanguage, general.defaultLang);
  const rateBp = order.vatRateBp ?? 0;
  // Lines keep the quote's second row (serial, condition) when the order came from it.
  const lines = order.items.map((i, n) => {
    const q = qd && qd.lines.length === order.items.length ? qd.lines[n] : null;
    return { title: i.titleSnapshot, qty: i.quantity, unitCents: i.priceCentsSnapshot, detail: q && q.title === i.titleSnapshot ? q.detail ?? null : null };
  });
  // Company / VAT ID: billing address, else the delivery address form, else the quote.
  const vatId = billing.vat ?? shipping.vat ?? qd?.billing.vatId ?? null;
  return {
    kind,
    lang,
    number,
    issuedAt,
    currency: order.currency,
    customer: {
      name: billing.name || qd?.billing.name || order.buyer.name || quote?.buyerName || order.buyer.email,
      company: billing.company ?? shipping.company ?? qd?.billing.company ?? quote?.companyName ?? null,
      email: order.buyer.email,
      addressLines: withCountryName(billing.lines.length ? billing.lines : [...(qd?.billing.addressLines ?? []), ...(qd?.billing.country ? [qd.billing.country] : [])], lang),
      country: billing.country ?? qd?.billing.country ?? order.buyerCountry ?? null,
      vatId,
      number: `C-${order.buyerId.slice(-6).toUpperCase()}`,
    },
    shipTo: shipping.lines.length && shipping.lines.join('|') !== billing.lines.join('|') ? withCountryName([shipping.name, ...shipping.lines].filter(Boolean) as string[], lang) : null,
    lines,
    shippingCents: order.shippingCents,
    vat: { treatment: (order.vatTreatment as DocSnapshot['vat']['treatment']) || 'LEGACY', rateBp, reason: null },
    refs: { orderNumber: order.orderNumber, quoteNumber: quote?.proformaNumber ?? null },
    // The amounts the buyer actually paid are the truth for an order.
    fixedTotals: {
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      vatCents: order.taxCents,
      totalCents: order.totalCents,
    },
  };
}

export async function currentOrderDoc(orderId: string, kind: 'INVOICE' | 'RECEIPT'): Promise<IssuedDocument | null> {
  return prisma.issuedDocument.findFirst({ where: { kind, orderId, voidedAt: null }, orderBy: { revision: 'desc' } });
}

/**
 * The invoice of a PAID order, issued once (idempotent). Orders created before
 * editable documents keep their order number as invoice number — that is the
 * number their earlier invoice e-mail carried.
 */
export async function ensureInvoice(orderId: string, actorId?: string | null): Promise<IssuedDocument | null> {
  const existing = await currentOrderDoc(orderId, 'INVOICE');
  if (existing) return existing;
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order || !PAID_ORDER_STATES.includes(order.status)) return null;
  const numbering = await getNumbering();
  const issuedAt = order.paidAt ?? new Date();
  const company = await companySnapshot({ withLogo: (await getOptions('INVOICE')).showLogo });
  const base = await orderSnapshotBase(order, 'INVOICE', order.orderNumber, issuedAt);
  try {
    const doc = await prisma.$transaction(async (tx) => {
      const again = await tx.issuedDocument.findFirst({ where: { kind: 'INVOICE', orderId, voidedAt: null } });
      if (again) return again;
      const legacy = !order.vatTreatment;
      const number = legacy
        ? order.orderNumber
        : await allocateNumber(tx, 'INVOICE', numbering.INVOICE, issuedAt, async (n) => (await tx.issuedDocument.count({ where: { kind: 'INVOICE', number: n } })) > 0);
      const snap = await buildSnapshot({
        ...base,
        number,
        company,
        paid: true,
        paidAt: order.paidAt ?? issuedAt,
        paymentMethod: order.paymentMethodManual ?? (order.stripePaymentIntentId ? 'CARD' : 'BANK_TRANSFER'),
      });
      return insertDoc(tx, snap, { orderId, issuedById: actorId });
    }, TX);
    return doc.pdf ? doc : attachPdf(doc);
  } catch (e) {
    await logError('documents.issue.invoice', e);
    throw e;
  }
}

export async function ensureReceipt(orderId: string, actorId?: string | null): Promise<IssuedDocument | null> {
  const existing = await currentOrderDoc(orderId, 'RECEIPT');
  if (existing) return existing;
  const invoice = await ensureInvoice(orderId, actorId);
  if (!invoice) return null;
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) return null;
  const numbering = await getNumbering();
  const issuedAt = order.paidAt ?? new Date();
  const company = await companySnapshot({ withLogo: (await getOptions('RECEIPT')).showLogo });
  const base = await orderSnapshotBase(order, 'RECEIPT', invoice.number, issuedAt);
  const doc = await prisma.$transaction(async (tx) => {
    const again = await tx.issuedDocument.findFirst({ where: { kind: 'RECEIPT', orderId, voidedAt: null } });
    if (again) return again;
    const number = numbering.RECEIPT.useInvoiceNumber || !order.vatTreatment
      ? invoice.number
      : await allocateNumber(tx, 'RECEIPT', numbering.RECEIPT, issuedAt, async (n) => (await tx.issuedDocument.count({ where: { kind: 'RECEIPT', number: n } })) > 0);
    const snap = await buildSnapshot({
      ...base,
      number,
      company,
      refs: { ...base.refs, invoiceNumber: invoice.number },
      paid: true,
      paidAt: order.paidAt ?? issuedAt,
      paymentMethod: order.paymentMethodManual ?? (order.stripePaymentIntentId ? 'CARD' : 'BANK_TRANSFER'),
    });
    return insertDoc(tx, snap, { orderId, issuedById: actorId });
  }, TX);
  return doc.pdf ? doc : attachPdf(doc);
}

/**
 * An unpaid order's payment request (cart orders have no quote): rendered
 * live from the invoice template, never stored and never numbered as an
 * invoice — it carries the order number.
 */
export async function paymentRequestSnapshot(orderId: string): Promise<DocSnapshot | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) return null;
  const base = await orderSnapshotBase(order, 'INVOICE', order.orderNumber, order.createdAt);
  return buildSnapshot({ ...base, paid: false });
}

export async function currentVatSettings() {
  return getVatSettings();
}
