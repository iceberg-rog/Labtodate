import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type FiscalDocument } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  ensureSettingsLoaded,
  settingBool,
  settingEnum,
  settingInt,
  settingList,
  settingPercentBp,
  settingString,
} from '@/lib/settings';
import { getCompany } from '@/lib/invoice';
import { resolveOrderVat, addressCountry, type OrderVatResolution } from '@/lib/tax/order';
import { loadCountryFacts, loadTaxSettings } from '@/lib/tax/settings';
import { taxOn, vatInMargin, type VatTreatmentCode } from '@/lib/tax/determine';
import { uploadObject, getObjectBytes } from '@/lib/storage/s3';
import type { EmailAttachment } from '@/lib/email';
import { allocateNumber, businessTimeZone, loadNumberingSettings, fiscalYearOf, type DocSeries, type NumberingSettings } from './numbering';
import {
  addressGaps,
  chargedVat,
  docTitle,
  missingInvoiceDetails,
  negateLines,
  negateRows,
  partyFromAddress,
  splitGrossOverRows,
  vatLabel,
  vatRowsFromDecision,
  type CreditSettlement,
  type DocKindCode,
  type DocLineSnapshot,
  type DocPartySnapshot,
  type DocPaymentBox,
  type DocumentSnapshot,
  type DocVatRowSnapshot,
} from './snapshot';
import { fmtDocMoney, renderDocumentHtml } from './render';
import { addDaysEndOfDay } from '@/lib/orders/payment-due';
import { htmlToPdf, pdfPageCount } from './pdf';
import { companyLogoDataUri } from './logo';
import { DOC_LABEL_KEYS, DOC_LOCALES, defaultDocLabel, docLabelSettingKey, fillLabel, type DocLabelKey, type DocLanguage } from './labels';
import { orderDetailsProblems } from '@/lib/orders/details';
import { QUOTE_REF as quoteReference } from '@/lib/quotes/offer';
import { primaryHold } from '@/lib/checkout/engine';

/**
 * Issuing commercial documents (B02 / A02 / A03 / A04).
 *
 *  issueProforma(orderId)        payment request (PF series) — one CURRENT per order;
 *                                reissueProforma() makes revision 2, 3… (old one superseded)
 *  issueInvoice(orderId)         tax invoice (INV series) — once per order, after payment;
 *                                VAT checked by the VAT engine, legal details enforced
 *  issueCreditNote({orderId})    credit note (CN series) referencing the invoice
 *  freezeLegacyDocuments(id)     pre-4_business_core documents frozen as they rendered
 *
 * Every function allocates the number INSIDE the transaction that inserts the
 * FiscalDocument (gap-free), builds the immutable snapshot, and — after commit —
 * renders the PDF from the snapshot once and stores it in S3 with its sha256
 * (ensureDocumentPdf). Downloads and email attachments always use the stored
 * bytes. DB triggers make the row immutable; corrections are new documents.
 */

export const ORDER_DOC_INCLUDE = {
  items: { include: { product: { select: { vatScheme: true, purchaseCostCents: true } } } },
  // The payments ledger: what came in and when (value date) — the invoice's "paid" box.
  payments: { select: { amountCents: true, receivedAt: true, method: true }, orderBy: { receivedAt: 'asc' } },
  buyer: { select: { name: true, email: true, company: { select: { name: true } } } },
  sourcingRequest: {
    select: {
      id: true, buyerName: true, buyerEmail: true, companyName: true, quotedNote: true, proformaNumber: true,
      proformaIssuedAt: true, validUntilAt: true, paymentInstructionsSnapshot: true, status: true, offerTerms: true,
    },
  },
} satisfies Prisma.OrderInclude;

export type OrderForDoc = Prisma.OrderGetPayload<{ include: typeof ORDER_DOC_INCLUDE }>;

export type IssueFailCode =
  | 'NOT_FOUND'
  | 'NOT_PAID'
  | 'NOT_PAYABLE'
  | 'VAT_REVIEW'
  | 'MISSING_DETAILS'
  | 'NO_INVOICE'
  | 'NOTHING_TO_CREDIT'
  | 'ERROR';

export type IssueResult =
  | { ok: true; document: FiscalDocument; created: boolean; warnings: string[] }
  | { ok: false; code: IssueFailCode; message: string; missing?: string[] };

type Tx = Prisma.TransactionClient;

const PAID_STATES = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'];

/** Holds that make an unpaid order NOT payable yet (lib/checkout/holds.ts) — no payment request. */
const PRE_PAYMENT_HOLDS = ['COMPLIANCE', 'VAT_REVIEW', 'ADDRESS_REVIEW', 'SHIPPING_PENDING'];
export function prePaymentHoldMessage(o: { orderNumber: string; holdReason: string | null; openHolds: string[] }): string | null {
  const open = [...o.openHolds, ...(o.holdReason ? [o.holdReason] : [])].filter((h) => PRE_PAYMENT_HOLDS.includes(h));
  if (!open.length) return null;
  const what: Record<string, string> = { COMPLIANCE: 'an export-compliance review', VAT_REVIEW: 'a VAT decision', ADDRESS_REVIEW: 'an address-change review', SHIPPING_PENDING: 'the shipping cost' };
  return `Order ${o.orderNumber} is waiting for ${Array.from(new Set(open)).map((h) => what[h]).join(' and ')} — no proforma (payment request) is issued until that is done.`;
}
const QUOTE_REF = (id: string) => quoteReference(id);

// ── document texts, language, country names (frozen into each snapshot) ──────

/**
 * Everything a document prints that does not come from the order: the fixed
 * texts in the document language (labels.ts + DOC_TEXT_* overrides), the
 * formats, country names and the EU list. Resolved once per issue and frozen
 * into the snapshot, so a later settings change never alters it.
 */
export interface DocContext {
  lang: DocLanguage;
  labels: Record<DocLabelKey, string>;
  locale: NonNullable<DocumentSnapshot['locale']>;
  countryName: (code: string) => string;
  isEu: (code: string) => boolean;
}

/** Sync — call after ensureSettingsLoaded(); `facts` = country table (names / EU), loaded outside any transaction. */
export function docContextFrom(facts: { names: Map<string, string>; eu: Set<string> }): DocContext {
  const lang: DocLanguage = settingEnum<string>('DOC_LANGUAGE') === 'nl' ? 'nl' : 'en';
  const labels = {} as Record<DocLabelKey, string>;
  for (const k of DOC_LABEL_KEYS) labels[k] = settingString(docLabelSettingKey(k)).trim() || defaultDocLabel(k, lang);
  const l = DOC_LOCALES[lang];
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames([l.dateLocale], { type: 'region' });
  } catch {
    display = null;
  }
  return {
    lang,
    labels,
    locale: { lang, dateLocale: l.dateLocale, moneyLocale: l.moneyLocale, timeZone: businessTimeZone() },
    // English: the name staff keep in the country table; otherwise the language's own name.
    countryName: (code) => (lang === 'en' ? facts.names.get(code) : null) ?? display?.of(code) ?? code,
    isEu: (code) => facts.eu.has(code),
  };
}

/** Country table facts for documents (names, EU membership) — never inside a transaction. */
export async function loadDocFacts(): Promise<{ names: Map<string, string>; eu: Set<string> }> {
  const rows = await prisma.countryPolicy.findMany({ select: { country: true, name: true, isEu: true } }).catch(() => []);
  return { names: new Map(rows.map((r) => [r.country, r.name])), eu: new Set(rows.filter((r) => r.isEu).map((r) => r.country)) };
}

async function docContext(): Promise<DocContext> {
  return docContextFrom(await loadDocFacts());
}

// ── snapshot building ────────────────────────────────────────────────────────

function sellerSnapshot(): DocumentSnapshot['seller'] {
  const c = getCompany();
  return {
    name: c.name,
    addressLines: c.addrLines,
    country: c.country,
    city: c.city,
    kvk: c.kvk,
    vatId: c.vat,
    eori: settingString('COMPANY_EORI'),
    email: c.email,
    phone: c.phone,
    web: c.web,
    logoPath: c.logoPath,
  };
}

function bankSnapshot(): DocumentSnapshot['bank'] {
  const c = getCompany();
  const iban = settingString('BANK_IBAN');
  if (!iban) return null;
  return { beneficiary: c.name, bankName: settingString('BANK_NAME'), iban, bic: settingString('BANK_SWIFT') };
}

/**
 * Bill-to / ship-to (owner review: one clear structure). Bill-to: the legal
 * name of the customer (company), "Attn." the contact person, the full
 * address with the country name, the VAT ID and the accounts-payable e-mail.
 * A private buyer: their name instead of a company. Ship-to: company /
 * recipient / address / phone.
 */
function buyerParties(order: OrderForDoc, vatId: string | null, ctx: DocContext): { buyer: DocPartySnapshot; shipTo: DocPartySnapshot | null } {
  const sr = order.sourcingRequest;
  const accountName = (sr?.buyerName || order.buyer.name || '').trim() || order.buyer.email;
  const billRaw = order.billingAddress && typeof order.billingAddress === 'object' ? order.billingAddress : order.shippingAddress;
  const bill = partyFromAddress(billRaw, accountName, ctx.countryName);
  const ship = partyFromAddress(order.shippingAddress, accountName, ctx.countryName);
  const company = bill?.company ?? sr?.companyName ?? order.buyer.company?.name ?? null;
  // The contact the buyer named in the billing details, else the person who ordered.
  const contact = (bill?.name ?? '').trim() || accountName;
  const buyer: DocPartySnapshot = {
    name: contact,
    company,
    attention: company && contact && contact.toLowerCase() !== company.toLowerCase() ? contact : null,
    // The accounts-payable address the buyer gave (Order.invoiceEmail — checkout or the
    // details form of a quote order), else the billing / quote e-mail, else the account.
    email: order.invoiceEmail ?? bill?.email ?? sr?.buyerEmail ?? order.buyer.email,
    phone: bill?.phone ?? null,
    vatId: vatId ?? bill?.vatId ?? null,
    lines: bill?.lines ?? [],
    country: bill?.country ?? null,
  };
  const shipTo: DocPartySnapshot | null = ship && ship.lines.length
    ? {
        ...ship,
        vatId: null,
        email: null,
        attention: ship.company && ship.name && ship.name.toLowerCase() !== ship.company.toLowerCase() ? ship.name : null,
      }
    : null;
  return { buyer, shipTo };
}

/** EU Reg. 833/2014 art. 12g clause — destinations outside the EU (country table) and outside the partner list. */
function noRussiaClause(order: OrderForDoc, ctx: DocContext): string[] {
  if (!settingBool('NO_RUSSIA_CLAUSE_ENABLED')) return [];
  const dest = addressCountry(order.shippingAddress) ?? addressCountry(order.billingAddress);
  if (!dest) return [];
  if (ctx.isEu(dest) || settingList('NO_RUSSIA_CLAUSE_EXEMPT_COUNTRIES').includes(dest)) return [];
  const text = settingString('NO_RUSSIA_CLAUSE_TEXT');
  return text ? [text] : [];
}

/** Commercial references printed on proformas and invoices: the buyer's PO
 *  number (billing details) and the accepted offer's delivery terms / lead time. */
function commercialRefs(order: OrderForDoc, ctx: DocContext): Array<{ label: string; value: string }> {
  const refs: Array<{ label: string; value: string }> = [];
  const bill = order.billingAddress && typeof order.billingAddress === 'object' ? (order.billingAddress as Record<string, unknown>) : null;
  // Checkout keeps the PO in Order.poNumber (7a); the details form also in the billing JSON.
  const po = (typeof bill?.poNumber === 'string' && bill.poNumber.trim()) || (order.poNumber ?? '').trim();
  if (po) refs.push({ label: ctx.labels.YOUR_PO, value: po.slice(0, 60) });
  const t = order.sourcingRequest?.offerTerms && typeof order.sourcingRequest.offerTerms === 'object' ? (order.sourcingRequest.offerTerms as Record<string, unknown>) : null;
  const inc = typeof t?.incoterm === 'string' ? `${t.incoterm}${typeof t.incotermPlace === 'string' && t.incotermPlace ? ` ${t.incotermPlace}` : ''} (Incoterms 2020)` : '';
  if (inc) refs.push({ label: ctx.labels.DELIVERY_TERMS, value: inc.slice(0, 120) });
  if (typeof t?.leadTime === 'string' && t.leadTime.trim()) refs.push({ label: ctx.labels.LEAD_TIME, value: t.leadTime.trim().slice(0, 120) });
  return refs;
}

/** NET days of an order approved on invoice terms (Order.paymentTerms), else null. */
function netDaysOf(paymentTerms: unknown): number | null {
  if (!paymentTerms || typeof paymentTerms !== 'object') return null;
  const t = paymentTerms as Record<string, unknown>;
  return t.kind === 'NET' && typeof t.netDays === 'number' && t.netDays > 0 ? t.netDays : null;
}

function textLines(key: string): string[] {
  return settingString(key).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function paymentMethodLabel(o: { paymentMethodBrand: string | null; paymentMethodLast4: string | null; paymentMethodManual: string | null }): string | null {
  if (o.paymentMethodBrand) {
    return `${o.paymentMethodBrand.toUpperCase().replace(/_/g, ' ')}${o.paymentMethodLast4 ? ` •••• ${o.paymentMethodLast4}` : ''}`;
  }
  if (o.paymentMethodManual) {
    const m = o.paymentMethodManual.toUpperCase();
    return m === 'BANK_TRANSFER' || m === 'RECEIPT' ? 'Bank transfer' : m === 'INVOICE' ? null : m.replace(/_/g, ' ').toLowerCase();
  }
  return null;
}

interface VatPlan {
  /** ENGINE: amounts + legal text from the VAT engine; CHARGED: what the order charged (legacy). */
  mode: 'ENGINE' | 'CHARGED';
  treatment: VatTreatmentCode;
  lines: DocLineSnapshot[];
  rows: DocVatRowSnapshot[];
  legalText: string | null;
  buyerVatId: string | null;
  viesConsultation: string | null;
  pendingNote: string | null;
  reasons: string[];
}

function orderDocLines(order: OrderForDoc, ctx: DocContext): Array<Omit<DocLineSnapshot, 'vatRateBp' | 'taxCents'>> {
  const lines: Array<Omit<DocLineSnapshot, 'vatRateBp' | 'taxCents'>> = order.items.map((i) => ({
    description: i.titleSnapshot,
    // Brand · condition · warranty exactly as promised at the moment of sale
    // (OrderItem snapshot; a quote order: the accepted offer's warranty) —
    // never re-read from the live listing.
    detail: [i.brandSnapshot, i.conditionSnapshot, i.warrantySnapshot ? `${ctx.labels.WARRANTY}: ${i.warrantySnapshot}` : null]
      .filter(Boolean)
      .join(' · ') || null,
    qty: i.quantity,
    unitCents: i.priceCentsSnapshot,
    netCents: i.priceCentsSnapshot * i.quantity,
    lineType: (i.lineType === 'SHIPPING' || i.lineType === 'SERVICE' || i.lineType === 'DISCOUNT' ? i.lineType : 'GOODS') as DocLineSnapshot['lineType'],
  }));
  if (order.shippingCents > 0 && !lines.some((l) => l.lineType === 'SHIPPING')) {
    lines.push({ description: ctx.labels.SHIPPING_LINE, detail: null, qty: 1, unitCents: order.shippingCents, netCents: order.shippingCents, lineType: 'SHIPPING' });
  }
  return lines;
}

/** Decide how the document shows VAT, from the order + the engine's view of it. */
function planVat(order: OrderForDoc, res: OrderVatResolution | null, kind: DocKindCode, ctx: DocContext): VatPlan {
  const base = orderDocLines(order, ctx);
  const useEngine = !!res && (res.status === 'RECORDED' || res.status === 'MATCH');
  if (useEngine && res) {
    const d = res.decision;
    const lines = base.map((l, i) => ({ ...l, vatRateBp: d.lines[i]?.rateBp ?? d.rateBp, taxCents: d.lines[i]?.taxCents ?? 0 }));
    return {
      mode: 'ENGINE',
      treatment: d.treatment,
      lines,
      rows: res.status === 'RECORDED' ? d.breakdown.map((r) => ({ rateBp: r.rateBp, baseCents: r.baseCents, taxCents: r.taxCents })) : vatRowsFromDecision(d),
      legalText: d.legalText,
      buyerVatId: d.buyerVatIdRequired ? res.vatId?.vatId ?? null : null,
      viesConsultation: res.vatId?.consultationNumber ?? null,
      pendingNote: null,
      reasons: d.reasons,
    };
  }
  // CHARGED: what the order actually charged (interim flat rate), shown honestly.
  const goods = base.filter((l) => l.lineType !== 'SHIPPING').reduce((a, l) => a + l.netCents, 0);
  const ship = base.filter((l) => l.lineType === 'SHIPPING').reduce((a, l) => a + l.netCents, 0);
  // The interim flat rate these older orders were priced with, then the home
  // standard rate and the Dutch reduced rate (whichever produced the charged amount).
  const cv = chargedVat(goods, ship, order.taxCents, settingPercentBp('DEFAULT_TAX_PERCENT'), [settingPercentBp('TAX_STANDARD_RATE_PCT'), 900]);
  const lines = base.map((l) => {
    const rate = l.lineType === 'SHIPPING' ? cv.shippingRateBp : cv.goodsRateBp;
    return { ...l, vatRateBp: rate, taxCents: rate == null ? 0 : taxOn(l.netCents, rate) };
  });
  let pendingNote: string | null = null;
  if (kind === 'PROFORMA') {
    pendingNote = !res || res.status === 'UNDETERMINED' ? ctx.labels.VAT_PENDING_UNKNOWN : ctx.labels.VAT_PENDING_REVIEW;
  }
  return {
    mode: 'CHARGED',
    treatment: order.vatTreatment && order.vatTreatment !== 'LEGACY_UNSPECIFIED' ? (order.vatTreatment as VatTreatmentCode) : res && res.status !== 'UNDETERMINED' ? 'REVIEW_REQUIRED' : 'LEGACY_UNSPECIFIED',
    lines,
    rows: cv.rows,
    legalText: null,
    buyerVatId: null,
    viesConsultation: null,
    pendingNote,
    reasons: res ? [res.message] : ['Order priced before the VAT rules; shown as charged.'],
  };
}

interface SnapshotArgs {
  kind: DocKindCode;
  number: string;
  version: number;
  issueDate: Date;
  supplyDate: Date | null;
  dueDate: Date | null;
  order: OrderForDoc;
  vat: VatPlan;
  payment: DocPaymentBox;
  refs: Array<{ label: string; value: string }>;
  notes: string[];
  terms: string[];
  original: { number: string; issueDate: string } | null;
  legacy?: boolean;
  warnings?: string[];
  /** Texts, language, country names (frozen into the snapshot). */
  ctx: DocContext;
  /** Prepaid, not shipped yet: the advance payment's value date instead of a supply date. */
  advancePaymentDate?: Date | null;
}

function buildSnapshot(a: SnapshotArgs): DocumentSnapshot {
  const { buyer, shipTo } = buyerParties(a.order, a.vat.buyerVatId, a.ctx);
  const goods = a.vat.lines.filter((l) => l.lineType !== 'SHIPPING').reduce((s, l) => s + l.netCents, 0);
  const shipping = a.vat.lines.filter((l) => l.lineType === 'SHIPPING').reduce((s, l) => s + l.netCents, 0);
  const tax = a.vat.rows.reduce((s, r) => s + r.taxCents, 0);
  return {
    v: 1,
    kind: a.kind,
    title: a.legacy ? docTitle(a.kind) : a.kind === 'PROFORMA' ? a.ctx.labels.TITLE_PROFORMA : a.kind === 'INVOICE' ? a.ctx.labels.TITLE_INVOICE : a.ctx.labels.TITLE_CREDIT_NOTE,
    number: a.number,
    version: a.version,
    issueDate: a.issueDate.toISOString(),
    supplyDate: a.supplyDate ? a.supplyDate.toISOString() : null,
    dueDate: a.dueDate ? a.dueDate.toISOString() : null,
    currency: a.order.currency,
    orderNumber: a.order.orderNumber,
    refs: a.refs,
    seller: sellerSnapshot(),
    bank: bankSnapshot(),
    buyer,
    shipTo,
    lines: a.vat.lines,
    vat: {
      treatment: a.vat.treatment,
      label: vatLabel(a.vat.treatment),
      rows: a.vat.rows,
      legalText: a.vat.legalText,
      buyerVatId: a.vat.buyerVatId,
      viesConsultation: a.vat.viesConsultation,
      pendingNote: a.vat.pendingNote,
    },
    totals: { goodsCents: goods, shippingCents: shipping, netCents: goods + shipping, taxCents: tax, totalCents: goods + shipping + tax },
    payment: a.payment,
    notes: a.notes,
    terms: a.terms,
    clauses: noRussiaClause(a.order, a.ctx),
    original: a.original,
    footerExtra: settingString('DOC_FOOTER_TEXT') || null,
    ...(a.advancePaymentDate ? { advancePaymentDate: a.advancePaymentDate.toISOString() } : {}),
    // Legacy documents keep the English texts they were printed with (no frozen labels).
    ...(a.legacy ? { legacy: true } : { labels: { ...a.ctx.labels }, locale: a.ctx.locale }),
    audit: { vatReasons: a.vat.reasons, warnings: a.warnings ?? [] },
  };
}

async function loadOrder(db: Tx | typeof prisma, orderId: string): Promise<OrderForDoc | null> {
  return db.order.findUnique({ where: { id: orderId }, include: ORDER_DOC_INCLUDE });
}

async function lockOrder(tx: Tx, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
}

async function insertDoc(
  tx: Tx,
  data: Omit<Prisma.FiscalDocumentUncheckedCreateInput, 'snapshot'> & { snapshot: DocumentSnapshot },
): Promise<FiscalDocument> {
  return tx.fiscalDocument.create({
    data: {
      ...data,
      subtotalCents: data.snapshot.totals.netCents,
      taxCents: data.snapshot.totals.taxCents,
      totalCents: data.snapshot.totals.totalCents,
      snapshot: data.snapshot as unknown as Prisma.InputJsonValue,
    },
  });
}

// ── proformas ────────────────────────────────────────────────────────────────

export async function currentProforma(db: Tx | typeof prisma, orderId: string): Promise<FiscalDocument | null> {
  return db.fiscalDocument.findFirst({
    where: { orderId, kind: 'PROFORMA', supersededById: null, voidedAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Allocate the next number of a series, THEN take the issue time — after the
 * series row lock, so under concurrency a higher number never carries an
 * earlier time. Around midnight on the fiscal-year boundary the two could
 * fall in different years: then nothing is issued (the transaction rolls the
 * counter back) and the caller is told to retry.
 */
async function allocateWithIssueDate(tx: Tx, series: DocSeries, numbering: NumberingSettings): Promise<{ alloc: Awaited<ReturnType<typeof allocateNumber>>; issueDate: Date }> {
  const alloc = await allocateNumber(tx, series, new Date(), numbering);
  const issueDate = new Date();
  if (fiscalYearOf(issueDate, numbering.fiscalYearStartMonth, numbering.timeZone) !== alloc.fiscalYear) {
    throw new IssueError('ERROR', 'The fiscal year changed while the document was being numbered — nothing was issued. Please try again.');
  }
  return { alloc, issueDate };
}

async function issueProformaTx(
  tx: Tx,
  orderId: string,
  opts: { actorId?: string | null; dueDate?: Date | null; vat: OrderVatResolution | null; supersede?: { reason: string } | null; ctx: DocContext },
): Promise<{ document: FiscalDocument; created: boolean }> {
  await lockOrder(tx, orderId);
  const order = await loadOrder(tx, orderId);
  if (!order) throw new IssueError('NOT_FOUND', 'Order not found.');
  const existing = await currentProforma(tx, orderId);
  if (existing && !opts.supersede) return { document: existing, created: false };

  const numbering = loadNumberingSettings();
  let number: string;
  let fiscalYear: number;
  let seq: number | null;
  let version = 1;
  let issueDate: Date;
  const newId = randomUUID().replace(/-/g, '').slice(0, 25);
  if (existing) {
    // Revision of the same proforma: same base number, "-r<version>", no new sequence number.
    version = existing.version + 1;
    const base = existing.number.replace(/-r\d+$/, '');
    number = `${base}-r${version}`;
    fiscalYear = existing.fiscalYear;
    seq = null;
    issueDate = new Date();
    await tx.fiscalDocument.update({ where: { id: existing.id }, data: { supersededById: newId } });
  } else {
    const a = await allocateWithIssueDate(tx, 'PROFORMA', numbering);
    number = a.alloc.number;
    fiscalYear = a.alloc.fiscalYear;
    seq = a.alloc.seq;
    issueDate = a.issueDate;
  }
  const L = opts.ctx.labels;
  // A25: one due date — what the proforma prints is what the payment page,
  // the reminders and the auto-cancel sweep use (Order.dueAt). A checkout
  // order gets the payment term from the moment it became payable (order date,
  // or the release of a pre-payment hold — Order.payableSince) (PAYMENT_TERM_DAYS).
  const dueDate = opts.dueDate ?? order.dueAt ?? order.sourcingRequest?.validUntilAt ?? addDaysEndOfDay(order.payableSince ?? order.createdAt, settingInt('PAYMENT_TERM_DAYS', 14));
  const vat = planVat(order, opts.vat, 'PROFORMA', opts.ctx);
  const sr = order.sourcingRequest;
  const snapshot = buildSnapshot({
    kind: 'PROFORMA',
    number,
    version,
    issueDate,
    supplyDate: null,
    dueDate,
    order,
    vat,
    payment: { kind: 'INSTRUCTIONS', reference: number, amountCents: order.totalCents, dueDate: dueDate ? dueDate.toISOString() : null, bankAvailable: !!settingString('BANK_IBAN') },
    refs: [
      { label: L.ORDER_NO, value: order.orderNumber },
      ...(sr ? [{ label: L.QUOTE_REF, value: QUOTE_REF(sr.id) }] : []),
      ...(existing ? [{ label: L.REPLACES, value: existing.number }] : []),
      ...commercialRefs(order, opts.ctx),
    ],
    notes: sr?.quotedNote?.trim() ? [sr.quotedNote.trim()] : [],
    terms: textLines('PROFORMA_TERMS_TEXT'),
    original: null,
    warnings: opts.supersede ? [`Revision: ${opts.supersede.reason}`] : [],
    ctx: opts.ctx,
  });
  const document = await insertDoc(tx, {
    id: newId,
    kind: 'PROFORMA',
    number,
    series: 'PROFORMA',
    fiscalYear,
    seq,
    version,
    orderId: order.id,
    sourcingRequestId: sr?.id ?? null,
    issueDate,
    dueDate,
    currency: order.currency,
    vatTreatment: vat.treatment,
    issuedById: opts.actorId ?? null,
    snapshot,
  } as Omit<Prisma.FiscalDocumentUncheckedCreateInput, 'snapshot'> & { snapshot: DocumentSnapshot });
  await tx.order.update({ where: { id: order.id }, data: { proformaNumber: number, ...(dueDate && !order.dueAt ? { dueAt: dueDate } : {}) } });
  return { document, created: true };
}

/**
 * A proforma asks for an amount that must not change afterwards: with
 * “Billing & delivery details before payment” on, it is only issued once the
 * billing and delivery details are on the order (they decide VAT and freight).
 */
function proformaDetailsMissing(order: OrderForDoc): string | null {
  if (!settingBool('REQUIRE_DETAILS_BEFORE_PAYMENT')) return null;
  const rule = settingEnum<'EU' | 'ALWAYS' | 'OFF'>('DETAILS_VAT_ID_REQUIRED');
  const missing = orderDetailsProblems(order, { vatIdRule: order.customerType === 'CONSUMER' ? 'OFF' : rule });
  return missing.length
    ? `No proforma (payment request) yet for order ${order.orderNumber}: missing ${missing.join(', ')}. The billing and delivery details decide the VAT and the shipment, so the amount could still change — add them first (“Billing & delivery details”).`
    : null;
}

class IssueError extends Error {
  constructor(public code: IssueFailCode, message: string, public missing?: string[]) {
    super(message);
  }
}

function fail(e: unknown): IssueResult {
  if (e instanceof IssueError) return { ok: false, code: e.code, message: e.message, missing: e.missing };
  return { ok: false, code: 'ERROR', message: readableIssueError(e, 'document') };
}

/**
 * Issue the order's proforma (idempotent: returns the current one if it
 * exists). With `opts.tx` it runs inside the caller's transaction (offer
 * acceptance) — then no VIES call is made and the PDF is NOT rendered (call
 * ensureDocumentPdf after the commit).
 */
export async function issueProforma(
  orderId: string,
  opts: { tx?: Tx; actorId?: string | null; dueDate?: Date | null } = {},
): Promise<IssueResult> {
  await ensureSettingsLoaded();
  try {
    const ctx = await docContext();
    if (opts.tx) {
      const order = await loadOrder(opts.tx, orderId);
      if (!order) return { ok: false, code: 'NOT_FOUND', message: 'Order not found.' };
      const vat = await resolveOrderVat(order, { skipVies: true });
      const r = await issueProformaTx(opts.tx, orderId, { actorId: opts.actorId, dueDate: opts.dueDate, vat, ctx });
      return { ok: true, document: r.document, created: r.created, warnings: [] };
    }
    const existing = await currentProforma(prisma, orderId);
    if (existing) return { ok: true, document: existing, created: false, warnings: [] };
    const order = await loadOrder(prisma, orderId);
    if (!order) return { ok: false, code: 'NOT_FOUND', message: 'Order not found.' };
    if (order.status !== 'PENDING_PAYMENT') {
      return { ok: false, code: 'NOT_PAYABLE', message: `Order ${order.orderNumber} is ${order.status.toLowerCase().replace(/_/g, ' ')} — a proforma (payment request) is only issued for an unpaid order.` };
    }
    const held = prePaymentHoldMessage(order);
    if (held) return { ok: false, code: 'NOT_PAYABLE', message: held };
    const missingDetails = proformaDetailsMissing(order);
    if (missingDetails) return { ok: false, code: 'MISSING_DETAILS', message: missingDetails };
    const vat = await resolveOrderVat(order);
    const r = await prisma.$transaction((tx) => issueProformaTx(tx, orderId, { actorId: opts.actorId, dueDate: opts.dueDate, vat, ctx }));
    return { ok: true, document: r.document, created: r.created, warnings: [] };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && !opts.tx) {
      const doc = await currentProforma(prisma, orderId);
      if (doc) return { ok: true, document: doc, created: false, warnings: [] };
    }
    return fail(e);
  }
}

/** New revision of the current proforma (e.g. billing address added, freight amended). */
export async function reissueProforma(orderId: string, reason: string, opts: { actorId?: string | null; dueDate?: Date | null } = {}): Promise<IssueResult> {
  await ensureSettingsLoaded();
  try {
    const order = await loadOrder(prisma, orderId);
    if (!order) return { ok: false, code: 'NOT_FOUND', message: 'Order not found.' };
    if (order.status !== 'PENDING_PAYMENT') return { ok: false, code: 'NOT_PAYABLE', message: 'Only an unpaid order gets a new proforma revision.' };
    const held = prePaymentHoldMessage(order);
    if (held) return { ok: false, code: 'NOT_PAYABLE', message: held };
    const missingDetails = proformaDetailsMissing(order);
    if (missingDetails) return { ok: false, code: 'MISSING_DETAILS', message: missingDetails };
    const vat = await resolveOrderVat(order);
    const ctx = await docContext();
    const r = await prisma.$transaction((tx) => issueProformaTx(tx, orderId, { actorId: opts.actorId, dueDate: opts.dueDate, vat, supersede: { reason }, ctx }));
    return { ok: true, document: r.document, created: r.created, warnings: [] };
  } catch (e) {
    return fail(e);
  }
}

/** Void the order's open proforma(s) (order canceled). Also done by a DB trigger on cancel. */
export async function voidProformas(orderId: string, reason: string, db: Tx | typeof prisma = prisma): Promise<number> {
  const r = await db.fiscalDocument.updateMany({
    where: { orderId, kind: 'PROFORMA', voidedAt: null, supersededById: null },
    data: { voidedAt: new Date(), voidReason: reason.slice(0, 300) },
  });
  return r.count;
}

// ── invoices ─────────────────────────────────────────────────────────────────

/**
 * The order's current invoice: the latest one. Normally the only one; after
 * a correction (credit note in full + corrected invoice) the corrected one.
 */
export async function orderInvoice(db: Tx | typeof prisma, orderId: string): Promise<FiscalDocument | null> {
  return db.fiscalDocument.findFirst({ where: { orderId, kind: 'INVOICE' }, orderBy: { createdAt: 'desc' } });
}

/** How much of an invoice credit notes have credited so far (positive cents). */
export async function creditedOnInvoice(db: Tx | typeof prisma, invoiceId: string): Promise<number> {
  const prior = await db.fiscalDocument.findMany({ where: { originalDocumentId: invoiceId, kind: 'CREDIT_NOTE' }, select: { totalCents: true } });
  return -prior.reduce((s, d) => s + d.totalCents, 0);
}

/**
 * What the payments ledger says about an order: the amount received and the
 * VALUE DATE of the payment that made it complete (what "paid in full on …"
 * means — never the date staff clicked). Orders paid before the ledger existed
 * have no rows: the recorded payment / verification date is used for them.
 */
export function paymentFacts(order: Pick<OrderForDoc, 'payments' | 'totalCents' | 'financialStatus' | 'amountPaidCents' | 'paidAt' | 'paymentVerifiedAt' | 'paymentMethodManual' | 'status'>, toleranceCents = 0): {
  paidCents: number;
  inFull: boolean;
  /** Value date of the payment that completed it (or of the latest payment when not complete). */
  paidAt: Date | null;
  method: string | null;
} {
  const due = Math.max(0, order.totalCents - Math.max(0, toleranceCents));
  let sum = 0;
  let completedAt: Date | null = null;
  let lastAt: Date | null = null;
  let method: string | null = null;
  for (const p of order.payments ?? []) {
    sum += p.amountCents;
    lastAt = p.receivedAt;
    method = p.method;
    if (!completedAt && sum >= due) completedAt = p.receivedAt;
  }
  if ((order.payments ?? []).length) return { paidCents: sum, inFull: !!completedAt, paidAt: completedAt ?? lastAt, method };
  const legacyPaid = order.financialStatus === 'PAID' && order.amountPaidCents === 0 && (order.paymentMethodManual ?? '').toUpperCase() !== 'INVOICE' && PAID_STATES.includes(order.status);
  if (legacyPaid) return { paidCents: order.totalCents, inFull: true, paidAt: order.paidAt ?? order.paymentVerifiedAt ?? null, method: null };
  return { paidCents: order.amountPaidCents, inFull: order.amountPaidCents >= due && order.amountPaidCents > 0, paidAt: order.paidAt ?? null, method: null };
}

/**
 * Supply date / advance-payment date (art. 35a Wet OB) per SUPPLY_DATE_RULE.
 * Default (SHIPPED_OR_ADVANCE_PAYMENT): the ship date once shipped; an invoice
 * issued when a payment is verified — before the goods leave — prints the
 * date the advance payment was received instead, never an invented supply date.
 */
function supplyDatesFor(order: OrderForDoc, issueDate: Date, paidAt: Date | null): { supplyDate: Date | null; advancePaymentDate: Date | null } {
  const rule = settingEnum<'SHIPPED_OR_ADVANCE_PAYMENT' | 'SHIPPED_OR_ISSUE' | 'ISSUE_DATE' | 'OMIT'>('SUPPLY_DATE_RULE');
  if (rule === 'OMIT') return { supplyDate: null, advancePaymentDate: null };
  if (rule === 'ISSUE_DATE') return { supplyDate: issueDate, advancePaymentDate: null };
  if (rule === 'SHIPPED_OR_ISSUE') return { supplyDate: order.shippedAt ?? issueDate, advancePaymentDate: null };
  if (order.shippedAt) return { supplyDate: order.shippedAt, advancePaymentDate: null };
  return { supplyDate: null, advancePaymentDate: paidAt };
}

/** One readable sentence for staff when issuing failed for a technical reason (never a raw Prisma dump). */
export function readableIssueError(e: unknown, what = 'invoice'): string {
  if (e instanceof IssueError) return e.message;
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const target = JSON.stringify(e.meta?.target ?? '');
    if (/number/.test(target)) {
      return `The next ${what} number is already used by an earlier document — the numbering settings (Settings → Invoicing & numbering) point at a number series that was used before. Nothing was issued and no number was used up.`;
    }
    if (/orderId/.test(target)) return `This order already has an ${what}. Reload the page.`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  const trigger = /(Fiscal document [^\n]+|Number series [^\n]+|Invoice [^\n]+ is not credited in full[^\n]*|A corrected invoice [^\n]+|Only a proforma [^\n]+)/.exec(msg);
  if (trigger) return `${trigger[1].trim()} Nothing was issued.`;
  return `A technical error stopped the ${what} (${msg.replace(/\s+/g, ' ').slice(0, 140)}). Nothing was issued and no number was used up; the details are in the error log.`;
}

/**
 * Put an order on a hold with its reason — the same shape as
 * lib/checkout/holds.ts addHold (openHolds + holdReason by priority + a
 * "CODE: detail" note), written here so issuing stays free of the request /
 * notification layer.
 */
async function writeHold(orderId: string, code: 'VAT_REVIEW' | 'INVOICE_PENDING', detail: string): Promise<void> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { openHolds: true, holdNote: true, holdReason: true, holdAt: true } });
  if (!o) return;
  const open = Array.from(new Set([...o.openHolds, ...(o.holdReason ? [o.holdReason] : []), code]));
  const notes = (o.holdNote ?? '').split(' | ').filter((p) => p && !p.startsWith(`${code}:`));
  await prisma.order.update({
    where: { id: orderId },
    data: {
      openHolds: open,
      holdReason: primaryHold(open),
      holdNote: [...notes, `${code}: ${detail}`].join(' | ').slice(0, 2000),
      holdAt: o.holdAt ?? new Date(),
    },
  });
}

/** Put a paid order on the "invoice not issued" hold with the reason (visible in lists, the overview and the order page). */
async function holdInvoicePending(orderId: string, reason: string): Promise<void> {
  try {
    await writeHold(orderId, 'INVOICE_PENDING', reason.slice(0, 900));
  } catch {
    /* best effort: the caller reports the reason and alerts the admins */
  }
}

export type InvoiceVatDecision =
  /** Staff confirmed the charged VAT is right: issue it as charged under `treatment`. */
  | { kind: 'AS_CHARGED'; treatment: VatTreatmentCode; note: string; actorEmail: string }
  /** Staff applied the VAT rules (the order's totals were corrected first). */
  | { kind: 'RULES'; note: string; actorEmail: string };

/**
 * Issue the tax invoice for a paid (or approved-on-terms) order — idempotent.
 * Refuses — with the reason, and the order put on hold — when the VAT charged
 * does not match the rules (INVOICE_VAT_MISMATCH_POLICY) or legal details are
 * missing (INVOICE_REQUIRED_FIELDS_POLICY). The payment box comes from the
 * payments ledger: "paid in full on <value date>" only when the recorded
 * payments cover the total. `replaceCredited` issues the corrected invoice
 * for an order whose invoice a credit note credited in full.
 */
export async function issueInvoice(
  orderId: string,
  opts: { actorId?: string | null; vatDecision?: InvoiceVatDecision; replaceCredited?: { reason: string } } = {},
): Promise<IssueResult> {
  await ensureSettingsLoaded();
  let orderNumber = '';
  try {
    await ensureLegacyDocuments(orderId);
    const existing = await orderInvoice(prisma, orderId);
    let replaces: FiscalDocument | null = null;
    if (existing) {
      const credited = await creditedOnInvoice(prisma, existing.id);
      if (!opts.replaceCredited) return { ok: true, document: existing, created: false, warnings: [] };
      if (credited < existing.totalCents) {
        return { ok: false, code: 'ERROR', message: `Invoice ${existing.number} is not credited in full — issue the credit note first, then the corrected invoice.` };
      }
      replaces = existing;
    } else if (opts.replaceCredited) {
      return { ok: false, code: 'NO_INVOICE', message: 'This order has no invoice to correct.' };
    }
    const order = await loadOrder(prisma, orderId);
    if (!order) return { ok: false, code: 'NOT_FOUND', message: 'Order not found.' };
    orderNumber = order.orderNumber;
    const onTerms = order.financialStatus === 'INVOICED_ON_TERMS' || order.financialStatus === 'CREDIT_APPROVED' || order.financialStatus === 'OVERDUE' || (order.financialStatus === 'PARTIALLY_PAID' && (order.paymentMethodManual ?? '').toUpperCase() === 'INVOICE');
    if (!PAID_STATES.includes(order.status) && !onTerms) {
      return { ok: false, code: 'NOT_PAID', message: `Order ${order.orderNumber} is not paid yet — the invoice is issued once the payment is verified.` };
    }

    const [taxSettings, countries, ctx] = await Promise.all([loadTaxSettings(), loadCountryFacts(), docContext()]);
    const vat = await resolveOrderVat(order, { settings: taxSettings, countries });
    const warnings: string[] = [];
    const decided = opts.vatDecision;
    if ((vat.status === 'MISMATCH' || vat.status === 'UNDETERMINED') && !decided) {
      const policy = settingEnum<'BLOCK' | 'ISSUE_AS_CHARGED'>('INVOICE_VAT_MISMATCH_POLICY');
      if (policy === 'BLOCK') {
        const note = `VAT review needed before invoicing: ${vat.message}`.slice(0, 1000);
        await writeHold(order.id, 'VAT_REVIEW', note);
        return { ok: false, code: 'VAT_REVIEW', message: note };
      }
      warnings.push(`Issued as charged although: ${vat.message}`);
    }

    const tolerance = settingInt('UNDERPAYMENT_TOLERANCE_CENTS', 0);
    const pay = paymentFacts(order, tolerance);
    const termDays = netDaysOf(order.paymentTerms) ?? settingInt('CREDIT_DEFAULT_TERM_DAYS', 30);
    const now0 = new Date();
    const dueDateFor = (from: Date) => new Date(from.getTime() + termDays * 86_400_000);
    // Paid in full (ledger) → PAID; money received but short (e.g. the VAT
    // correction raised the total) → PARTLY_PAID with the rest due; nothing
    // received (approved on terms) → DUE.
    const payKind: 'PAID' | 'PARTLY_PAID' | 'DUE' = pay.inFull ? 'PAID' : pay.paidCents > 0 ? 'PARTLY_PAID' : 'DUE';
    const dates = supplyDatesFor(order, now0, payKind === 'DUE' ? null : pay.paidAt);
    let vatPlan = planVat(order, vat, 'INVOICE', ctx);
    if (decided?.kind === 'AS_CHARGED') {
      vatPlan = { ...vatPlan, treatment: decided.treatment, legalText: legalTextFor(decided.treatment, taxSettings.legalTexts), pendingNote: null, reasons: [...vatPlan.reasons, `Staff decision by ${decided.actorEmail}: issue as charged (${decided.treatment}) — ${decided.note}`] };
    } else if (decided?.kind === 'RULES') {
      vatPlan = { ...vatPlan, reasons: [...vatPlan.reasons, `Staff decision by ${decided.actorEmail}: VAT rules applied — ${decided.note}`] };
    }

    // Margin scheme: the VAT owed on the margin is never printed, but it is recorded with the
    // invoice (audit trail) for the VAT return — and a unit without a purchase cost is flagged.
    if (vatPlan.treatment === 'MARGIN_SCHEME') {
      let marginVat = 0;
      const noCost: string[] = [];
      for (const it of order.items) {
        if (it.product?.vatScheme !== 'MARGIN') continue;
        if (it.product.purchaseCostCents == null) { noCost.push(it.titleSnapshot); continue; }
        marginVat += vatInMargin(it.priceCentsSnapshot * it.quantity - it.product.purchaseCostCents * it.quantity, taxSettings.standardRateBp);
      }
      vatPlan = { ...vatPlan, reasons: [...vatPlan.reasons, `Margin VAT owed (internal, not on the invoice): ${fmtDocMoney(marginVat, order.currency)} at ${taxSettings.standardRateBp / 100}% of the margin.`] };
      if (noCost.length) warnings.push(`Margin scheme without a purchase cost (margin VAT unknown): ${noCost.join(', ')}`);
    }

    // Legal details check on a draft snapshot (number filled in later).
    const draft = buildSnapshot({
      kind: 'INVOICE', number: 'DRAFT', version: 1, issueDate: now0, supplyDate: dates.supplyDate, dueDate: null,
      order, vat: vatPlan, payment: null, refs: [], notes: [], terms: [], original: null, ctx,
    });
    const billRaw = order.billingAddress && typeof order.billingAddress === 'object' ? order.billingAddress : order.shippingAddress;
    const missing = missingInvoiceDetails(draft, !!settingString('COMPANY_LEGAL_NAME'), addressGaps(billRaw));
    if (missing.length) {
      if (settingEnum('INVOICE_REQUIRED_FIELDS_POLICY') === 'BLOCK') {
        const note = `Invoice not issued — missing: ${missing.join(', ')}.`;
        await holdInvoicePending(order.id, note);
        return { ok: false, code: 'MISSING_DETAILS', message: note, missing };
      }
      warnings.push(`Issued with missing details: ${missing.join(', ')}`);
    }

    const proforma = await prisma.fiscalDocument.findFirst({ where: { orderId: order.id, kind: 'PROFORMA' }, orderBy: { createdAt: 'desc' }, select: { number: true } });
    const L = ctx.labels;
    const sr = order.sourcingRequest;
    const document = await prisma.$transaction(async (tx) => {
      await lockOrder(tx, order.id);
      const again = await orderInvoice(tx, order.id);
      if (again && (!replaces || again.id !== replaces.id)) return { doc: again, created: false };
      const { alloc, issueDate } = await allocateWithIssueDate(tx, 'INVOICE', loadNumberingSettings());
      const dueDate = payKind === 'PAID' ? null : dueDateFor(issueDate);
      const supply = supplyDatesFor(order, issueDate, payKind === 'DUE' ? null : pay.paidAt);
      const payment: DocPaymentBox = payKind === 'PAID'
        ? { kind: 'PAID', paidAt: pay.paidAt ? pay.paidAt.toISOString() : null, method: paymentMethodLabel(order), amountCents: pay.paidCents }
        : payKind === 'PARTLY_PAID'
          ? { kind: 'PARTLY_PAID', paidCents: pay.paidCents, paidAt: pay.paidAt ? pay.paidAt.toISOString() : null, openCents: order.totalCents - pay.paidCents, dueDate: dueDate ? dueDate.toISOString() : null, reference: alloc.number }
          : { kind: 'DUE', dueDate: dueDate ? dueDate.toISOString() : null, reference: alloc.number, amountCents: order.totalCents };
      const snapshot = buildSnapshot({
        kind: 'INVOICE', number: alloc.number, version: 1, issueDate, supplyDate: supply.supplyDate, dueDate,
        order, vat: vatPlan, payment,
        refs: [
          { label: L.ORDER_NO, value: order.orderNumber },
          ...(proforma?.number ?? order.proformaNumber ? [{ label: L.PROFORMA_REF, value: (proforma?.number ?? order.proformaNumber) as string }] : []),
          ...(sr ? [{ label: L.QUOTE_REF, value: QUOTE_REF(sr.id) }] : []),
          ...(replaces ? [{ label: L.REPLACES, value: replaces.number }] : []),
          ...commercialRefs(order, ctx),
        ],
        // The accepted offer's note (terms agreed with the buyer) is part of the deal: on the invoice too.
        notes: [...(sr?.quotedNote?.trim() ? [sr.quotedNote.trim()] : []), ...(opts.replaceCredited ? [opts.replaceCredited.reason] : [])],
        terms: textLines('INVOICE_TERMS_TEXT'), original: null, warnings, ctx,
        advancePaymentDate: supply.advancePaymentDate,
      });
      const doc = await insertDoc(tx, {
        kind: 'INVOICE', number: alloc.number, series: 'INVOICE', fiscalYear: alloc.fiscalYear, seq: alloc.seq,
        orderId: order.id, sourcingRequestId: order.sourcingRequestId, issueDate, supplyDate: snapshot.supplyDate ? new Date(snapshot.supplyDate) : null,
        originalDocumentId: replaces?.id ?? null,
        dueDate, currency: order.currency, vatTreatment: vatPlan.treatment, issuedById: opts.actorId ?? null, snapshot,
      } as Omit<Prisma.FiscalDocumentUncheckedCreateInput, 'snapshot'> & { snapshot: DocumentSnapshot });
      // The decision the invoice relied on, recorded on the order (legacy-priced / staff-decided orders).
      const recordVat = !order.vatTreatment || order.vatTreatment === 'LEGACY_UNSPECIFIED' || !!decided;
      const openHolds = order.openHolds.filter((h) => h !== 'VAT_REVIEW' && h !== 'INVOICE_PENDING');
      const nextHold = primaryHold(openHolds);
      const noteParts = (order.holdNote ?? '').split(' | ').filter((p) => p && !p.startsWith('VAT_REVIEW:') && !p.startsWith('INVOICE_PENDING:') && !p.startsWith('VAT review needed') && !p.startsWith('Invoice not issued'));
      await tx.order.update({
        where: { id: order.id },
        data: {
          supplyDate: snapshot.supplyDate ? new Date(snapshot.supplyDate) : order.supplyDate,
          openHolds,
          holdReason: order.holdReason === 'VAT_REVIEW' || order.holdReason === 'INVOICE_PENDING' ? nextHold : order.holdReason,
          holdNote: noteParts.length ? noteParts.join(' | ') : null,
          ...(nextHold || (order.holdReason && order.holdReason !== 'VAT_REVIEW' && order.holdReason !== 'INVOICE_PENDING') ? {} : { holdAt: null }),
          ...(recordVat && (vatPlan.mode === 'ENGINE' || decided)
            ? {
                vatTreatment: vatPlan.treatment,
                vatRateBp: decided?.kind === 'AS_CHARGED' ? vatPlan.rows.find((r) => r.rateBp != null)?.rateBp ?? 0 : vat.decision.rateBp,
                vatDecidedAt: issueDate,
                vatNote: vatPlan.reasons.join(' ').slice(0, 1000),
                buyerVatId: vat.vatId?.vatId ?? order.buyerVatId,
                viesCheck: vat.vatId ? (JSON.parse(JSON.stringify(vat.vatId)) as Prisma.InputJsonValue) : undefined,
              }
            : {}),
        },
      });
      return { doc, created: true };
    });
    return { ok: true, document: document.doc, created: document.created, warnings };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && /orderId/.test(JSON.stringify(e.meta?.target ?? ''))) {
      const doc = await orderInvoice(prisma, orderId);
      if (doc) return { ok: true, document: doc, created: false, warnings: [] };
    }
    // Technical failure: a readable reason, the order really on hold, the details logged.
    const message = readableIssueError(e, 'invoice');
    if (!(e instanceof IssueError)) {
      await import('@/lib/observability').then((m) => m.logError('documents.issueInvoice', e)).catch(() => {});
    }
    await holdInvoicePending(orderId, `Invoice not issued — ${message}`);
    return { ok: false, code: 'ERROR', message: orderNumber ? `Invoice for order ${orderNumber} not issued: ${message}` : message };
  }
}

function legalTextFor(t: VatTreatmentCode, texts: Record<'ICS' | 'EXPORT' | 'MARGIN' | 'OSS', string>): string | null {
  const key = t === 'EU_ICS_ZERO' ? 'ICS' : t === 'EXPORT_ZERO' ? 'EXPORT' : t === 'MARGIN_SCHEME' ? 'MARGIN' : t === 'EU_B2C_OSS' ? 'OSS' : null;
  return key ? texts[key] || null : null;
}

// ── credit notes ─────────────────────────────────────────────────────────────

/**
 * The invoice's VAT rows still open for credit: the original rows minus what
 * earlier credit notes credited at the same rate. Crediting exactly the rest
 * of an invoice uses these rows, so the last credit note closes the invoice to
 * the cent (no rounding left over after part credits).
 */
async function remainingCreditRows(db: Tx | typeof prisma, original: Pick<FiscalDocument, 'id' | 'snapshot'>): Promise<DocVatRowSnapshot[]> {
  const rows = (original.snapshot as unknown as DocumentSnapshot).vat.rows.map((r) => ({ ...r }));
  const prior = await db.fiscalDocument.findMany({ where: { originalDocumentId: original.id, kind: 'CREDIT_NOTE' }, select: { snapshot: true } });
  for (const p of prior) {
    for (const pr of (p.snapshot as unknown as DocumentSnapshot).vat.rows) {
      const t = rows.find((r) => r.rateBp === pr.rateBp);
      if (t) {
        t.baseCents += pr.baseCents;
        t.taxCents += pr.taxCents;
      }
    }
  }
  return rows.filter((r) => r.baseCents + r.taxCents !== 0);
}

/**
 * The gross amount a credit of `askedCents` really comes to on this invoice:
 * the whole invoice / the exact rest, or a part split over the VAT rows with
 * exact VAT per rate (may differ by a cent from the request).
 */
export async function creditGrossOf(db: Tx | typeof prisma, original: Pick<FiscalDocument, 'id' | 'snapshot' | 'totalCents'>, askedCents: number): Promise<{ grossCents: number; netCents: number; taxCents: number; remainingCents: number; rows: DocVatRowSnapshot[]; full: boolean; rest: boolean }> {
  const credited = await creditedOnInvoice(db, original.id);
  const remaining = original.totalCents - credited;
  const orig = original.snapshot as unknown as DocumentSnapshot;
  const full = askedCents === original.totalCents && credited === 0;
  let rows: DocVatRowSnapshot[];
  let rest = false;
  if (full) rows = orig.vat.rows;
  else {
    const restRows = askedCents === remaining && credited > 0 ? await remainingCreditRows(db, original) : null;
    rest = !!restRows && restRows.reduce((s, r) => s + r.baseCents + r.taxCents, 0) === remaining;
    rows = rest && restRows ? restRows : splitGrossOverRows(askedCents, orig.vat.rows);
  }
  const net = rows.reduce((s, r) => s + r.baseCents, 0);
  const tax = rows.reduce((s, r) => s + r.taxCents, 0);
  return { grossCents: net + tax, netCents: net, taxCents: tax, remainingCents: remaining, rows, full, rest };
}

/** How the money side of a credit is settled — decides the sentence the credit note prints. */
export interface CreditMoney {
  /** Money given back with this credit (cents, ≥ 0). 0 = nothing was paid: the amount is no longer due. */
  refundCents: number;
  /** BANK_TRANSFER (approved, sent later) or STRIPE (refunded to the card now). */
  method: 'BANK_TRANSFER' | 'STRIPE' | 'OTHER' | null;
  /** The money already went back before this credit note (an older refund that never got one). */
  alreadyRefunded?: boolean;
}

function settlementFor(creditGross: number, money: CreditMoney | undefined, replacement = false): CreditSettlement | undefined {
  if (replacement) return { kind: 'REPLACED', refundCents: 0, cancelledCents: 0 };
  if (!money) return undefined;
  const refund = Math.min(Math.max(0, money.refundCents), creditGross);
  if (money.alreadyRefunded) return { kind: 'REFUNDED', refundCents: refund, cancelledCents: creditGross - refund };
  if (refund === 0) return { kind: 'NOT_PAID', refundCents: 0, cancelledCents: creditGross };
  if (refund < creditGross) return { kind: 'PART_REFUND', refundCents: refund, cancelledCents: creditGross - refund };
  return { kind: money.method === 'STRIPE' ? 'REFUND_CARD' : 'REFUND', refundCents: refund, cancelledCents: 0 };
}

/**
 * Credit note for (part of) an order's invoice. `amountCents` = gross amount
 * to credit (default: everything not credited yet); a partial credit is split
 * over the invoice's VAT rows with exact VAT per row, so the credit note's
 * total may differ by a cent from the request — callers use the DOCUMENT's
 * total (it is what the buyer gets back / no longer owes). `money` says what
 * happens to the money (refund by transfer, card refund, or — nothing paid —
 * the amount is simply no longer due); the credit note prints exactly that.
 * Runs in `opts.tx` when given (refund transaction) — the content comes from
 * the ORIGINAL invoice snapshot, so no external call is made there.
 */
export async function issueCreditNote(args: {
  orderId: string;
  amountCents?: number | null;
  reason: string;
  refundMethod?: string | null;
  money?: CreditMoney;
  actorId?: string | null;
  tx?: Tx;
  /** Pre-loaded document context (texts, country table) — required when `tx` is given to avoid reads inside it. */
  ctx?: DocContext;
  /** The invoice is being corrected: a corrected invoice replaces it (no money moves). */
  replacement?: boolean;
}): Promise<IssueResult> {
  await ensureSettingsLoaded();
  const ctx = args.ctx ?? (await docContext());
  const run = async (tx: Tx) => {
    await lockOrder(tx, args.orderId);
    const original = await orderInvoice(tx, args.orderId);
    if (!original) throw new IssueError('NO_INVOICE', 'This order has no invoice, so there is nothing to credit (no credit note issued).');
    const credited = await creditedOnInvoice(tx, original.id);
    const remaining = original.totalCents - credited;
    const asked = args.amountCents ?? remaining;
    if (asked <= 0 || remaining <= 0) throw new IssueError('NOTHING_TO_CREDIT', `Invoice ${original.number} is already fully credited.`);
    if (asked > remaining) throw new IssueError('NOTHING_TO_CREDIT', `Only ${(remaining / 100).toFixed(2)} ${original.currency} of invoice ${original.number} is left to credit.`);

    const order = await loadOrder(tx, args.orderId);
    if (!order) throw new IssueError('NOT_FOUND', 'Order not found.');
    const orig = original.snapshot as unknown as DocumentSnapshot;
    const plan = await creditGrossOf(tx, original, asked);
    const full = plan.full;
    const rows = negateRows(plan.rows);
    const L = ctx.labels;
    const lines: DocLineSnapshot[] = full
      ? negateLines(orig.lines)
      : rows.map((r) => ({
          description: `${fillLabel(L.CREDIT_LINE_DESC, { NUMBER: original.number })}${args.reason ? ` — ${args.reason}` : ''}`,
          detail: null,
          qty: 1,
          unitCents: r.baseCents,
          netCents: r.baseCents,
          vatRateBp: r.rateBp,
          taxCents: r.taxCents,
          lineType: 'GOODS' as const,
        }));
    const creditGross = -rows.reduce((s, r) => s + r.baseCents + r.taxCents, 0);
    if (creditGross <= 0 || creditGross > remaining) throw new IssueError('NOTHING_TO_CREDIT', `Only ${(remaining / 100).toFixed(2)} ${original.currency} of invoice ${original.number} is left to credit.`);
    const { alloc, issueDate } = await allocateWithIssueDate(tx, 'CREDIT_NOTE', loadNumberingSettings());
    const vatPlan: VatPlan = {
      mode: 'ENGINE',
      treatment: original.vatTreatment as VatTreatmentCode,
      lines,
      rows,
      legalText: orig.vat.legalText,
      buyerVatId: orig.vat.buyerVatId,
      viesConsultation: orig.vat.viesConsultation,
      pendingNote: null,
      reasons: [`Credits invoice ${original.number}: ${args.reason}`],
    };
    const settlement = settlementFor(creditGross, args.money, args.replacement);
    const money = (c: number) => fmtDocMoney(c, original.currency, ctx.locale.moneyLocale);
    const origDate = new Date(original.issueDate).toLocaleDateString(ctx.locale.dateLocale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: ctx.locale.timeZone });
    const methodText = args.money?.method === 'STRIPE' ? 'card refund' : args.money?.method === 'OTHER' ? 'another method agreed with you' : 'bank transfer';
    const settlementLine = !settlement
      ? null
      : settlement.kind === 'REPLACED'
        ? settingString('CREDIT_NOTE_TEXT_REPLACED')
        : settlement.kind === 'REFUNDED'
        ? settingString('CREDIT_NOTE_TEXT_REFUNDED')
        : settlement.kind === 'NOT_PAID'
        ? settingString('CREDIT_NOTE_TEXT_NOT_PAID')
        : settlement.kind === 'PART_REFUND'
          ? settingString('CREDIT_NOTE_TEXT_PART_REFUND')
          : settlement.kind === 'REFUND_CARD'
            ? settingString('CREDIT_NOTE_TEXT_REFUND_CARD')
            : settingString('CREDIT_NOTE_TEXT_REFUND');
    const vars: Record<string, string> = {
      ORIGINAL_NUMBER: original.number,
      ORIGINAL_DATE: origDate,
      AMOUNT: money(settlement?.kind === 'NOT_PAID' ? creditGross : settlement?.refundCents ?? creditGross),
      REFUND: money(settlement?.refundCents ?? 0),
      CANCELLED: money(settlement?.cancelledCents ?? 0),
      METHOD: methodText,
    };
    const fill = (t: string) => t.replace(/\{([A-Z_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
    const terms = [...textLines('CREDIT_NOTE_TEXT').map(fill), ...(settlementLine ? [fill(settlementLine.trim())] : [])].filter(Boolean);
    const snapshot = buildSnapshot({
      kind: 'CREDIT_NOTE', number: alloc.number, version: 1, issueDate, supplyDate: null, dueDate: null,
      order, vat: vatPlan,
      payment: { kind: 'CREDIT', originalNumber: original.number, refundMethod: args.refundMethod ?? null, ...(settlement ? { settlement } : {}) },
      refs: [{ label: L.ORDER_NO, value: order.orderNumber }],
      notes: args.reason ? [args.reason] : [],
      terms,
      original: { number: original.number, issueDate: original.issueDate.toISOString() },
      ctx,
    });
    // Same buyer / seller identity as the invoice being corrected.
    snapshot.buyer = orig.buyer;
    snapshot.shipTo = orig.shipTo;
    snapshot.seller = orig.seller;
    snapshot.clauses = [];
    const doc = await insertDoc(tx, {
      kind: 'CREDIT_NOTE', number: alloc.number, series: 'CREDIT_NOTE', fiscalYear: alloc.fiscalYear, seq: alloc.seq,
      orderId: order.id, sourcingRequestId: order.sourcingRequestId, originalDocumentId: original.id, issueDate,
      currency: original.currency, vatTreatment: original.vatTreatment, issuedById: args.actorId ?? null, snapshot,
    } as Omit<Prisma.FiscalDocumentUncheckedCreateInput, 'snapshot'> & { snapshot: DocumentSnapshot });
    return doc;
  };
  try {
    const doc = args.tx ? await run(args.tx) : await prisma.$transaction(run);
    return { ok: true, document: doc, created: true, warnings: [] };
  } catch (e) {
    if (args.tx && !(e instanceof IssueError)) throw e; // let the caller's transaction roll back
    return fail(e);
  }
}

/**
 * The amounts a credit of `askedCents` really comes to on this order's invoice
 * (exact VAT per row) — shown before the credit is confirmed.
 */
export async function previewCredit(orderId: string, askedCents: number): Promise<{ ok: true; grossCents: number; netCents: number; taxCents: number; remainingCents: number; invoiceNumber: string } | { ok: false; message: string }> {
  const original = await orderInvoice(prisma, orderId);
  if (!original) return { ok: false, message: 'This order has no invoice.' };
  const plan = await creditGrossOf(prisma, original, askedCents);
  return { ok: true, grossCents: plan.grossCents, netCents: plan.netCents, taxCents: plan.taxCents, remainingCents: plan.remainingCents, invoiceNumber: original.number };
}

// ── legacy (pre-4_business_core) documents ───────────────────────────────────

let cutoverCache: Date | null | undefined;
/** When 4_business_core was applied: documents issued before it are LEGACY. */
export async function documentsCutover(): Promise<Date | null> {
  if (cutoverCache !== undefined) return cutoverCache;
  try {
    const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" = '4_business_core' AND "rolled_back_at" IS NULL LIMIT 1`;
    cutoverCache = rows[0]?.finished_at ?? null;
  } catch {
    cutoverCache = null;
  }
  return cutoverCache;
}

function parseBankSnapshot(snapshot: string | null | undefined): Partial<NonNullable<DocumentSnapshot['bank']>> {
  const out: Partial<NonNullable<DocumentSnapshot['bank']>> = {};
  for (const line of (snapshot ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z/ ]+):\s*(.+)$/.exec(line);
    if (!m) continue;
    const k = m[1].trim().toLowerCase();
    const v = m[2].trim();
    if (k === 'beneficiary') out.beneficiary = v;
    else if (k === 'bank') out.bankName = v;
    else if (k === 'iban') out.iban = v;
    else if (k === 'swift/bic' || k === 'bic' || k === 'swift') out.bic = v;
  }
  return out;
}

/**
 * Freeze the documents an order already had BEFORE 4_business_core, exactly
 * as the old renderer produced them (old numbers, series LEGACY), so they stop
 * changing. Idempotent. Used by prisma/backfill-legacy-documents.ts and lazily
 * by the download route.
 */
export async function freezeLegacyDocuments(orderId: string): Promise<{ proforma: FiscalDocument | null; invoice: FiscalDocument | null }> {
  await ensureSettingsLoaded();
  const cutover = await documentsCutover();
  const out = { proforma: null as FiscalDocument | null, invoice: null as FiscalDocument | null };
  if (!cutover) return out;
  const order = await loadOrder(prisma, orderId);
  if (!order) return out;
  const sr = order.sourcingRequest;
  // Legacy documents keep the English texts they were printed with.
  const ctx = docContextFrom(await loadDocFacts());
  ctx.labels = Object.fromEntries(DOC_LABEL_KEYS.map((k) => [k, defaultDocLabel(k, 'en')])) as Record<DocLabelKey, string>;

  // Proforma: quote proformas issued before the cutover, and unpaid checkout orders (number = order no.).
  const pfNumber = sr?.proformaNumber && (sr.proformaIssuedAt ?? order.createdAt) < cutover
    ? sr.proformaNumber
    : !sr && order.createdAt < cutover && order.status === 'PENDING_PAYMENT'
      ? order.orderNumber
      : null;
  if (pfNumber) {
    const have = await prisma.fiscalDocument.findUnique({ where: { number: pfNumber } });
    if (have) out.proforma = have;
    else {
      const issueDate = sr?.proformaIssuedAt ?? order.createdAt;
      const dueDate = sr?.validUntilAt ?? null;
      const snapBank = parseBankSnapshot(sr?.paymentInstructionsSnapshot);
      const snapshot = buildSnapshot({
        kind: 'PROFORMA', number: pfNumber, version: 1, issueDate, supplyDate: null, dueDate, order,
        vat: planVat(order, null, 'PROFORMA', ctx),
        payment: { kind: 'INSTRUCTIONS', reference: pfNumber, amountCents: order.totalCents, dueDate: dueDate ? dueDate.toISOString() : null, bankAvailable: !!snapBank.iban },
        refs: [{ label: 'Order no.', value: order.orderNumber }, ...(sr ? [{ label: 'Quote ref.', value: QUOTE_REF(sr.id) }] : [])],
        notes: sr?.quotedNote?.trim() ? [sr.quotedNote.trim()] : [],
        terms: textLines('PROFORMA_TERMS_TEXT'),
        original: null,
        legacy: true,
        warnings: ['Frozen from the pre-4_business_core renderer (legacy number).'],
        ctx,
      });
      if (snapBank.iban) snapshot.bank = { beneficiary: snapBank.beneficiary ?? snapshot.seller.name, bankName: snapBank.bankName ?? '', iban: snapBank.iban, bic: snapBank.bic ?? '' };
      snapshot.vat.pendingNote = null;
      const voided = order.status === 'CANCELED' || order.status === 'REFUNDED';
      try {
        out.proforma = await prisma.$transaction(async (tx) => {
          const hasCurrent = await currentProforma(tx, order.id);
          return insertDoc(tx, {
            kind: 'PROFORMA', number: pfNumber, series: 'LEGACY', fiscalYear: fiscalYearOf(issueDate), seq: null,
            orderId: order.id, sourcingRequestId: sr?.id ?? null, issueDate, dueDate, currency: order.currency,
            vatTreatment: 'LEGACY_UNSPECIFIED', legacy: true, snapshot,
            ...(voided || hasCurrent ? { voidedAt: new Date(), voidReason: voided ? `Order ${order.status.toLowerCase()} before the documents cutover.` : 'Superseded by a newer proforma.' } : {}),
          } as Omit<Prisma.FiscalDocumentUncheckedCreateInput, 'snapshot'> & { snapshot: DocumentSnapshot });
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        out.proforma = await prisma.fiscalDocument.findUnique({ where: { number: pfNumber } });
      }
    }
  }

  // Invoice: paid before the cutover → the old INV-<order tail> number, as it rendered then.
  const paidAt = order.paidAt ?? order.paymentVerifiedAt;
  if (PAID_STATES.includes(order.status) && paidAt && paidAt < cutover) {
    const have = await orderInvoice(prisma, order.id);
    if (have) out.invoice = have;
    else {
      const number = `INV-${order.orderNumber.replace(/^L2D-/i, '')}`;
      const onTerms = order.financialStatus === 'INVOICED_ON_TERMS';
      const snapshot = buildSnapshot({
        kind: 'INVOICE', number, version: 1, issueDate: paidAt, supplyDate: null, dueDate: null, order,
        vat: planVat(order, null, 'INVOICE', ctx),
        payment: onTerms
          ? { kind: 'DUE', dueDate: null, reference: number, amountCents: order.totalCents }
          : { kind: 'PAID', paidAt: paidAt.toISOString(), method: paymentMethodLabel(order) },
        refs: [{ label: 'Order no.', value: order.orderNumber }, ...(sr?.proformaNumber ? [{ label: 'Proforma no.', value: sr.proformaNumber }] : [])],
        notes: [], terms: [], original: null, legacy: true,
        warnings: ['Frozen from the pre-4_business_core renderer (legacy number, VAT as charged).'],
        ctx,
      });
      try {
        out.invoice = await insertDoc(prisma, {
          kind: 'INVOICE', number, series: 'LEGACY', fiscalYear: fiscalYearOf(paidAt), seq: null,
          orderId: order.id, sourcingRequestId: sr?.id ?? null, issueDate: paidAt, currency: order.currency,
          vatTreatment: 'LEGACY_UNSPECIFIED', legacy: true, snapshot,
        } as Omit<Prisma.FiscalDocumentUncheckedCreateInput, 'snapshot'> & { snapshot: DocumentSnapshot });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        out.invoice = await orderInvoice(prisma, order.id);
      }
    }
  }
  return out;
}

// ── stored PDFs ──────────────────────────────────────────────────────────────

export function documentFooterText(snap: DocumentSnapshot): string {
  return `${snap.title} ${snap.number} · ${snap.seller.name}`;
}

export function documentFilename(doc: Pick<FiscalDocument, 'number'>): string {
  return `${doc.number.replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`;
}

export function snapshotOf(doc: Pick<FiscalDocument, 'snapshot'>): DocumentSnapshot {
  return doc.snapshot as unknown as DocumentSnapshot;
}

/** HTML of an issued document (preview) — from its snapshot only. */
export async function documentHtml(doc: Pick<FiscalDocument, 'snapshot'>, opts: { compact?: boolean } = {}): Promise<string> {
  const snap = snapshotOf(doc);
  return renderDocumentHtml(snap, { logoDataUri: await companyLogoDataUri(snap.seller.logoPath), compact: opts.compact });
}

export type PdfResult =
  | { ok: true; bytes: Buffer; sha256: string; key: string; rendered: boolean }
  /** INTEGRITY: stored bytes do not match their sha256 (tampered) · MISSING: stored object unreadable · RENDER: could not be generated. */
  | { ok: false; error: string; reason: 'INTEGRITY' | 'MISSING' | 'RENDER' | 'NOT_FOUND' };

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * The stored PDF of a document; renders + stores it first if it was never
 * rendered (e.g. Chromium was down at issue time). A stored PDF whose bytes no
 * longer match their sha256 is refused (never served silently).
 */
export async function ensureDocumentPdf(docId: string): Promise<PdfResult> {
  const doc = await prisma.fiscalDocument.findUnique({ where: { id: docId } });
  if (!doc) return { ok: false, error: 'Document not found.', reason: 'NOT_FOUND' };
  if (doc.pdfKey && doc.sha256) {
    try {
      const { bytes } = await getObjectBytes(doc.pdfKey);
      const sum = sha256(bytes);
      if (sum !== doc.sha256) {
        await alertDocumentIntegrity(doc.number, 'INTEGRITY', `the stored PDF (${doc.pdfKey}) does not match its sha256 — it was changed after it was issued`);
        return { ok: false, error: `Integrity check failed for ${doc.number}: stored PDF does not match its sha256.`, reason: 'INTEGRITY' };
      }
      return { ok: true, bytes, sha256: sum, key: doc.pdfKey, rendered: false };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await alertDocumentIntegrity(doc.number, 'MISSING', `the stored PDF (${doc.pdfKey}) could not be read: ${why.slice(0, 160)}`);
      return { ok: false, error: `Stored PDF of ${doc.number} could not be read: ${why}`, reason: 'MISSING' };
    }
  }
  try {
    const snap = snapshotOf(doc);
    const pageLabel = (snap.labels?.PAGE_OF ?? 'Page {PAGE} of {PAGES}').trim();
    let pdf = await htmlToPdf(await documentHtml(doc), { footerText: documentFooterText(snap), pageLabel });
    // A few lines over one page (e.g. only the footer on page 2): try the
    // compact layout and keep it when it saves a page. Rendered once, stored.
    const pages = pdfPageCount(pdf);
    if (pages > 1) {
      const compact = await htmlToPdf(await documentHtml(doc, { compact: true }), { footerText: documentFooterText(snap), pageLabel }).catch(() => null);
      if (compact && pdfPageCount(compact) > 0 && pdfPageCount(compact) < pages) pdf = compact;
    }
    const sum = sha256(pdf);
    const key = `documents/${doc.kind.toLowerCase()}/${doc.fiscalYear}/${documentFilename(doc).replace(/\.pdf$/, '')}-${sum.slice(0, 12)}.pdf`;
    await uploadObject(key, pdf, 'application/pdf');
    const claim = await prisma.fiscalDocument.updateMany({ where: { id: doc.id, pdfKey: null }, data: { pdfKey: key, sha256: sum, pdfBytes: pdf.length } });
    if (claim.count === 1) return { ok: true, bytes: pdf, sha256: sum, key, rendered: true };
    // Another request stored its rendering first — serve THAT one (the record).
    const again = await prisma.fiscalDocument.findUnique({ where: { id: doc.id }, select: { pdfKey: true, sha256: true } });
    if (again?.pdfKey) {
      const { bytes } = await getObjectBytes(again.pdfKey);
      return { ok: true, bytes, sha256: sha256(bytes), key: again.pdfKey, rendered: false };
    }
    return { ok: true, bytes: pdf, sha256: sum, key, rendered: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), reason: 'RENDER' };
  }
}

/**
 * A fiscal document whose stored copy is gone or was changed: every admin is
 * alerted (at most once an hour per document) and it is logged — it is never
 * re-rendered or served.
 */
async function alertDocumentIntegrity(number: string, kind: 'INTEGRITY' | 'MISSING', detail: string): Promise<void> {
  try {
    const title = kind === 'INTEGRITY' ? `Fiscal document ${number} failed its integrity check` : `Fiscal document ${number}: stored PDF missing`;
    const { logError, notifyAdmins } = await import('@/lib/observability');
    await logError('documents.integrity', new Error(`${number}: ${detail}`));
    const recent = await prisma.notification.findFirst({ where: { title, createdAt: { gte: new Date(Date.now() - 3_600_000) } }, select: { id: true } });
    if (recent) return;
    await notifyAdmins(
      title,
      `${detail}. It is not served to anyone (buyers see “document unavailable — our team has been alerted”). Restore the original object from the backup / bucket version history; never re-issue or replace it.`,
      `/admin/orders?q=${encodeURIComponent(number)}`,
      'SYSTEM',
    );
  } catch {
    /* alerting must never break the request */
  }
}

/** Email attachment of an issued document (stored bytes). Never throws. */
export async function documentAttachment(doc: Pick<FiscalDocument, 'id' | 'number'>): Promise<{ attachment: EmailAttachment | null; error: string | null }> {
  const pdf = await ensureDocumentPdf(doc.id);
  if (!pdf.ok) return { attachment: null, error: pdf.error };
  return { attachment: { filename: documentFilename(doc), content: pdf.bytes, contentType: 'application/pdf' }, error: null };
}

export async function markDocumentSent(docId: string): Promise<void> {
  await prisma.fiscalDocument.updateMany({ where: { id: docId, sentAt: null }, data: { sentAt: new Date() } }).catch(() => {});
}

// ── reading ──────────────────────────────────────────────────────────────────

export interface OrderDocuments {
  proforma: FiscalDocument | null;
  proformaHistory: FiscalDocument[];
  invoice: FiscalDocument | null;
  /** Every invoice of the order, oldest first (more than one only after a correction). */
  invoiceHistory: FiscalDocument[];
  creditNotes: FiscalDocument[];
}

/**
 * An order paid (or proforma'd) before the documents cutover already HAS its old document —
 * the buyer may hold a copy. Freeze it before anything looks at "the invoice of this order",
 * so a page view, a refund (credit note) or "issue invoice" never treats it as un-invoiced
 * (which would issue a second invoice, or refund without a credit note).
 */
export async function ensureLegacyDocuments(orderId: string): Promise<void> {
  const cutover = await documentsCutover();
  if (!cutover) return;
  const have = await prisma.fiscalDocument.findMany({ where: { orderId }, select: { kind: true } });
  if (have.some((d) => d.kind === 'INVOICE')) return;
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { createdAt: true, status: true, paidAt: true, paymentVerifiedAt: true } });
  if (!o || o.createdAt >= cutover) return;
  const paidAt = o.paidAt ?? o.paymentVerifiedAt;
  const legacyInvoice = PAID_STATES.includes(o.status) && !!paidAt && paidAt < cutover;
  const legacyProforma = !have.some((d) => d.kind === 'PROFORMA') && o.status === 'PENDING_PAYMENT';
  if (!legacyInvoice && !legacyProforma) return;
  try {
    await freezeLegacyDocuments(orderId);
  } catch (e) {
    const { logError } = await import('@/lib/observability');
    await logError('documents.freezeLegacy', e);
  }
}

export async function getOrderDocuments(orderId: string): Promise<OrderDocuments> {
  await ensureLegacyDocuments(orderId);
  const docs = await prisma.fiscalDocument.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  const proformas = docs.filter((d) => d.kind === 'PROFORMA');
  const invoices = docs.filter((d) => d.kind === 'INVOICE');
  return {
    proforma: proformas.filter((d) => !d.supersededById && !d.voidedAt).at(-1) ?? null,
    proformaHistory: proformas,
    // The current invoice (a corrected invoice replaces one credited in full).
    invoice: invoices.at(-1) ?? null,
    invoiceHistory: invoices,
    creditNotes: docs.filter((d) => d.kind === 'CREDIT_NOTE'),
  };
}

/** Series overview for Admin → Settings → Invoicing (next numbers, gaps). */
export async function numberSeriesOverview(): Promise<Array<{ series: string; fiscalYear: number; nextValue: number; issued: number; gaps: number[] }>> {
  const seqs = await prisma.invoiceSequence.findMany({ orderBy: [{ fiscalYear: 'desc' }, { series: 'asc' }] });
  const out = [];
  for (const s of seqs) {
    const docs = await prisma.fiscalDocument.findMany({
      where: { series: s.series, seq: { not: null }, ...(s.fiscalYear === 0 ? {} : { fiscalYear: s.fiscalYear }) },
      select: { seq: true },
      orderBy: { seq: 'asc' },
    });
    const have = new Set(docs.map((d) => d.seq as number));
    const first = docs[0]?.seq ?? s.nextValue;
    const gaps: number[] = [];
    for (let n = first; n < s.nextValue && gaps.length < 20; n++) if (!have.has(n)) gaps.push(n);
    out.push({ series: s.series, fiscalYear: s.fiscalYear, nextValue: s.nextValue, issued: docs.length, gaps });
  }
  return out;
}

export type { DocSeries };
