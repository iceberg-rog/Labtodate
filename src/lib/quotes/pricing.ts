/**
 * Pure offer arithmetic + the offer snapshot shape (no I/O, no settings reads —
 * callers pass the values). Unit tests: pricing.test.ts.
 *
 * An offer is a fixed commercial proposal: the NET amounts (goods × qty +
 * freight) and the terms are frozen when staff send it (SourcingRequest
 * offer* columns + offerTerms). VAT follows the law for the buyer: it is
 * decided by the VAT engine from the buyer's billing country / VAT ID — at send
 * time when they are known, otherwise at acceptance ("VAT determined at
 * acceptance"). The order is created from exactly these numbers.
 */

import { taxOn, vatTreatmentLabel, type VatTreatmentCode } from '@/lib/tax/determine';

export type MarkupRounding = 'NONE' | 'WHOLE' | 'TEN' | 'HUNDRED';

/** Buyer price from a supplier price: + markup, rounded UP to the step. */
export function applyMarkup(costCents: number, markupBp: number, rounding: MarkupRounding): number {
  const raw = Math.round((costCents * (10000 + Math.max(0, markupBp))) / 10000);
  const step = rounding === 'WHOLE' ? 100 : rounding === 'TEN' ? 1000 : rounding === 'HUNDRED' ? 10000 : 1;
  return Math.ceil(raw / step) * step;
}

/** "VIP:2,URGENT:2,HIGH:8,NORMAL:24,LOW:72" → { VIP: 2, … }. Bad pairs are skipped. */
export function parseSlaHours(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (raw || '').split(',')) {
    const m = /^\s*(VIP|URGENT|HIGH|NORMAL|LOW)\s*:\s*(\d{1,4})\s*$/i.exec(part);
    if (m) out[m[1].toUpperCase()] = Number(m[2]);
  }
  if (out.NORMAL == null) out.NORMAL = 24;
  return out;
}

export interface OfferPaymentTerms {
  /** PREPAY: payment in full before dispatch (bank transfer). */
  kind: 'PREPAY';
  /** Days after acceptance the proforma is due. */
  days: number;
  /** Printed sentence (setting OFFER_PAYMENT_TERMS_TEXT with {DAYS} filled). */
  text: string;
}

/** The buyer details the VAT of an offer was decided on (or why not). */
export interface OfferVatBasis {
  status: 'DECIDED' | 'AT_ACCEPTANCE';
  /** Country the decision used (billing / delivery). */
  country: string | null;
  vatId: string | null;
  /** Engine reasons, or why it could not be decided yet. */
  reasons: string[];
  legalText: string | null;
  shippingRateBp: number | null;
  /** DECIDED: the treatment as the buyer reads it (buyerVatLabel); null on older offers. */
  buyerLabel?: string | null;
}

/** offerTerms JSON (v1) — frozen with the offer. */
export interface OfferTerms {
  v: 1;
  qty: number;
  unitCents: number;
  incoterm: string | null;
  incotermPlace: string | null;
  leadTime: string | null;
  warranty: string | null;
  paymentTerms: OfferPaymentTerms;
  vatBasis: OfferVatBasis;
  /** The previous offer's total, for "updated offer" wording. */
  previous?: { totalCents: number | null; netCents: number; currency: string } | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Tolerant read of a stored offerTerms JSON (null for legacy offers). */
export function parseOfferTerms(raw: unknown): OfferTerms | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const pt = (o.paymentTerms && typeof o.paymentTerms === 'object' ? o.paymentTerms : {}) as Record<string, unknown>;
  const vb = (o.vatBasis && typeof o.vatBasis === 'object' ? o.vatBasis : {}) as Record<string, unknown>;
  const prev = o.previous && typeof o.previous === 'object' ? (o.previous as Record<string, unknown>) : null;
  return {
    v: 1,
    qty: Math.max(1, num(o.qty) ?? 1),
    unitCents: num(o.unitCents) ?? 0,
    incoterm: str(o.incoterm),
    incotermPlace: str(o.incotermPlace),
    leadTime: str(o.leadTime),
    warranty: str(o.warranty),
    paymentTerms: { kind: 'PREPAY', days: num(pt.days) ?? 14, text: str(pt.text) ?? '' },
    vatBasis: {
      status: vb.status === 'DECIDED' ? 'DECIDED' : 'AT_ACCEPTANCE',
      country: str(vb.country),
      vatId: str(vb.vatId),
      reasons: Array.isArray(vb.reasons) ? vb.reasons.filter((r): r is string => typeof r === 'string') : [],
      legalText: str(vb.legalText),
      shippingRateBp: num(vb.shippingRateBp),
      buyerLabel: str(vb.buyerLabel),
    },
    previous: prev ? { totalCents: num(prev.totalCents), netCents: num(prev.netCents) ?? 0, currency: str(prev.currency) ?? 'EUR' } : null,
  };
}

export function fillPaymentTermsText(template: string, days: number): string {
  const t = (template || 'Payment in full by bank transfer within {DAYS} days of acceptance, before dispatch.').trim();
  return t.replace(/\{DAYS\}/g, String(days));
}

export function incotermLabel(t: Pick<OfferTerms, 'incoterm' | 'incotermPlace'> | null | undefined): string | null {
  if (!t?.incoterm) return null;
  return `${t.incoterm}${t.incotermPlace ? ` ${t.incotermPlace}` : ''} (Incoterms® 2020)`;
}

/** What a buyer sees for an offer: net amounts, VAT (when decided), total. */
export interface OfferAmounts {
  goodsCents: number;
  shippingCents: number;
  netCents: number;
  vatDecided: boolean;
  vatTreatment: VatTreatmentCode | null;
  vatTreatmentLabel: string | null;
  vatRateBp: number | null;
  vatCents: number | null;
  /** Gross when VAT is decided; the net total otherwise. */
  totalCents: number;
}

/** Amounts of a stored offer snapshot. Legacy offers (no snapshot): net price only, VAT at acceptance. */
export function offerAmounts(sr: {
  quotedPriceCents: number | null;
  offerSubtotalCents?: number | null;
  offerShippingCents?: number | null;
  offerVatTreatment?: string | null;
  offerVatRateBp?: number | null;
  offerVatCents?: number | null;
  offerTotalCents?: number | null;
}): OfferAmounts {
  const goods = sr.offerSubtotalCents ?? sr.quotedPriceCents ?? 0;
  const shipping = sr.offerShippingCents ?? 0;
  const net = goods + shipping;
  const decided = sr.offerVatTreatment != null && sr.offerVatCents != null && sr.offerTotalCents != null;
  return {
    goodsCents: goods,
    shippingCents: shipping,
    netCents: net,
    vatDecided: decided,
    vatTreatment: decided ? (sr.offerVatTreatment as VatTreatmentCode) : null,
    vatTreatmentLabel: decided ? vatTreatmentLabel(sr.offerVatTreatment) : null,
    vatRateBp: decided ? sr.offerVatRateBp ?? 0 : null,
    vatCents: decided ? sr.offerVatCents ?? 0 : null,
    totalCents: decided ? (sr.offerTotalCents as number) : net,
  };
}

/** Tax of one offer at a known goods/shipping rate (preview in the offer form). */
export function previewTax(goodsCents: number, shippingCents: number, goodsRateBp: number, shippingRateBp: number): number {
  return taxOn(goodsCents, goodsRateBp) + taxOn(shippingCents, shippingRateBp);
}

/** "21%" / "0%" / "25.5%" from basis points. */
export function pctLabel(bp: number | null | undefined): string {
  if (bp == null) return '—';
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** End of the given calendar day (UTC). */
export function endOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/** Due / validity date N days from `from`, at the end of that day (UTC). */
export function daysFrom(from: Date, days: number): Date {
  return endOfDayUtc(new Date(from.getTime() + days * 86_400_000));
}
