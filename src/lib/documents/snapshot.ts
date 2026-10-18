import type { VatTreatmentCode, VatDecision } from '@/lib/tax/determine';
import { taxOn, vatTreatmentLabel } from '@/lib/tax/determine';
import type { DocLabels } from './labels';

/**
 * The frozen content of an issued document (FiscalDocument.snapshot). The PDF
 * and the HTML preview are rendered from THIS object only (render.ts) — never
 * from live order / company / settings data — so an issued document can not
 * change after it was sent. Bump `v` when the shape changes; the renderer
 * must keep rendering every older version. Fields added later are optional:
 * a snapshot without them renders exactly as it did when it was issued.
 */

export type DocKindCode = 'PROFORMA' | 'INVOICE' | 'CREDIT_NOTE';

export interface DocPartySnapshot {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  vatId: string | null;
  lines: string[];
  country: string | null;
  /**
   * Contact person printed as "Attn. …" under the company (bill-to structure:
   * Company / Attn. contact / address / VAT ID / email). Present on documents
   * issued with this layout; older snapshots print `name` as before.
   */
  attention?: string | null;
}

export interface DocLineSnapshot {
  description: string;
  detail: string | null;
  qty: number;
  unitCents: number;
  netCents: number;
  /** null = rate not determinable (legacy) — the column shows "—". */
  vatRateBp: number | null;
  taxCents: number;
  lineType: 'GOODS' | 'SHIPPING' | 'SERVICE' | 'DISCOUNT';
}

export interface DocVatRowSnapshot {
  rateBp: number | null;
  baseCents: number;
  taxCents: number;
}

/** What happens to the money a credit note credits (decided from what was really paid and refunded). */
export interface CreditSettlement {
  /**
   * REFUND: the buyer paid; refund by transfer (approved, not sent yet) ·
   * REFUND_CARD: refunded to the card (Stripe) · NOT_PAID: nothing was paid —
   * the amount is no longer due, nothing is refunded · PART_REFUND: partly
   * paid — part refunded, the rest is no longer due · REFUNDED: the money was
   * already refunded before this credit note (e.g. an older refund without one) ·
   * REPLACED: the invoice is corrected by a new one; no money moves.
   */
  kind: 'REFUND' | 'REFUND_CARD' | 'NOT_PAID' | 'PART_REFUND' | 'REFUNDED' | 'REPLACED';
  refundCents: number;
  cancelledCents: number;
}

export type DocPaymentBox =
  | { kind: 'INSTRUCTIONS'; reference: string; amountCents: number; dueDate: string | null; bankAvailable: boolean }
  /**
   * paidAt = value date of the payment that completed it (payments ledger);
   * amountCents = what was received. writtenOffCents: a short payment accepted
   * within UNDERPAYMENT_TOLERANCE_CENTS — printed as "Received … — … written off".
   */
  | { kind: 'PAID'; paidAt: string | null; method: string | null; amountCents?: number; writtenOffCents?: number }
  | { kind: 'DUE'; dueDate: string | null; reference: string; amountCents: number }
  /** Paid in part (e.g. a VAT correction raised the total): what came in, what is still due. */
  | { kind: 'PARTLY_PAID'; paidCents: number; paidAt: string | null; openCents: number; dueDate: string | null; reference: string }
  | { kind: 'CREDIT'; originalNumber: string; refundMethod: string | null; settlement?: CreditSettlement }
  | null;

/**
 * What a credit note does with the money (8c, credit notes issued from the
 * refund ledger): the part that cancels an unpaid amount due (no money moves)
 * and the part refunded as money — and whether that money is still to be sent
 * (bank transfer) or was already initiated (card refund).
 */
export interface DocCreditSettlement {
  receivableCents: number;
  refundCents: number;
  /** "bank transfer" | "card refund (Stripe)" | … ; null when nothing is refunded. */
  refundMethod: string | null;
  /** TO_BE_SENT: bank transfer not sent yet · INITIATED: card refund issued. */
  refundState: 'TO_BE_SENT' | 'INITIATED' | null;
}

export interface DocumentSnapshot {
  v: 1;
  kind: DocKindCode;
  title: string;
  number: string;
  version: number;
  issueDate: string;
  supplyDate: string | null;
  dueDate: string | null;
  currency: string;
  orderNumber: string | null;
  refs: Array<{ label: string; value: string }>;
  seller: {
    name: string;
    addressLines: string[];
    country: string;
    city: string;
    kvk: string;
    vatId: string;
    eori: string;
    email: string;
    phone: string;
    web: string;
    /** Logo as it was at issue time (uploads are content-addressed by timestamp). */
    logoPath: string;
  };
  bank: { beneficiary: string; bankName: string; iban: string; bic: string } | null;
  buyer: DocPartySnapshot;
  shipTo: DocPartySnapshot | null;
  lines: DocLineSnapshot[];
  vat: {
    treatment: VatTreatmentCode;
    label: string;
    rows: DocVatRowSnapshot[];
    legalText: string | null;
    buyerVatId: string | null;
    viesConsultation: string | null;
    /** Printed when the treatment is not final (proforma before addresses are known). */
    pendingNote: string | null;
  };
  totals: { goodsCents: number; shippingCents: number; netCents: number; taxCents: number; totalCents: number };
  payment: DocPaymentBox;
  notes: string[];
  /** The accepted offer's remark to the buyer, printed under "Remark" (only when set). */
  remarks?: string[];
  terms: string[];
  clauses: string[];
  original: { number: string; issueDate: string } | null;
  footerExtra: string | null;
  /** Frozen from the pre-4_business_core renderer (legacy number series). */
  legacy?: boolean;
  /** Prepaid invoice of goods not shipped yet: the date the advance payment was received (art. 35a Wet OB). */
  advancePaymentDate?: string | null;
  /** Fixed texts in the document language, frozen at issue (labels.ts). Absent on older documents (English). */
  labels?: DocLabels;
  /** Language and formats frozen at issue. Absent on older documents (en-GB dates, en-IE money, Europe/Amsterdam). */
  locale?: { lang: string; dateLocale: string; moneyLocale: string; timeZone: string };
  /** Internal, never printed: why the document was issued as it is. */
  audit: { vatReasons: string[]; warnings: string[] };
}

type Addr = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The postcode / city / region lines of an address in the destination's own
 * order (what carriers and AP departments expect):
 *   US, CA, AU    "Boston, MA 02115" · "Toronto, ON M5V 2T6" · "Melbourne, VIC 3000"
 *   GB, IE        "London" then the postcode on its own line ("SW1A 1AA")
 *   elsewhere     "1000 AA Amsterdam" (postcode before the city), ", region" after it
 */
export function localityLines(parts: { postalCode: string | null; city: string | null; region: string | null }, countryCode: string | null): string[] {
  const { postalCode: zip, city, region } = parts;
  const cc = (countryCode ?? '').toUpperCase();
  if (cc === 'US' || cc === 'CA' || cc === 'AU') {
    const tail = [region, zip].filter(Boolean).join(' ');
    const line = [city, tail].filter(Boolean).join(', ');
    return line ? [line] : [];
  }
  if (cc === 'GB' || cc === 'IE') {
    return [[city, region].filter(Boolean).join(', '), zip ?? ''].filter(Boolean);
  }
  const line = [[zip, city].filter(Boolean).join(' '), region].filter(Boolean).join(', ');
  return line ? [line] : [];
}

/**
 * Address JSON (checkout / Stripe / payment-page shape) → printable party.
 * `countryName` prints the country in full (document language) instead of
 * its ISO code; `country` keeps the code. The postcode / city / region follow
 * the destination's own format (localityLines).
 */
export function partyFromAddress(raw: unknown, fallbackName: string, countryName?: (code: string) => string): DocPartySnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Addr;
  const a = ((o.address as Addr) && typeof o.address === 'object' ? o.address : o) as Addr;
  const country = str(a.country);
  const isCode = !!country && /^[A-Za-z]{2}$/.test(country);
  const countryLine = isCode && countryName ? countryName(country!.toUpperCase()) : country;
  const locality = localityLines({ postalCode: str(a.postal_code) ?? str(a.postalCode), city: str(a.city), region: str(a.state) ?? str(a.region) }, isCode ? country : null);
  const lines = [str(a.line1), str(a.line2), ...locality, countryLine]
    .filter((x): x is string => !!x);
  const party: DocPartySnapshot = {
    name: str(o.name) ?? fallbackName,
    company: str(o.company),
    email: str(o.email),
    phone: str(o.phone),
    vatId: str(o.vat) ?? str(o.vatId),
    lines,
    country: isCode ? country!.toUpperCase() : null,
  };
  return party.lines.length || party.company ? party : null;
}

/** The parts of a postal address that are missing (street, postcode, city, country). */
export function addressGaps(raw: unknown): Array<'street' | 'postcode' | 'city' | 'country'> {
  if (!raw || typeof raw !== 'object') return ['street', 'postcode', 'city', 'country'];
  const o = raw as Addr;
  const a = ((o.address as Addr) && typeof o.address === 'object' ? o.address : o) as Addr;
  const gaps: Array<'street' | 'postcode' | 'city' | 'country'> = [];
  if (!str(a.line1)) gaps.push('street');
  if (!(str(a.postal_code) ?? str(a.postalCode))) gaps.push('postcode');
  if (!str(a.city)) gaps.push('city');
  const c = str(a.country);
  if (!c || !/^[A-Za-z]{2}$/.test(c)) gaps.push('country');
  return gaps;
}

/**
 * What a document needs that is legally required (NL invoice requirements,
 * art. 35a Wet OB): the full seller identity, the buyer's name AND full
 * address (street, postcode, city, country — `buyerAddressGaps` from
 * addressGaps()), and the buyer's VAT ID for an intra-EU 0% supply.
 */
export function missingInvoiceDetails(
  s: Pick<DocumentSnapshot, 'seller' | 'buyer' | 'vat'>,
  legalNameConfigured = true,
  buyerAddressGaps?: string[],
): string[] {
  const missing: string[] = [];
  if (!s.seller.name || !legalNameConfigured) missing.push('seller legal name (Settings → Company)');
  if (!s.seller.addressLines.length) missing.push('seller address (Settings → Company)');
  if (!s.seller.vatId) missing.push('seller VAT ID (Settings → Company)');
  if (!s.seller.kvk) missing.push('seller KvK number (Settings → Company)');
  if (!s.buyer.name && !s.buyer.company) missing.push('buyer name');
  if (buyerAddressGaps) {
    if (buyerAddressGaps.length) missing.push(`buyer billing address (${buyerAddressGaps.join(', ')} missing)`);
  } else if (!s.buyer.lines.length) {
    missing.push('buyer billing address');
  }
  if (s.vat.treatment === 'EU_ICS_ZERO' && !s.vat.buyerVatId) missing.push('buyer VAT ID (required for intra-EU 0%)');
  return missing;
}

/**
 * VAT rows + line taxes for what an order was actually CHARGED when the VAT
 * rules could not confirm it (legacy flat-rate orders). Reproduces the old
 * formula (rate on the goods subtotal, shipping untaxed) — trying the flat
 * rate the order was priced with first, then the other known rates (the home
 * standard rate, reduced rates) so the document names the rate that really
 * produced the charged amount; when none fits, the percentage is not printed
 * (never "21.01%").
 */
export function chargedVat(
  goodsNetCents: number,
  shippingCents: number,
  taxCents: number,
  flatRateBp: number,
  candidateRatesBp: number[] = [],
): { rows: DocVatRowSnapshot[]; goodsRateBp: number | null; shippingRateBp: number | null } {
  if (taxCents === 0) {
    return { rows: [{ rateBp: 0, baseCents: goodsNetCents + shippingCents, taxCents: 0 }], goodsRateBp: 0, shippingRateBp: 0 };
  }
  const rates = Array.from(new Set([flatRateBp, ...candidateRatesBp].filter((r) => Number.isInteger(r) && r > 0)));
  for (const rate of rates) {
    if (taxOn(goodsNetCents, rate) === taxCents) {
      const rows: DocVatRowSnapshot[] = [{ rateBp: rate, baseCents: goodsNetCents, taxCents }];
      if (shippingCents > 0) rows.push({ rateBp: 0, baseCents: shippingCents, taxCents: 0 });
      return { rows, goodsRateBp: rate, shippingRateBp: shippingCents > 0 ? 0 : null };
    }
    if (taxOn(goodsNetCents + shippingCents, rate) === taxCents) {
      return { rows: [{ rateBp: rate, baseCents: goodsNetCents + shippingCents, taxCents }], goodsRateBp: rate, shippingRateBp: rate };
    }
  }
  return { rows: [{ rateBp: null, baseCents: goodsNetCents + shippingCents, taxCents }], goodsRateBp: null, shippingRateBp: null };
}

/** VAT rows from an engine decision. */
export function vatRowsFromDecision(d: VatDecision): DocVatRowSnapshot[] {
  return d.breakdown
    .filter((r) => r.treatment !== 'MARGIN_SCHEME')
    .map((r) => ({ rateBp: r.rateBp, baseCents: r.baseCents, taxCents: r.taxCents }));
}

export function vatLabel(t: VatTreatmentCode): string {
  return vatTreatmentLabel(t);
}

export function docTitle(kind: DocKindCode): string {
  return kind === 'PROFORMA' ? 'Proforma invoice' : kind === 'INVOICE' ? 'Invoice' : 'Credit note';
}

/** Mirror of a document's lines for a full credit note (amounts negated). */
export function negateLines(lines: DocLineSnapshot[]): DocLineSnapshot[] {
  return lines.map((l) => ({ ...l, qty: -l.qty, netCents: -l.netCents, taxCents: -l.taxCents }));
}

export function negateRows(rows: DocVatRowSnapshot[]): DocVatRowSnapshot[] {
  return rows.map((r) => ({ ...r, baseCents: -r.baseCents, taxCents: -r.taxCents }));
}

/**
 * Split a gross credit amount over the original invoice's VAT rows
 * proportionally to their gross share (partial credits). Each row's VAT is its
 * rate applied to its base (21% of €82.64 is €17.35 — never €17.36), so the
 * rows can add up to a cent more or less than asked: the credit note and the
 * refund then use exactly the amounts on the document (sum of the rows).
 */
export function splitGrossOverRows(grossCents: number, rows: DocVatRowSnapshot[]): DocVatRowSnapshot[] {
  const totalGross = rows.reduce((a, r) => a + r.baseCents + r.taxCents, 0);
  if (totalGross === 0 || rows.length === 0) return [{ rateBp: 0, baseCents: grossCents, taxCents: 0 }];
  let left = grossCents;
  return rows.map((r, i) => {
    const share = i === rows.length - 1 ? left : Math.round((grossCents * (r.baseCents + r.taxCents)) / totalGross);
    left -= share;
    if (r.rateBp == null) {
      // Rate not determinable (legacy document): keep the proportion of the original row.
      const rate = r.baseCents ? Math.round((r.taxCents / r.baseCents) * 10000) : 0;
      const base = Math.round((share * 10000) / (10000 + rate));
      return { rateBp: r.rateBp, baseCents: base, taxCents: share - base };
    }
    const base = baseForGross(share, r.rateBp);
    return { rateBp: r.rateBp, baseCents: base, taxCents: taxOn(base, r.rateBp) };
  });
}

/** The net base whose base + VAT(rate) is closest to `gross` (exact when one exists; ties → the lower amount). */
export function baseForGross(gross: number, rateBp: number): number {
  const guess = Math.round((gross * 10000) / (10000 + rateBp));
  let best = guess;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const b of [guess - 1, guess, guess + 1]) {
    const diff = b + taxOn(b, rateBp) - gross;
    if (Math.abs(diff) < Math.abs(bestDiff) || (Math.abs(diff) === Math.abs(bestDiff) && diff < bestDiff)) {
      best = b;
      bestDiff = diff;
    }
  }
  return best;
}

/** Gross amount a partial credit of `grossCents` really comes to (sum of its exact VAT rows). */
export function creditableGross(grossCents: number, rows: DocVatRowSnapshot[]): number {
  return splitGrossOverRows(grossCents, rows).reduce((a, r) => a + r.baseCents + r.taxCents, 0);
}
