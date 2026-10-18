/**
 * VAT engine (A01 / B01) — ONE pure function that decides how a sale is taxed.
 * No I/O: the caller passes the settings (lib/tax/settings.ts), the country
 * facts (CountryPolicy table) and an already-resolved VIES result
 * (lib/tax/vies.ts). Unit tests: src/lib/tax/determine.test.ts.
 *
 * Rules (Dutch seller, goods):
 *  - Ship-to = home country (NL) ................ DOMESTIC_STANDARD, 21% on goods and shipping
 *  - Ship-to outside the EU ..................... EXPORT_ZERO, 0% (setting), whatever the billing country
 *  - Ship-to another EU state, buyer has a VIES-valid VAT ID of a member state
 *    other than the home country ................ EU_ICS_ZERO, 0% + legal text + buyer VAT ID on the invoice
 *      · VIES unavailable → TAX_VIES_DOWN_POLICY (review / home VAT / block)
 *      · VAT ID invalid   → treated as a buyer without a VAT ID
 *  - Ship-to another EU state, no (valid) VAT ID  EU_B2C_HOME (home rate) or EU_B2C_OSS (destination rate)
 *  - Lines of products under the margin scheme (setting on) are taxed on the
 *    margin, VAT not shown (MARGIN_SCHEME); exports of them stay 0%.
 *  - Shipping follows the treatment of the goods (setting), else home rate.
 *  - Anything the rules cannot decide → REVIEW_REQUIRED with the reason; a
 *    rule that forbids the sale → blocked.
 *
 * Amounts: tax is computed per rate group on the summed base (round half up),
 * then allocated to lines (largest line takes the rounding cent), so the
 * document total always equals the sum of its VAT rows.
 */

export type VatTreatmentCode =
  | 'DOMESTIC_STANDARD'
  | 'EU_ICS_ZERO'
  | 'EU_B2C_HOME'
  | 'EU_B2C_OSS'
  | 'EXPORT_ZERO'
  | 'MARGIN_SCHEME'
  | 'REVIEW_REQUIRED'
  | 'LEGACY_UNSPECIFIED';

export type CustomerKind = 'BUSINESS' | 'CONSUMER' | 'UNKNOWN';
export type LegalTextKey = 'ICS' | 'EXPORT' | 'MARGIN' | 'OSS';

export interface TaxSettings {
  homeCountry: string;
  standardRateBp: number;
  shippingFollowsMain: boolean;
  icsEnabled: boolean;
  icsRequireVies: boolean;
  viesDownPolicy: 'MANUAL_REVIEW' | 'CHARGE_HOME_VAT' | 'BLOCK';
  exportZeroEnabled: boolean;
  euB2cMode: 'HOME_RATE' | 'OSS';
  marginSchemeEnabled: boolean;
  salesMode: 'B2B_ONLY' | 'B2B_AND_B2C';
  legalTexts: Record<LegalTextKey, string>;
}

/** What the engine needs to know about countries (from the CountryPolicy table). */
export interface CountryFacts {
  isEu(country: string): boolean;
  /** Standard VAT rate of an EU member state in basis points (for OSS), null if unknown. */
  standardRateBp(country: string): number | null;
}

export interface VatIdEvidence {
  vatId: string;
  /** ISO country of the VAT ID (GR for an EL prefix). */
  country: string;
  status: 'VALID' | 'INVALID' | 'UNAVAILABLE' | 'NOT_CHECKED';
  name?: string | null;
  consultationNumber?: string | null;
  checkedAt?: string | null;
  /** Shape check result when VIES was not consulted. */
  formatValid?: boolean;
}

export interface VatLineInput {
  /** Net amount of the line (qty × unit) in cents. Margin lines: the selling price. */
  netCents: number;
  lineType: 'GOODS' | 'SHIPPING' | 'SERVICE' | 'DISCOUNT';
  scheme?: 'STANDARD' | 'MARGIN';
  /** Purchase cost of a margin-scheme line (for the internal margin VAT). */
  purchaseCostCents?: number | null;
}

export interface VatContext {
  /** Where the goods go (decides the treatment). */
  shipToCountry: string | null;
  /** Buyer's billing country (used when no ship-to is known yet). */
  billingCountry: string | null;
  customerKind: CustomerKind;
  vatId: VatIdEvidence | null;
  /** Buyer's registered company name from the billing details (to compare with the VIES name). */
  buyerLegalName?: string | null;
  lines: VatLineInput[];
}

export interface VatLineResult {
  index: number;
  lineType: VatLineInput['lineType'];
  treatment: VatTreatmentCode;
  rateBp: number;
  netCents: number;
  /** VAT added on top of the net amount (0 for margin / zero-rated lines). */
  taxCents: number;
  /** Margin scheme only: VAT contained in the margin (owed, never shown). */
  marginVatCents: number;
}

export interface VatBreakdownRow {
  rateBp: number;
  treatment: VatTreatmentCode;
  baseCents: number;
  taxCents: number;
}

export interface VatDecision {
  treatment: VatTreatmentCode;
  /** Rate applied to the goods (main supply). */
  rateBp: number;
  shippingRateBp: number;
  lines: VatLineResult[];
  breakdown: VatBreakdownRow[];
  netCents: number;
  taxCents: number;
  totalCents: number;
  legalTextKey: LegalTextKey | null;
  legalText: string | null;
  /** The buyer's VAT ID must be printed (intra-EU 0%). */
  buyerVatIdRequired: boolean;
  /** Staff must decide before invoicing (treatment REVIEW_REQUIRED). */
  reviewRequired: boolean;
  /** A configured rule forbids this sale as is. */
  blocked: boolean;
  reasons: string[];
}

const PCT = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** round(base × rate) for a basis-point rate, half away from zero. */
export function taxOn(baseCents: number, rateBp: number): number {
  const raw = (baseCents * rateBp) / 10000;
  return raw >= 0 ? Math.round(raw) : -Math.round(-raw);
}

/** VAT contained in a VAT-inclusive margin (margin scheme). */
export function vatInMargin(marginCents: number, rateBp: number): number {
  if (marginCents <= 0) return 0;
  return Math.round((marginCents * rateBp) / (10000 + rateBp));
}

type Main = {
  treatment: VatTreatmentCode;
  rateBp: number;
  legal: LegalTextKey | null;
  vatIdRequired: boolean;
  review: boolean;
  blocked: boolean;
};

export function determineVat(ctx: VatContext, s: TaxSettings, countries: CountryFacts): VatDecision {
  const reasons: string[] = [];
  const home = s.homeCountry.toUpperCase();
  const dest = (ctx.shipToCountry || ctx.billingCountry || '').toUpperCase() || null;
  if (!ctx.shipToCountry && ctx.billingCountry) {
    reasons.push(`No delivery country yet — decided on the billing country ${ctx.billingCountry}.`);
  }

  const main: Main = { treatment: 'REVIEW_REQUIRED', rateBp: 0, legal: null, vatIdRequired: false, review: true, blocked: false };

  if (!dest) {
    reasons.push('No delivery or billing country — VAT cannot be decided.');
  } else if (dest === home) {
    Object.assign(main, { treatment: 'DOMESTIC_STANDARD', rateBp: s.standardRateBp, review: false });
    reasons.push(`Delivery in ${home}: domestic supply at ${PCT(s.standardRateBp)}.`);
  } else if (!countries.isEu(dest)) {
    if (s.exportZeroEnabled) {
      Object.assign(main, { treatment: 'EXPORT_ZERO', rateBp: 0, legal: 'EXPORT', review: false });
      reasons.push(`Delivery to ${dest} (outside the EU): export at 0% — keep the export evidence.`);
    } else {
      Object.assign(main, { treatment: 'DOMESTIC_STANDARD', rateBp: s.standardRateBp, review: false });
      reasons.push(`Delivery to ${dest} (outside the EU) but export 0% is switched off: home rate ${PCT(s.standardRateBp)}.`);
    }
  } else {
    // Another EU member state.
    const id = ctx.vatId;
    const consumer = ctx.customerKind === 'CONSUMER';
    if (consumer && s.salesMode === 'B2B_ONLY') {
      main.blocked = true;
      reasons.push('Buyer is a consumer and sales are B2B only.');
    }
    let b2c = true;
    if (id && !consumer) {
      if (!s.icsEnabled) {
        reasons.push('Intra-EU 0% (ICS) is switched off: buyer treated like one without a VAT ID.');
      } else if (id.country === home) {
        reasons.push(`Buyer VAT ID ${id.vatId} is from ${home} (the dispatch country), not from another member state: no intra-EU 0%.`);
      } else if (!countries.isEu(id.country)) {
        reasons.push(`Buyer VAT ID ${id.vatId} is not an EU VAT ID: no intra-EU 0%.`);
      } else if (id.status === 'VALID') {
        Object.assign(main, { treatment: 'EU_ICS_ZERO', rateBp: 0, legal: 'ICS', vatIdRequired: true, review: false });
        b2c = false;
        reasons.push(`Intra-EU supply to a business with VIES-valid VAT ID ${id.vatId}${id.consultationNumber ? ` (VIES consultation ${id.consultationNumber})` : ''}: 0%.`);
        if (id.country !== dest) reasons.push(`Note: VAT ID country ${id.country} differs from delivery country ${dest} — allowed, keep transport proof.`);
      } else if (id.status === 'INVALID') {
        reasons.push(`VIES says VAT ID ${id.vatId} is NOT valid: buyer treated like one without a VAT ID.`);
      } else if (!s.icsRequireVies && id.formatValid !== false) {
        Object.assign(main, { treatment: 'EU_ICS_ZERO', rateBp: 0, legal: 'ICS', vatIdRequired: true, review: false });
        b2c = false;
        reasons.push(`VAT ID ${id.vatId} not confirmed by VIES (${id.status.toLowerCase().replace('_', ' ')}), but a VIES confirmation is not required by the settings: 0%.`);
      } else {
        b2c = false;
        const why = id.status === 'UNAVAILABLE' ? 'VIES is unavailable' : 'the VAT ID was not checked with VIES';
        if (s.viesDownPolicy === 'CHARGE_HOME_VAT') {
          Object.assign(main, { treatment: 'EU_B2C_HOME', rateBp: s.standardRateBp, review: false });
          reasons.push(`${why} for ${id.vatId}: home VAT ${PCT(s.standardRateBp)} charged (policy) — can be credited once VIES confirms the ID.`);
        } else if (s.viesDownPolicy === 'BLOCK') {
          Object.assign(main, { treatment: 'REVIEW_REQUIRED', blocked: true, review: true });
          reasons.push(`${why} for ${id.vatId}: sale blocked until VIES answers (policy).`);
        } else {
          Object.assign(main, { treatment: 'REVIEW_REQUIRED', review: true });
          reasons.push(`${why} for ${id.vatId}: VAT review required before invoicing (policy).`);
        }
      }
    }
    if (b2c) {
      if (s.euB2cMode === 'OSS') {
        const r = countries.standardRateBp(dest);
        if (r == null) {
          Object.assign(main, { treatment: 'REVIEW_REQUIRED', review: true });
          reasons.push(`OSS is on but no VAT rate is configured for ${dest}.`);
        } else {
          Object.assign(main, { treatment: 'EU_B2C_OSS', rateBp: r, legal: 'OSS', review: false });
          reasons.push(`EU buyer without a valid VAT ID, OSS: ${dest} rate ${PCT(r)}.`);
        }
      } else {
        Object.assign(main, { treatment: 'EU_B2C_HOME', rateBp: s.standardRateBp, review: false });
        reasons.push(`EU buyer without a valid VAT ID (no OSS): home rate ${PCT(s.standardRateBp)}.`);
      }
    }
  }

  // ── per line ──
  const goods = ctx.lines.filter((l) => l.lineType !== 'SHIPPING');
  const marginOn = s.marginSchemeEnabled;
  const allGoodsMargin = marginOn && goods.length > 0 && goods.every((l) => l.scheme === 'MARGIN');
  const exportish = main.treatment === 'EXPORT_ZERO';
  const shippingRateBp = main.review
    ? 0
    : s.shippingFollowsMain
      ? allGoodsMargin && !exportish
        ? s.standardRateBp // shipping of margin goods is a normal supply at the home rate
        : main.rateBp
      : s.standardRateBp;
  if (ctx.lines.some((l) => l.lineType === 'SHIPPING')) {
    reasons.push(s.shippingFollowsMain ? `Shipping follows the goods: ${PCT(shippingRateBp)}.` : `Shipping taxed separately at the home rate ${PCT(shippingRateBp)}.`);
  }
  if (marginOn && goods.some((l) => l.scheme === 'MARGIN') && !exportish && !main.review) {
    reasons.push('Margin-scheme items: VAT is included in the price and not shown separately.');
  }

  const lines: VatLineResult[] = ctx.lines.map((l, index) => {
    const isMargin = marginOn && l.scheme === 'MARGIN' && l.lineType !== 'SHIPPING' && !exportish && !main.review;
    if (isMargin) {
      const margin = l.purchaseCostCents != null ? l.netCents - l.purchaseCostCents : 0;
      if (l.purchaseCostCents == null) reasons.push('A margin-scheme item has no purchase cost recorded — margin VAT cannot be computed.');
      return { index, lineType: l.lineType, treatment: 'MARGIN_SCHEME', rateBp: 0, netCents: l.netCents, taxCents: 0, marginVatCents: vatInMargin(margin, s.standardRateBp) };
    }
    const rateBp = main.review ? 0 : l.lineType === 'SHIPPING' ? shippingRateBp : main.rateBp;
    return { index, lineType: l.lineType, treatment: main.treatment, rateBp, netCents: l.netCents, taxCents: 0, marginVatCents: 0 };
  });

  // Tax per (treatment, rate) group, allocated back to lines.
  const groups = new Map<string, VatLineResult[]>();
  for (const l of lines) {
    const k = `${l.treatment}|${l.rateBp}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const breakdown: VatBreakdownRow[] = [];
  for (const [, ls] of groups) {
    const rateBp = ls[0].rateBp;
    const baseCents = ls.reduce((s2, l) => s2 + l.netCents, 0);
    const taxCents = ls[0].treatment === 'MARGIN_SCHEME' ? 0 : taxOn(baseCents, rateBp);
    if (ls[0].treatment === 'MARGIN_SCHEME') {
      for (const l of ls) l.taxCents = 0;
    } else {
      // Largest-remainder allocation: every line gets its exact share rounded
      // down, the cents left go to the lines with the biggest fractions — so
      // each line's VAT stays proportional to its amount (5 lines of €0.02 at
      // 21% → 0.01, 0.01, 0, 0, 0 — never 0.02 on one line) and the lines add
      // up to the group's tax.
      const exact = ls.map((l) => (l.netCents * rateBp) / 10000);
      const floors = exact.map((x) => Math.floor(x + 1e-9));
      let left = taxCents - floors.reduce((a, b) => a + b, 0);
      const order = exact.map((x, i) => ({ i, frac: x - floors[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
      ls.forEach((l, i) => (l.taxCents = floors[i]));
      for (let k = 0; left > 0 && k < order.length * 2; k++, left--) ls[order[k % order.length].i].taxCents += 1;
      for (let k = 0; left < 0 && k < order.length * 2; k++, left++) ls[order[order.length - 1 - (k % order.length)].i].taxCents -= 1;
    }
    breakdown.push({ rateBp, treatment: ls[0].treatment, baseCents, taxCents });
  }
  breakdown.sort((a, b) => b.rateBp - a.rateBp);

  let treatment = main.treatment;
  if (allGoodsMargin && !exportish && !main.review) treatment = 'MARGIN_SCHEME';
  const legalTextKey: LegalTextKey | null = treatment === 'MARGIN_SCHEME' ? 'MARGIN' : main.legal;
  const legalParts: string[] = [];
  if (legalTextKey) legalParts.push(s.legalTexts[legalTextKey]);
  if (treatment !== 'MARGIN_SCHEME' && lines.some((l) => l.treatment === 'MARGIN_SCHEME')) legalParts.push(s.legalTexts.MARGIN);
  const legalText = legalParts.map((t) => t.trim()).filter(Boolean).join('\n') || null;

  const netCents = lines.reduce((a, l) => a + l.netCents, 0);
  const taxCents = lines.reduce((a, l) => a + l.taxCents, 0);
  return {
    treatment,
    rateBp: main.review ? 0 : treatment === 'MARGIN_SCHEME' ? 0 : main.rateBp,
    shippingRateBp,
    lines,
    breakdown,
    netCents,
    taxCents,
    totalCents: netCents + taxCents,
    legalTextKey,
    legalText,
    buyerVatIdRequired: main.vatIdRequired,
    reviewRequired: main.review,
    blocked: main.blocked,
    reasons,
  };
}

/** "Domestic (standard rate) 21%" / "Export outside the EU, 0%" — the rate only when the label does not state it. */
export function vatTreatmentWithRate(t: VatTreatmentCode | string | null | undefined, rateBp: number | null | undefined): string {
  const label = vatTreatmentLabel(t);
  if (rateBp == null || /%/.test(label)) return label;
  return `${label} ${(rateBp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** Human label of a treatment (documents, admin UI). */
export function vatTreatmentLabel(t: VatTreatmentCode | string | null | undefined): string {
  switch (t) {
    case 'DOMESTIC_STANDARD': return 'Domestic (standard rate)';
    case 'EU_ICS_ZERO': return 'Intra-EU supply, 0% (reverse charge)';
    case 'EU_B2C_HOME': return 'EU buyer without VAT ID (home rate)';
    case 'EU_B2C_OSS': return 'EU buyer, OSS (destination rate)';
    case 'EXPORT_ZERO': return 'Export outside the EU, 0%';
    case 'MARGIN_SCHEME': return 'Margin scheme (second-hand goods)';
    case 'REVIEW_REQUIRED': return 'VAT review required';
    case 'LEGACY_UNSPECIFIED': return 'Not determined yet (interim flat-rate pricing)';
    default: return 'Not determined';
  }
}
