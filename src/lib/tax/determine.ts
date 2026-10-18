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
 *      · VIES name is another company than the buyer's legal name → REVIEW_REQUIRED
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
 *
 * Two text sets: `reasons` are for staff (vatNote, admin panels, alerts);
 * `buyerReasons` / `buyerLabel` are what a customer may read — no internal
 * wording ("keep the export evidence", "policy"). Use buyerVatExplanation(),
 * buyerVatLabel() and vatRowTitle() for anything a buyer sees.
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
  /** For staff. */
  reasons: string[];
  /** For the buyer (absent on decisions rebuilt from a recorded order). */
  buyerReasons?: string[];
  /** Buyer-facing name of the treatment (absent → buyerTreatmentLabel). */
  buyerLabel?: string;
  /** Why staff must decide (reviewRequired only): picks the buyer's next step. */
  reviewCause?: VatReviewCause | null;
}

/**
 * What a review decision waits for. NO_COUNTRY: no delivery / billing country;
 * VIES_UNAVAILABLE: VIES did not answer (retrying can help); VAT_ID_NOT_CHECKED:
 * the VAT ID was not checked (VIES checks off); VAT_ID_NAME_MISMATCH: VIES
 * registers the VAT ID to another company (retrying never helps);
 * NO_DESTINATION_RATE: OSS without a rate for the destination.
 */
export type VatReviewCause = 'NO_COUNTRY' | 'VIES_UNAVAILABLE' | 'VAT_ID_NOT_CHECKED' | 'VAT_ID_NAME_MISMATCH' | 'NO_DESTINATION_RATE';

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
  // Buyer-facing text: why a VAT ID did not give 0% (notes), then the outcome.
  const buyerNotes: string[] = [];
  let buyerMain = '';
  let buyerLabel: string | null = null;
  let buyerBlock: string | null = null;
  let reviewCause: VatReviewCause = 'NO_COUNTRY';
  const home = s.homeCountry.toUpperCase();
  const dest = (ctx.shipToCountry || ctx.billingCountry || '').toUpperCase() || null;
  if (!ctx.shipToCountry && ctx.billingCountry) {
    reasons.push(`No delivery country yet — decided on the billing country ${ctx.billingCountry}.`);
  }

  const main: Main = { treatment: 'REVIEW_REQUIRED', rateBp: 0, legal: null, vatIdRequired: false, review: true, blocked: false };

  if (!dest) {
    reasons.push('No delivery or billing country — VAT cannot be decided.');
    buyerMain = 'We need your delivery country to determine the VAT.';
  } else if (dest === home) {
    Object.assign(main, { treatment: 'DOMESTIC_STANDARD', rateBp: s.standardRateBp, review: false });
    reasons.push(`Delivery in ${home}: domestic supply at ${PCT(s.standardRateBp)}.`);
    buyerMain = `Delivery in ${home}: VAT ${PCT(s.standardRateBp)}.`;
  } else if (!countries.isEu(dest)) {
    if (s.exportZeroEnabled) {
      Object.assign(main, { treatment: 'EXPORT_ZERO', rateBp: 0, legal: 'EXPORT', review: false });
      reasons.push(`Delivery to ${dest} (outside the EU): export at 0% — keep the export evidence.`);
      buyerMain = `Delivery to ${dest}, outside the EU: export at 0% VAT.`;
    } else {
      Object.assign(main, { treatment: 'DOMESTIC_STANDARD', rateBp: s.standardRateBp, review: false });
      reasons.push(`Delivery to ${dest} (outside the EU) but export 0% is switched off: home rate ${PCT(s.standardRateBp)}.`);
      buyerMain = `Delivery to ${dest}, outside the EU: VAT ${PCT(s.standardRateBp)}.`;
    }
  } else {
    // Another EU member state.
    const id = ctx.vatId;
    const consumer = ctx.customerKind === 'CONSUMER';
    if (consumer && s.salesMode === 'B2B_ONLY') {
      main.blocked = true;
      reasons.push('Buyer is a consumer and sales are B2B only.');
      buyerBlock = 'We sell to businesses only: enter your company details and EU VAT ID to order.';
    }
    let b2c = true;
    let idInvalid = false;
    if (id && !consumer) {
      if (!s.icsEnabled) {
        reasons.push('Intra-EU 0% (ICS) is switched off: buyer treated like one without a VAT ID.');
      } else if (id.country === home) {
        reasons.push(`Buyer VAT ID ${id.vatId} is from ${home} (the dispatch country), not from another member state: no intra-EU 0%.`);
        buyerNotes.push(`A VAT ID from ${home} does not give the intra-EU 0% rate, because we ship from ${home}.`);
      } else if (!countries.isEu(id.country)) {
        reasons.push(`Buyer VAT ID ${id.vatId} is not an EU VAT ID: no intra-EU 0%.`);
        buyerNotes.push(`${id.vatId} is not an EU VAT ID, so the intra-EU 0% rate does not apply.`);
      } else if (id.status === 'VALID') {
        b2c = false;
        const legal = ctx.buyerLegalName?.trim() || null;
        const names = legal && id.name ? compareCompanyNames(legal, id.name) : 'UNKNOWN';
        if (names === 'MISMATCH') {
          // A valid VAT ID of ANOTHER company gives no right to 0%: staff check first.
          Object.assign(main, { treatment: 'REVIEW_REQUIRED', review: true });
          reasons.push(`VAT ID belongs to ${id.name}: VIES registers ${id.vatId} to “${id.name}”, not to the billing name “${legal}” — VAT review required before 0% (confirm the buyer may use this VAT ID, or ask for the right one).`);
          reviewCause = 'VAT_ID_NAME_MISMATCH';
          buyerMain = `The EU VIES register lists VAT ID ${id.vatId} for “${id.name}”, not for “${legal}”, so it can not give the intra-EU 0% rate without a check.`;
        } else {
          Object.assign(main, { treatment: 'EU_ICS_ZERO', rateBp: 0, legal: 'ICS', vatIdRequired: true, review: false });
          reasons.push(`Intra-EU supply to a business with VIES-valid VAT ID ${id.vatId}${id.consultationNumber ? ` (VIES consultation ${id.consultationNumber})` : ''}: 0%.`);
          if (legal && id.name && names === 'UNKNOWN') reasons.push(`VIES name “${id.name}” could not be compared with the billing name “${legal}” — check that it is the same company.`);
          if (id.country !== dest) reasons.push(`Note: VAT ID country ${id.country} differs from delivery country ${dest} — allowed, keep transport proof.`);
          buyerMain = `Intra-EU supply to a business with VAT ID ${id.vatId}, confirmed in the EU VIES register: 0% VAT (reverse charge).`;
        }
      } else if (id.status === 'INVALID') {
        idInvalid = true;
        reasons.push(`VIES says VAT ID ${id.vatId} is NOT valid: buyer treated like one without a VAT ID.`);
        buyerNotes.push(`The EU VIES register says VAT ID ${id.vatId} is not valid, so the intra-EU 0% rate does not apply.`);
      } else if (!s.icsRequireVies && id.formatValid !== false) {
        Object.assign(main, { treatment: 'EU_ICS_ZERO', rateBp: 0, legal: 'ICS', vatIdRequired: true, review: false });
        b2c = false;
        reasons.push(`VAT ID ${id.vatId} not confirmed by VIES (${id.status.toLowerCase().replace('_', ' ')}), but a VIES confirmation is not required by the settings: 0%.`);
        buyerMain = `Intra-EU supply to a business with VAT ID ${id.vatId}: 0% VAT (reverse charge).`;
      } else {
        b2c = false;
        const why = id.status === 'UNAVAILABLE' ? 'VIES is unavailable' : 'the VAT ID was not checked with VIES';
        const buyerWhy = id.status === 'UNAVAILABLE'
          ? `We could not check your VAT ID ${id.vatId} with the EU VIES service right now`
          : `Your VAT ID ${id.vatId} is not confirmed yet`;
        reviewCause = id.status === 'UNAVAILABLE' ? 'VIES_UNAVAILABLE' : 'VAT_ID_NOT_CHECKED';
        if (s.viesDownPolicy === 'CHARGE_HOME_VAT') {
          Object.assign(main, { treatment: 'EU_B2C_HOME', rateBp: s.standardRateBp, review: false });
          reasons.push(`${why} for ${id.vatId}: home VAT ${PCT(s.standardRateBp)} charged (policy) — can be credited once VIES confirms the ID.`);
          buyerMain = `${buyerWhy}, so VAT ${PCT(s.standardRateBp)} is charged; it is credited once your VAT ID is confirmed.`;
          buyerLabel = 'Home VAT (VAT ID not yet confirmed — credited later)';
        } else if (s.viesDownPolicy === 'BLOCK') {
          Object.assign(main, { treatment: 'REVIEW_REQUIRED', blocked: true, review: true });
          reasons.push(`${why} for ${id.vatId}: sale blocked until VIES answers (policy).`);
          buyerMain = `${buyerWhy}, so it can not be used for an order yet.${id.status === 'UNAVAILABLE' ? ' Please try again later.' : ''}`;
        } else {
          Object.assign(main, { treatment: 'REVIEW_REQUIRED', review: true });
          reasons.push(`${why} for ${id.vatId}: VAT review required before invoicing (policy).`);
          buyerMain = `${buyerWhy}.`;
        }
      }
    }
    if (b2c) {
      const without = id ? '' : ' without an EU VAT ID';
      if (s.euB2cMode === 'OSS') {
        const r = countries.standardRateBp(dest);
        if (r == null) {
          Object.assign(main, { treatment: 'REVIEW_REQUIRED', review: true });
          reasons.push(`OSS is on but no VAT rate is configured for ${dest}.`);
          reviewCause = 'NO_DESTINATION_RATE';
          buyerMain = `The VAT rate for delivery to ${dest} has to be confirmed by our team.`;
        } else {
          Object.assign(main, { treatment: 'EU_B2C_OSS', rateBp: r, legal: 'OSS', review: false });
          reasons.push(`EU buyer without a valid VAT ID, OSS: ${dest} rate ${PCT(r)}.`);
          buyerMain = `Delivery to ${dest}${without}: ${dest} VAT ${PCT(r)} (EU One-Stop-Shop).`;
        }
      } else {
        Object.assign(main, { treatment: 'EU_B2C_HOME', rateBp: s.standardRateBp, review: false });
        reasons.push(`EU buyer without a valid VAT ID (no OSS): home rate ${PCT(s.standardRateBp)}.`);
        buyerMain = `Delivery to ${dest}${without}: VAT ${PCT(s.standardRateBp)}.`;
        buyerLabel = id ? (idInvalid ? 'Standard rate (VAT ID not valid in VIES)' : 'Standard rate') : 'Standard rate (no EU VAT ID)';
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

  // ── what the buyer reads ──
  const hasShipping = ctx.lines.some((l) => l.lineType === 'SHIPPING');
  let buyerReasons: string[];
  if (buyerBlock) {
    buyerReasons = [buyerBlock];
  } else if (treatment === 'MARGIN_SCHEME') {
    // Only the margin-scheme explanation: VAT ID or destination do not change it.
    buyerReasons = [`Margin scheme for second-hand goods: the VAT is included in the price and not shown separately${hasShipping && shippingRateBp > 0 ? `; VAT ${PCT(shippingRateBp)} is charged on the freight only` : ''}.`];
  } else {
    buyerReasons = [...buyerNotes, buyerMain];
    if (lines.some((l) => l.treatment === 'MARGIN_SCHEME')) buyerReasons.push('Items under the margin scheme: the VAT is included in their price and not shown separately.');
    if (hasShipping && !main.review && shippingRateBp !== main.rateBp) buyerReasons.push(`Freight: VAT ${PCT(shippingRateBp)}.`);
  }
  const finalBuyerLabel = main.review
    ? 'VAT to be confirmed'
    : treatment === 'MARGIN_SCHEME'
      ? buyerTreatmentLabel('MARGIN_SCHEME')
      : buyerLabel ?? buyerTreatmentLabel(treatment);

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
    buyerReasons: buyerReasons.filter(Boolean),
    buyerLabel: finalBuyerLabel,
    reviewCause: main.review ? reviewCause : null,
  };
}

// ── Buyer-facing texts ──

/** Name of a treatment for a customer (no internal wording); see also buyerVatLabel(). */
export function buyerTreatmentLabel(t: VatTreatmentCode | string | null | undefined): string {
  switch (t) {
    case 'DOMESTIC_STANDARD': return 'Standard rate';
    case 'EU_ICS_ZERO': return 'Intra-EU supply, 0% (reverse charge)';
    case 'EU_B2C_HOME': return 'Standard rate';
    case 'EU_B2C_OSS': return 'VAT of the destination country (EU OSS)';
    case 'EXPORT_ZERO': return 'Export outside the EU, 0%';
    case 'MARGIN_SCHEME': return 'Margin scheme — VAT included in the price';
    case 'REVIEW_REQUIRED': return 'VAT to be confirmed';
    default: return 'VAT';
  }
}

/** The treatment label a buyer sees ("Home VAT (VAT ID not yet confirmed — credited later)"). */
export function buyerVatLabel(d: Pick<VatDecision, 'treatment' | 'buyerLabel'>): string {
  return d.buyerLabel ?? buyerTreatmentLabel(d.treatment);
}

/** The explanation a buyer sees — never the staff `reasons`. */
export function buyerVatExplanation(d: Pick<VatDecision, 'treatment' | 'buyerReasons' | 'buyerLabel'>): string {
  return (d.buyerReasons?.length ? d.buyerReasons : [`${buyerVatLabel(d)}.`]).join(' ');
}

/**
 * Title of the VAT row next to the amount: "VAT 21%", "VAT 0%", or "VAT 21% on
 * freight" when only the freight is taxed (margin-scheme goods; export with
 * freight at the home rate) — never "VAT 0%" next to a non-zero amount, nor
 * for VAT that is still to be confirmed.
 */
export function vatRowTitle(d: Pick<VatDecision, 'lines' | 'rateBp' | 'treatment' | 'reviewRequired'>): string {
  if (d.reviewRequired) return 'VAT';
  const taxed = d.lines.filter((l) => l.taxCents !== 0);
  if (!taxed.length) return d.treatment === 'MARGIN_SCHEME' ? 'VAT' : `VAT ${PCT(d.rateBp)}`;
  const rates = [...new Set(taxed.map((l) => l.rateBp))];
  if (rates.length > 1) return 'VAT';
  return `VAT ${PCT(rates[0])}${taxed.every((l) => l.lineType === 'SHIPPING') ? ' on freight' : ''}`;
}

/** What an offer / order stores about its VAT (enough to show the buyer the same row again). */
export interface StoredVat {
  treatment: VatTreatmentCode | string | null | undefined;
  /** Goods rate (offerVatRateBp / Order.vatRateBp). */
  rateBp: number | null | undefined;
  /** Freight rate (offerTerms.vatBasis.shippingRateBp / Order.shippingVatRateBp); null = not recorded. */
  shippingRateBp?: number | null;
  shippingCents?: number | null;
  taxCents: number | null | undefined;
  /** buyerVatLabel() recorded with the decision; else rebuilt from the treatment. */
  buyerLabel?: string | null;
  /** The buyer gave a VAT ID (only used when no label was recorded). */
  hasVatId?: boolean;
}

/**
 * The buyer's VAT row rebuilt from stored fields: the same title as
 * vatRowTitle() ("VAT 21% on freight" when only the freight is taxed; plain
 * "VAT" when a rate is not recorded — never "VAT 0%" next to an amount) and
 * the buyer label (recorded, else buyerTreatmentLabel()).
 */
export function buyerVatRow(s: StoredVat): { title: string; label: string } {
  const label = s.buyerLabel
    || (s.treatment === 'EU_B2C_HOME' && s.hasVatId === false ? 'Standard rate (no EU VAT ID)' : buyerTreatmentLabel(s.treatment));
  if (s.treatment === 'REVIEW_REQUIRED') return { title: 'VAT', label };
  const margin = s.treatment === 'MARGIN_SCHEME';
  const goodsBp = margin ? 0 : s.rateBp ?? null;
  const freightBp = (s.shippingCents ?? 0) > 0 ? s.shippingRateBp ?? null : null;
  if (!s.taxCents) return { title: margin || goodsBp == null ? 'VAT' : `VAT ${PCT(goodsBp)}`, label };
  if (goodsBp == null) return { title: 'VAT', label };
  if (goodsBp === 0) return { title: freightBp ? `VAT ${PCT(freightBp)} on freight` : 'VAT', label };
  if (freightBp && freightBp !== goodsBp) return { title: 'VAT', label };
  return { title: `VAT ${PCT(goodsBp)}`, label };
}

/** The buyer texts recorded on an order at its VAT decision (Order.pricingSnapshot.buyerVat). */
export interface RecordedBuyerVat {
  treatment: string;
  /** Order.vatDecidedAt of that decision (ISO): a later re-decision makes the texts stale. */
  decidedAt: string;
  label: string;
  title: string;
}

/**
 * The buyer's VAT row of an order (order page, payment page, quote card). The
 * label recorded at the decision is used only while that decision stands
 * (same treatment and vatDecidedAt — staff re-deciding the VAT makes it stale);
 * otherwise the row is rebuilt from the order's fields.
 */
export function orderBuyerVatRow(o: {
  vatTreatment?: string | null;
  vatRateBp?: number | null;
  shippingVatRateBp?: number | null;
  shippingCents?: number | null;
  taxCents?: number | null;
  buyerVatId?: string | null;
  vatDecidedAt?: Date | string | null;
  pricingSnapshot?: unknown;
}): { title: string; label: string } {
  const snap = o.pricingSnapshot && typeof o.pricingSnapshot === 'object' ? (o.pricingSnapshot as { buyerVat?: Partial<RecordedBuyerVat> }).buyerVat : undefined;
  const decidedAt = o.vatDecidedAt ? new Date(o.vatDecidedAt).toISOString() : null;
  const recorded = snap && typeof snap.label === 'string' && snap.treatment === o.vatTreatment && !!decidedAt && snap.decidedAt === decidedAt ? snap.label : null;
  return buyerVatRow({
    treatment: o.vatTreatment,
    rateBp: o.vatRateBp,
    shippingRateBp: o.shippingVatRateBp,
    shippingCents: o.shippingCents,
    taxCents: o.taxCents,
    buyerLabel: recorded,
    hasVatId: !!o.buyerVatId,
  });
}

// ── VIES name vs the buyer's legal name ──

/** Legal-form (and holding / group) tokens dropped before comparing names (B.V., NV, GmbH, Ltd, …; dots removed first). */
const LEGAL_FORMS = new Set([
  'BV', 'NV', 'VOF', 'CV', 'BVBA', 'SPRL', 'SRL', 'SA', 'SAS', 'SASU', 'SARL', 'SNC', 'SCS', 'SCA', 'SCRL', 'EURL', 'EIRL',
  'GMBH', 'MBH', 'AG', 'KG', 'KGAA', 'OHG', 'UG', 'EV', 'GBR', 'EG', 'SE', 'LTD', 'LIMITED', 'PLC', 'LLP', 'LLC', 'INC', 'CORP',
  'CORPORATION', 'CO', 'COMPANY', 'SPA', 'SAPA', 'SL', 'SLU', 'LDA', 'AB', 'HB', 'AS', 'ASA', 'APS', 'OY', 'OYJ', 'SP', 'ZOO', 'OO',
  'SRO', 'KFT', 'ZRT', 'NYRT', 'DOO', 'DD', 'EOOD', 'OOD', 'AD', 'UAB', 'SIA', 'OU', 'AE', 'EPE', 'IKE', 'OE', 'EE',
  'STICHTING', 'VERENIGING', 'VZW', 'ASBL', 'HOLDING', 'HOLDINGS', 'GROUP',
]);
/** Words that say nothing about which company it is. */
const NAME_STOPWORDS = new Set(['THE', 'AND', 'OF', 'FOR', 'DE', 'DER', 'DIE', 'DAS', 'DEN', 'DES', 'VAN', 'VON', 'HET', 'EN', 'UND', 'ET', 'LA', 'LE', 'LES', 'DU', 'DI', 'DEL', 'DELLA', 'ZU', 'ZUR', 'FUR', 'FUER', 'VOOR', 'TE', 'TER', 'AM', 'IM', 'IN', 'OP']);
/** Common in lab company names: compared only when a name has nothing more specific. */
const GENERIC_NAME_WORDS = new Set([
  'LAB', 'LABS', 'LABO', 'LABORATORY', 'LABORATORIES', 'LABORATORIUM', 'LABORATOIRE', 'LABORATORIO', 'RESEARCH', 'SCIENCE', 'SCIENCES',
  'SCIENTIFIC', 'INSTITUTE', 'INSTITUUT', 'INSTITUT', 'INSTITUTO', 'ISTITUTO', 'UNIVERSITY', 'UNIVERSITEIT', 'UNIVERSITAT', 'UNIVERSITE',
  'UNIVERSIDAD', 'UNIVERSITA', 'CENTER', 'CENTRE', 'CENTRUM', 'ZENTRUM', 'TECHNOLOGY', 'TECHNOLOGIES', 'TECH', 'SOLUTIONS', 'SERVICES',
  'SERVICE', 'SYSTEMS', 'TRADING', 'HANDEL', 'MEDICAL', 'PHARMA', 'BIO', 'CHEMICALS', 'INSTRUMENTS', 'EQUIPMENT', 'ANALYTICAL',
  'DIAGNOSTICS', 'INTERNATIONAL', 'EUROPE', 'EUROPA',
]);

/** "N.V. Anheuser-Busch InBev" → ["ANHEUSER", "BUSCH", "INBEV"]: no accents, case, punctuation or legal forms. */
export function companyNameTokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/['’.]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !LEGAL_FORMS.has(t) && !NAME_STOPWORDS.has(t));
}

/**
 * Is the company VIES registers for a VAT ID the buyer's company? MATCH when
 * the normalised names contain one another or share a distinctive word;
 * MISMATCH when they share none; UNKNOWN when one side is empty or in another
 * script (a Greek / Cyrillic VIES name) — no conclusion either way.
 */
export function compareCompanyNames(a: string, b: string): 'MATCH' | 'MISMATCH' | 'UNKNOWN' {
  const ta = companyNameTokens(a);
  const tb = companyNameTokens(b);
  if (!ta.length || !tb.length) return 'UNKNOWN';
  const latin = (ts: string[]) => ts.some((t) => /[A-Z]/.test(t));
  if (latin(ta) !== latin(tb)) return 'UNKNOWN';
  const ca = ta.join('');
  const cb = tb.join('');
  if (ca === cb || (Math.min(ca.length, cb.length) >= 4 && (ca.includes(cb) || cb.includes(ca)))) return 'MATCH';
  const distinctive = (ts: string[]) => {
    const d = ts.filter((t) => !GENERIC_NAME_WORDS.has(t));
    return d.length ? d : ts;
  };
  const da = distinctive(ta);
  const db = distinctive(tb);
  const same = (x: string, y: string) => x === y || (x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x)));
  return da.some((x) => db.some((y) => same(x, y))) ? 'MATCH' : 'MISMATCH';
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
