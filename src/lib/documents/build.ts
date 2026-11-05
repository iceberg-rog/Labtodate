import { decideVat, vatCents, type VatTreatment, type ViesEvidence } from '@/lib/tax/vat';
import { companySnapshot } from './company';
import { getGeneral, getLabels, getOptions, getTexts } from './config';
import { asLang, type CompanySnapshot, type DocKind, type DocLine, type DocParty, type DocSnapshot, type Lang } from './types';

/**
 * Snapshot builders: turn a quote, an order or sample data plus the current
 * templates into the frozen DocSnapshot the renderer prints.
 */

export const TIME_ZONE = 'Europe/Amsterdam';

/** What the quote composer stores on SourcingRequest.quoteDetails. */
export interface QuoteDetails {
  v: 1;
  lines: DocLine[];
  shippingCents: number;
  billing: { name?: string | null; company?: string | null; addressLines: string[]; country?: string | null; vatId?: string | null };
  vies?: ViesEvidence | null;
  vat: { treatment: Exclude<VatTreatment, 'REVIEW'>; rateBp: number; reason: string; overridden: boolean };
  lang: Lang;
  validDays: number;
}

export function parseQuoteDetails(raw: unknown): QuoteDetails | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<QuoteDetails>;
  if (d.v !== 1 || !Array.isArray(d.lines) || !d.vat) return null;
  return d as QuoteDetails;
}

export interface Totals {
  subtotalCents: number;
  shippingCents: number;
  vatCents: number;
  totalCents: number;
}

/** One rule for every surface: VAT on (lines + shipping), rounded half up. */
export function computeTotals(lines: DocLine[], shippingCents: number, rateBp: number): Totals {
  const subtotalCents = lines.reduce((s, l) => s + Math.round(l.unitCents * l.qty), 0);
  const base = subtotalCents + Math.max(0, shippingCents);
  const v = vatCents(base, rateBp);
  return { subtotalCents, shippingCents: Math.max(0, shippingCents), vatCents: v, totalCents: base + v };
}

/** Address JSON as stored on orders (payment workspace / Stripe). */
export function addressLinesFrom(raw: unknown): { lines: string[]; company: string | null; vat: string | null; country: string | null; name: string | null } {
  const out = { lines: [] as string[], company: null as string | null, vat: null as string | null, country: null as string | null, name: null as string | null };
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  const ad = ((src.address as Record<string, unknown>) || src) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const cityLine = [s(ad.postal_code) || s(ad.postal), s(ad.city)].filter(Boolean).join(' ');
  out.lines = [s(ad.line1), s(ad.line2), cityLine, s(ad.state), s(ad.country)].filter(Boolean);
  out.company = s(src.company) || null;
  out.vat = s(src.vat) || null;
  out.country = (s(ad.country) || '').toUpperCase() || null;
  out.name = s(src.name) || null;
  return out;
}

async function templateParts(kind: DocKind, lang: Lang) {
  const [texts, labels, options, general] = await Promise.all([getTexts(kind, lang), getLabels(lang), getOptions(kind), getGeneral()]);
  return { texts, labels, options, accent: general.accent };
}

interface BaseArgs {
  kind: DocKind;
  lang: Lang;
  number: string;
  revision?: number;
  issuedAt: Date;
  currency: string;
  customer: DocParty;
  shipTo?: string[] | null;
  lines: DocLine[];
  shippingCents: number;
  vat: { treatment: VatTreatment | 'LEGACY'; rateBp: number; reason?: string | null; cents?: number };
  refs?: DocSnapshot['refs'];
  note?: string | null;
  paid?: boolean;
  paidAt?: Date | null;
  paymentMethod?: string | null;
  validUntil?: Date | null;
  preview?: boolean;
  company?: CompanySnapshot;
  /** Template overrides (the admin's unsaved edits in the live preview). */
  override?: Partial<Pick<DocSnapshot, 'texts' | 'labels' | 'options'>> & { accent?: string };
  /** Legacy documents keep the exact totals they were issued with. */
  fixedTotals?: Totals;
}

export async function buildSnapshot(a: BaseArgs): Promise<DocSnapshot> {
  const parts = await templateParts(a.kind, a.lang);
  const texts = a.override?.texts ?? parts.texts;
  const labels = a.override?.labels ?? parts.labels;
  const options = a.override?.options ?? parts.options;
  const accent = a.override?.accent ?? parts.accent;
  const company = a.company ?? (await companySnapshot({ withLogo: options.showLogo }));
  const t = a.fixedTotals ?? computeTotals(a.lines, a.shippingCents, a.vat.rateBp);
  const vatCentsValue = a.fixedTotals ? a.fixedTotals.vatCents : a.vat.cents ?? t.vatCents;
  const dueDate = a.kind === 'INVOICE' && !a.paid ? endOfDayUtc(addDays(a.issuedAt, options.days)) : null;
  return {
    v: 1,
    kind: a.kind,
    lang: a.lang,
    number: a.number,
    revision: a.revision ?? 1,
    paid: !!a.paid,
    preview: a.preview || undefined,
    issuedAt: a.issuedAt.toISOString(),
    validUntil: a.validUntil ? a.validUntil.toISOString() : null,
    dueDate: dueDate ? dueDate.toISOString() : null,
    paidAt: a.paidAt ? a.paidAt.toISOString() : null,
    paymentMethod: a.paymentMethod ?? null,
    currency: a.currency || 'EUR',
    company,
    customer: a.customer,
    shipTo: a.shipTo ?? null,
    lines: a.lines,
    shippingCents: t.shippingCents,
    subtotalCents: t.subtotalCents,
    vat: { treatment: a.vat.treatment, rateBp: a.vat.rateBp, cents: vatCentsValue, reason: a.vat.reason ?? null },
    totalCents: a.fixedTotals ? a.fixedTotals.totalCents : t.subtotalCents + t.shippingCents + vatCentsValue,
    refs: a.refs ?? {},
    note: a.note ?? null,
    texts,
    labels,
    options,
    accent,
    timeZone: TIME_ZONE,
  };
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Date-only values (valid until / due) are stored as the end of a UTC day. */
export function endOfDayUtc(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 0);
  return x;
}

// ─── Sample data for the admin preview ────────────────────────────────

export type SampleKind = 'nl' | 'eu' | 'export';

export function sampleCustomer(sample: SampleKind): { customer: DocParty; country: string } {
  if (sample === 'eu') {
    return {
      country: 'DE',
      customer: { name: 'Dr. Jonas Weber', company: 'Rhein Analytik GmbH', email: 'j.weber@rhein-analytik.de', addressLines: ['Industriestraße 12', '50667 Köln', 'Germany'], country: 'DE', vatId: 'DE123456789', number: 'C-1043' },
    };
  }
  if (sample === 'export') {
    return {
      country: 'US',
      customer: { name: 'Emily Carter', company: 'Boston Bioassay Inc.', email: 'emily@bostonbioassay.com', addressLines: ['200 Summer Street', 'Boston, MA 02210', 'United States'], country: 'US', vatId: null, number: 'C-1044' },
    };
  }
  return {
    country: 'NL',
    customer: { name: 'Dr. Anna de Vries', company: 'Utrecht Bioanalytics B.V.', email: 'anna@utrecht-bio.nl', addressLines: ['Padualaan 8', '3584 CH Utrecht', 'Netherlands'], country: 'NL', vatId: 'NL123456789B01', number: 'C-1042' },
  };
}

export const SAMPLE_LINES: DocLine[] = [
  { title: 'Agilent 1260 Infinity II quaternary pump G7111B (refurbished)', qty: 1, unitCents: 1_185_000, detail: 'Serial DEAB912345 · tested and cleaned' },
  { title: 'Seal wash kit and preventive-maintenance parts', qty: 2, unitCents: 18_500 },
];

export async function sampleSnapshot(args: {
  kind: DocKind;
  lang: Lang;
  sample: SampleKind;
  override?: BaseArgs['override'];
  vatSettings: Parameters<typeof decideVat>[1];
}): Promise<DocSnapshot> {
  const { customer, country } = sampleCustomer(args.sample);
  const decision = decideVat(
    { country, vatId: customer.vatId, vies: customer.vatId ? { vatId: customer.vatId, status: 'VALID', name: customer.company } : null },
    args.vatSettings,
  );
  const treatment = decision.treatment === 'REVIEW' ? 'DOMESTIC' : decision.treatment;
  const rateBp = treatment === 'DOMESTIC' ? Math.round((args.vatSettings?.standardRatePct ?? 21) * 100) : 0;
  const now = new Date();
  const options = args.override?.options;
  const days = options?.days ?? (await getOptions(args.kind)).days;
  const sampleNumber = args.kind === 'QUOTE' ? 'PRO-2026-0007' : args.kind === 'INVOICE' ? 'INV-2026-00012' : 'RCT-2026-00012';
  return buildSnapshot({
    kind: args.kind,
    lang: args.lang,
    number: sampleNumber,
    issuedAt: now,
    currency: 'EUR',
    customer,
    lines: SAMPLE_LINES,
    shippingCents: 9_500,
    vat: { treatment, rateBp, reason: decision.reason },
    refs: { orderNumber: 'L2D-2026-7KQ2XF', quoteNumber: 'PRO-2026-0007', invoiceNumber: 'INV-2026-00012' },
    note: args.kind === 'QUOTE' ? 'Lead time: 2–3 weeks after payment. Includes on-site installation check.' : null,
    paid: args.kind !== 'INVOICE' ? args.kind === 'RECEIPT' : false,
    paidAt: args.kind === 'RECEIPT' ? now : null,
    paymentMethod: args.kind === 'RECEIPT' ? 'BANK_TRANSFER' : null,
    validUntil: args.kind === 'QUOTE' ? endOfDayUtc(addDays(now, days)) : null,
    preview: true,
    override: args.override,
  });
}

export function langOf(...candidates: unknown[]): Lang {
  for (const c of candidates) if (c === 'en' || c === 'nl') return c;
  return asLang(undefined);
}
