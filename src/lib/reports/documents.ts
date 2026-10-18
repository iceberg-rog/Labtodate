import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { vatTreatmentLabel } from '@/lib/tax/determine';
import { inPeriod, localDay, monthOf, periodKeyLabel, prefilterBounds, quarterOf, type Period } from './period';
import { csvMoney, csvRate } from './csv';
import { isTaxedRow, loadMarginVat, type MarginVat } from './margin-vat';

/**
 * The document register for the accountant: every proforma, invoice and
 * credit note as it was issued (amounts, VAT rows, buyer and VAT ID from the
 * frozen snapshot, never from live order data), the VAT summary per period
 * and the ICP listing (intra-Community supplies at 0%, per quarter and
 * buyer VAT ID). Proformas are payment requests, not tax documents: they are
 * listed but never counted in the VAT summary or the ICP.
 *
 * Margin scheme: a margin-scheme invoice prints VAT on the freight only; the
 * goods carry the VAT on the margin inside their price and it is never
 * printed. The register shows those goods on their own line, and the totals
 * and the VAT summary add the margin VAT owed (computed as issueInvoice does,
 * see margin-vat.ts) as a separate line, flagged when a unit has no purchase
 * cost (its margin VAT is unknown and not included).
 */

export type DocKindCode = 'PROFORMA' | 'INVOICE' | 'CREDIT_NOTE';

/** vat: a VAT row as printed · margin-goods: margin-scheme goods (VAT inside the price) · margin-vat: the margin VAT owed, never printed. */
export type VatLine = 'vat' | 'margin-goods' | 'margin-vat';

export interface DocRateRow {
  /** null = the rate could not be determined (legacy document), or margin-scheme goods. */
  rateBp: number | null;
  baseCents: number;
  taxCents: number;
  line: 'vat' | 'margin-goods';
}

export interface DocRow {
  id: string;
  number: string;
  kind: DocKindCode;
  version: number;
  issueDate: Date;
  /** Issue day in the business time zone (YYYY-MM-DD). */
  day: string;
  currency: string;
  treatment: string;
  netCents: number;
  taxCents: number;
  totalCents: number;
  rates: DocRateRow[];
  buyer: { name: string | null; company: string | null; vatId: string | null; country: string | null };
  orderId: string | null;
  orderNumber: string | null;
  /** The invoice a credit note credits. */
  originalNumber: string | null;
  /** issued · voided (proforma canceled) · superseded (proforma replaced by a revision). */
  state: 'issued' | 'voided' | 'superseded';
  sentAt: Date | null;
  legacy: boolean;
  /** Margin-scheme invoice / credit note: the margin VAT it owes (null = not computed, e.g. no order). */
  marginVat: MarginVat | null;
}

const DOC_SELECT = {
  id: true,
  kind: true,
  number: true,
  version: true,
  issueDate: true,
  currency: true,
  vatTreatment: true,
  subtotalCents: true,
  taxCents: true,
  totalCents: true,
  sentAt: true,
  voidedAt: true,
  supersededById: true,
  legacy: true,
  snapshot: true,
  order: { select: { id: true, orderNumber: true } },
  originalDocument: { select: { number: true } },
} satisfies Prisma.FiscalDocumentSelect;

export type DocRecord = Prisma.FiscalDocumentGetPayload<{ select: typeof DOC_SELECT }>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isInt = (v: unknown): v is number => Number.isInteger(v);

/** A VAT ID as the ICP lists it: upper case, no spaces or dots ("nl 8123.45678 b01" → "NL812345678B01"). */
export function normaliseVatId(v: string | null | undefined): string | null {
  const s = (v ?? '').toUpperCase().replace(/[\s.\-]/g, '');
  return s || null;
}

/** The country prefix of a VAT ID (Greece is "EL"); null when it has none. */
export function vatIdCountry(v: string | null | undefined): string | null {
  const m = /^([A-Z]{2})/.exec(normaliseVatId(v) ?? '');
  return m ? m[1] : null;
}

export function docRowOf(d: DocRecord, tz: string, marginVat: MarginVat | null = null): DocRow {
  const snap = (d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : {}) as {
    orderNumber?: unknown;
    buyer?: { name?: unknown; company?: unknown; vatId?: unknown; country?: unknown };
    vat?: { buyerVatId?: unknown; rows?: Array<{ rateBp?: unknown; baseCents?: unknown; taxCents?: unknown }> };
    original?: { number?: unknown };
  };
  const printed: DocRateRow[] = Array.isArray(snap.vat?.rows)
    ? snap.vat.rows
        .filter((r) => isInt(r?.baseCents) && isInt(r?.taxCents))
        .map((r) => ({ rateBp: isInt(r.rateBp) ? r.rateBp : null, baseCents: r.baseCents as number, taxCents: r.taxCents as number, line: 'vat' as const }))
    : [];
  let rates = printed;
  if (d.vatTreatment === 'MARGIN_SCHEME') {
    // The goods have no VAT row (or a 0% one): one line for them, their margin VAT inside the price.
    const taxed = printed.filter(isTaxedRow);
    const goods = d.subtotalCents - taxed.reduce((s, r) => s + r.baseCents, 0);
    const goodsTax = d.taxCents - taxed.reduce((s, r) => s + r.taxCents, 0);
    rates = goods || goodsTax ? [...taxed, { rateBp: null, baseCents: goods, taxCents: goodsTax, line: 'margin-goods' }] : taxed;
  }
  return {
    id: d.id,
    number: d.number,
    kind: d.kind,
    version: d.version,
    issueDate: d.issueDate,
    day: localDay(d.issueDate, tz),
    currency: d.currency,
    treatment: d.vatTreatment,
    netCents: d.subtotalCents,
    taxCents: d.taxCents,
    totalCents: d.totalCents,
    // A legacy document without VAT rows: one row with its own amounts.
    rates: rates.length ? rates : [{ rateBp: null, baseCents: d.subtotalCents, taxCents: d.taxCents, line: 'vat' }],
    buyer: {
      name: str(snap.buyer?.name),
      company: str(snap.buyer?.company),
      vatId: normaliseVatId(str(snap.vat?.buyerVatId) ?? str(snap.buyer?.vatId)),
      country: str(snap.buyer?.country),
    },
    orderId: d.order?.id ?? null,
    orderNumber: d.order?.orderNumber ?? str(snap.orderNumber),
    originalNumber: d.originalDocument?.number ?? str(snap.original?.number),
    state: d.voidedAt ? 'voided' : d.supersededById ? 'superseded' : 'issued',
    sentAt: d.sentAt,
    legacy: d.legacy,
    marginVat: d.kind === 'PROFORMA' ? null : marginVat,
  };
}

/** Every document issued in the period, newest first. */
export async function loadDocRows(period: Period, tz: string): Promise<DocRow[]> {
  const range = prefilterBounds(period);
  const docs = await prisma.fiscalDocument.findMany({
    where: range.gte || range.lt ? { issueDate: range } : {},
    orderBy: [{ issueDate: 'desc' }, { number: 'desc' }],
    select: DOC_SELECT,
  });
  const inside = docs.filter((d) => inPeriod(d.issueDate, period, tz));
  const margin = await loadMarginVat(inside.filter((d) => d.vatTreatment === 'MARGIN_SCHEME' && d.kind !== 'PROFORMA' && d.order).map((d) => d.order!.id));
  return inside.map((d) => docRowOf(d, tz, margin.get(d.id) ?? null));
}

export type DocKindFilter = 'all' | 'fiscal' | DocKindCode;

export function docKindFilter(v: string | null | undefined): DocKindFilter {
  return v === 'fiscal' || v === 'PROFORMA' || v === 'INVOICE' || v === 'CREDIT_NOTE' ? v : 'all';
}

export function filterDocRows(rows: DocRow[], f: { kind?: DocKindFilter; treatment?: string; currency?: string; q?: string }): DocRow[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return rows.filter((r) => {
    if (f.kind === 'fiscal' && r.kind === 'PROFORMA') return false;
    if (f.kind && f.kind !== 'all' && f.kind !== 'fiscal' && r.kind !== f.kind) return false;
    if (f.treatment && r.treatment !== f.treatment) return false;
    if (f.currency && r.currency !== f.currency) return false;
    if (q) {
      const hay = [r.number, r.orderNumber, r.originalNumber, r.buyer.name, r.buyer.company, r.buyer.vatId].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const isFiscal = (r: DocRow) => r.kind === 'INVOICE' || r.kind === 'CREDIT_NOTE';

export interface RateTotal {
  currency: string;
  treatment: string;
  line: VatLine;
  /** margin-vat: the standard rate it is computed at. */
  rateBp: number | null;
  /** margin-vat: the taxable margin excl. VAT. */
  baseCents: number;
  taxCents: number;
  /** margin-vat: documents whose margin VAT is incomplete (a unit without a purchase cost). */
  incompleteDocs: number;
}

const LINE_ORDER: Record<VatLine, number> = { vat: 0, 'margin-goods': 1, 'margin-vat': 2 };

/** A fiscal document's amounts for the totals: its rows as printed, then the margin VAT it owes (never printed). */
function totalLines(r: DocRow): Array<{ line: VatLine; rateBp: number | null; baseCents: number; taxCents: number; incomplete: boolean }> {
  const out = r.rates.map((x) => ({ line: x.line as VatLine, rateBp: x.rateBp, baseCents: x.baseCents, taxCents: x.taxCents, incomplete: false }));
  if (r.treatment === 'MARGIN_SCHEME') {
    const m = r.marginVat;
    out.push({ line: 'margin-vat', rateBp: m?.rateBp ?? null, baseCents: m?.baseCents ?? 0, taxCents: m?.vatCents ?? 0, incomplete: !m || m.unitsWithoutCost > 0 });
  }
  return out;
}

const byLine = (a: RateTotal, b: RateTotal) =>
  a.currency.localeCompare(b.currency) || a.treatment.localeCompare(b.treatment) || LINE_ORDER[a.line] - LINE_ORDER[b.line] || (b.rateBp ?? -1) - (a.rateBp ?? -1);

/** Invoices minus credit notes per currency, treatment and rate (proformas excluded), with the margin VAT owed. */
export function rateTotals(rows: DocRow[]): RateTotal[] {
  const map = new Map<string, RateTotal>();
  for (const r of rows.filter(isFiscal)) {
    for (const x of totalLines(r)) {
      const key = `${r.currency}|${r.treatment}|${x.line}|${x.rateBp ?? ''}`;
      const t = map.get(key) ?? { currency: r.currency, treatment: r.treatment, line: x.line, rateBp: x.rateBp, baseCents: 0, taxCents: 0, incompleteDocs: 0 };
      t.baseCents += x.baseCents;
      t.taxCents += x.taxCents;
      if (x.incomplete) t.incompleteDocs += 1;
      map.set(key, t);
    }
  }
  return [...map.values()].sort(byLine);
}

/** "21%", "Margin-scheme goods (VAT in the price)", "Margin VAT owed, 21% (not printed)". */
export function vatLineLabel(line: VatLine, rateBp: number | null): string {
  const pct = rateBp == null ? '—' : `${Number((rateBp / 100).toFixed(2))}%`;
  if (line === 'margin-goods') return 'Margin-scheme goods (VAT in the price)';
  if (line === 'margin-vat') return `Margin VAT owed, ${pct} (not printed)`;
  return pct;
}

export interface VatSummaryRow extends RateTotal {
  /** "2026-Q4" or "2026-10". */
  period: string;
  invoices: number;
  creditNotes: number;
}

/** The VAT return view: per month or quarter, currency, VAT treatment and rate, with the margin VAT owed. */
export function vatSummary(rows: DocRow[], by: 'month' | 'quarter' = 'quarter'): VatSummaryRow[] {
  const map = new Map<string, VatSummaryRow>();
  // A document with two rows of the same rate (goods + freight) counts once.
  const counted = new Set<string>();
  for (const r of rows.filter(isFiscal)) {
    const period = by === 'month' ? monthOf(r.day) : quarterOf(r.day);
    for (const x of totalLines(r)) {
      const key = `${period}|${r.currency}|${r.treatment}|${x.line}|${x.rateBp ?? ''}`;
      const t = map.get(key) ?? { period, currency: r.currency, treatment: r.treatment, line: x.line, rateBp: x.rateBp, baseCents: 0, taxCents: 0, incompleteDocs: 0, invoices: 0, creditNotes: 0 };
      t.baseCents += x.baseCents;
      t.taxCents += x.taxCents;
      if (x.incomplete) t.incompleteDocs += 1;
      if (!counted.has(`${key}|${r.id}`)) {
        counted.add(`${key}|${r.id}`);
        if (r.kind === 'INVOICE') t.invoices += 1;
        else t.creditNotes += 1;
      }
      map.set(key, t);
    }
  }
  return [...map.values()].sort((a, b) => b.period.localeCompare(a.period) || byLine(a, b));
}

export interface IcpRow {
  quarter: string;
  /** Country prefix of the buyer's VAT ID (null when the ID is missing). */
  country: string | null;
  vatId: string | null;
  buyer: string;
  currency: string;
  /** Invoices minus credit notes, excl. VAT (the supply is 0%). */
  netCents: number;
  invoices: number;
  creditNotes: number;
}

/**
 * The ICP listing (opgaaf intracommunautaire prestaties): intra-EU supplies
 * at 0% (reverse charge) per quarter and buyer VAT ID, credit notes deducted
 * in the quarter they were issued.
 */
export function icpSummary(rows: DocRow[]): IcpRow[] {
  const map = new Map<string, IcpRow>();
  for (const r of rows.filter((x) => isFiscal(x) && x.treatment === 'EU_ICS_ZERO')) {
    const quarter = quarterOf(r.day);
    const key = `${quarter}|${r.buyer.vatId ?? ''}|${r.currency}`;
    const t = map.get(key) ?? {
      quarter,
      country: vatIdCountry(r.buyer.vatId),
      vatId: r.buyer.vatId,
      buyer: r.buyer.company ?? r.buyer.name ?? '',
      currency: r.currency,
      netCents: 0,
      invoices: 0,
      creditNotes: 0,
    };
    t.netCents += r.netCents;
    if (r.kind === 'INVOICE') t.invoices += 1;
    else t.creditNotes += 1;
    if (!t.buyer) t.buyer = r.buyer.company ?? r.buyer.name ?? '';
    map.set(key, t);
  }
  return [...map.values()].sort(
    (a, b) => b.quarter.localeCompare(a.quarter) || (a.country ?? '').localeCompare(b.country ?? '') || (a.vatId ?? '').localeCompare(b.vatId ?? ''),
  );
}

export function docKindShort(kind: DocKindCode): string {
  return kind === 'PROFORMA' ? 'Proforma' : kind === 'INVOICE' ? 'Invoice' : 'Credit note';
}

export const DOC_CSV_HEADER = [
  'number',
  'issue_date',
  'kind',
  'state',
  'order_number',
  'credits_invoice',
  'currency',
  'vat_treatment',
  'vat_treatment_label',
  'line',
  'vat_rate_pct',
  'net',
  'vat',
  'gross',
  'buyer_company',
  'buyer_name',
  'buyer_vat_id',
  'buyer_country',
  'margin_vat_owed',
  'margin_vat_note',
] as const;

const csvLine = (line: VatLine) => line.replace('-', '_');

/** "unknown for 1 unit without a purchase cost (not included)" — or '' when complete. */
function marginNote(r: DocRow): string {
  if (r.treatment !== 'MARGIN_SCHEME' || r.kind === 'PROFORMA') return '';
  if (!r.marginVat) return 'not computed (no order or invoice to compute it from)';
  const n = r.marginVat.unitsWithoutCost;
  return n ? `unknown for ${n} unit${n === 1 ? '' : 's'} without a purchase cost (not included)` : '';
}

/**
 * One CSV row per document and VAT rate (a document with two rates has two
 * rows; amounts add up per column). A margin-scheme document's margin VAT
 * owed stands on its goods line only.
 */
export function docCsvRows(rows: DocRow[]): string[][] {
  return rows.flatMap((r) =>
    r.rates.map((x, i) => [
      r.number,
      r.day,
      r.kind,
      r.state,
      r.orderNumber ?? '',
      r.originalNumber ?? '',
      r.currency,
      r.treatment,
      vatTreatmentLabel(r.treatment),
      csvLine(x.line),
      csvRate(x.rateBp),
      csvMoney(x.baseCents),
      csvMoney(x.taxCents),
      csvMoney(x.baseCents + x.taxCents),
      r.buyer.company ?? '',
      r.buyer.name ?? '',
      r.buyer.vatId ?? '',
      r.buyer.country ?? '',
      ...(x.line === 'margin-goods' || (i === 0 && !r.rates.some((y) => y.line === 'margin-goods'))
        ? [r.marginVat ? csvMoney(r.marginVat.vatCents) : '', marginNote(r)]
        : ['', '']),
    ]),
  );
}

/**
 * The VAT summary CSV. line: vat (as printed) · margin_goods (margin-scheme
 * sales, VAT inside the price) · margin_vat (the margin VAT owed: net = the
 * taxable margin excl. VAT, vat = the VAT on it — the amounts to declare).
 */
export const VAT_CSV_HEADER = ['period', 'currency', 'vat_treatment', 'vat_treatment_label', 'line', 'vat_rate_pct', 'net', 'vat', 'invoices', 'credit_notes', 'incomplete_documents'] as const;

export function vatCsvRows(rows: VatSummaryRow[]): string[][] {
  return rows.map((r) => [
    periodKeyLabel(r.period),
    r.currency,
    r.treatment,
    vatTreatmentLabel(r.treatment),
    csvLine(r.line),
    csvRate(r.rateBp),
    csvMoney(r.baseCents),
    csvMoney(r.taxCents),
    String(r.invoices),
    String(r.creditNotes),
    r.line === 'margin-vat' ? String(r.incompleteDocs) : '',
  ]);
}

export const ICP_CSV_HEADER = ['quarter', 'country', 'buyer_vat_id', 'buyer', 'currency', 'amount', 'invoices', 'credit_notes'] as const;

export function icpCsvRows(rows: IcpRow[]): string[][] {
  return rows.map((r) => [
    periodKeyLabel(r.quarter),
    r.country ?? '',
    r.vatId ?? 'MISSING',
    r.buyer,
    r.currency,
    csvMoney(r.netCents),
    String(r.invoices),
    String(r.creditNotes),
  ]);
}
