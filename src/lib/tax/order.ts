import type { Prisma } from '@prisma/client';
import { determineVat, taxOn, type VatContext, type VatDecision, type VatLineInput, type VatTreatmentCode, type TaxSettings, type CountryFacts } from './determine';
import { parseVatId } from './vatid';
import { checkVatId, type VatIdCheckResult } from './vies';
import { loadCountryFacts, loadTaxSettings } from './settings';

/**
 * VAT of an EXISTING order, for documents (lib/documents/issue.ts).
 *
 *  - RECORDED: the order was priced by the VAT engine (vatTreatment + vatRateBp
 *    set at checkout/acceptance) — the document uses exactly that.
 *  - Otherwise the order was priced by the interim flat rate: the engine
 *    decides what the rules require from the order's addresses + VAT ID, and
 *    the result is compared with the tax actually charged:
 *      MATCH        → same amount: the document carries the engine's treatment
 *                     and legal text;
 *      MISMATCH     → the order was charged a different amount than the rules
 *                     require (e.g. an NL buyer at 0%);
 *      UNDETERMINED → not enough data (no country) or the rules need a person
 *                     (VIES down under the review policy).
 */

type Addr = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function addressObject(raw: unknown): Addr | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Addr;
  return ((o.address as Addr) && typeof o.address === 'object' ? (o.address as Addr) : o) as Addr;
}

export function addressCountry(raw: unknown): string | null {
  const a = addressObject(raw);
  const c = a ? str(a.country) : null;
  return c && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : null;
}

export function addressVatId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Addr;
  return str(o.vat) ?? str(o.vatId) ?? str(o.vat_id);
}

export type OrderForVat = {
  vatTreatment: VatTreatmentCode | null;
  vatRateBp: number | null;
  buyerVatId: string | null;
  shippingAddress: Prisma.JsonValue | null;
  billingAddress: Prisma.JsonValue | null;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  /** 7a: VAT rate of the shipping charge as priced at checkout (null = the order rate). */
  shippingVatRateBp?: number | null;
  items: Array<{
    priceCentsSnapshot: number;
    quantity: number;
    lineType?: string | null;
    vatRateBp?: number | null;
    /** 7a: VAT of the line as priced at checkout. */
    taxCents?: number | null;
    product?: { vatScheme: 'STANDARD' | 'MARGIN'; purchaseCostCents?: number | null } | null;
  }>;
};

export interface OrderVatResolution {
  status: 'RECORDED' | 'MATCH' | 'MISMATCH' | 'UNDETERMINED';
  decision: VatDecision;
  chargedTaxCents: number;
  expectedTaxCents: number | null;
  vatId: VatIdCheckResult | null;
  context: VatContext;
  /** One sentence for staff (admin message / hold note). */
  message: string;
}

export function orderVatLines(order: OrderForVat): VatLineInput[] {
  const lines: VatLineInput[] = order.items.map((i) => ({
    netCents: i.priceCentsSnapshot * i.quantity,
    lineType: (i.lineType === 'SHIPPING' || i.lineType === 'SERVICE' || i.lineType === 'DISCOUNT' ? i.lineType : 'GOODS') as VatLineInput['lineType'],
    scheme: i.product?.vatScheme === 'MARGIN' ? 'MARGIN' : 'STANDARD',
    // Margin VAT (internal, never printed) is computed from what the unit cost.
    purchaseCostCents: i.product?.purchaseCostCents != null ? i.product.purchaseCostCents * i.quantity : null,
  }));
  if (order.shippingCents > 0 && !lines.some((l) => l.lineType === 'SHIPPING')) {
    lines.push({ netCents: order.shippingCents, lineType: 'SHIPPING' });
  }
  return lines;
}

/**
 * Build the decision for an order already priced by the engine (recorded fields).
 * The amounts charged are authoritative: when the checkout recorded the VAT per
 * line (OrderItem.vatRateBp/taxCents) and the shipping rate, the document
 * reproduces exactly those rates and amounts (one VAT row per rate, the rows
 * adding up to the charged tax). Older engine-priced orders without per-line
 * data keep the single-row form.
 */
export function decisionFromRecorded(order: OrderForVat, s: TaxSettings): VatDecision {
  const t = order.vatTreatment as VatTreatmentCode;
  const rate = order.vatRateBp ?? 0;
  const shipRate = order.shippingVatRateBp ?? rate;
  const perLine = order.items.length > 0 && order.items.every((i) => i.vatRateBp != null && i.taxCents != null);
  const lines = orderVatLines(order).map((l, index) => {
    const item = index < order.items.length ? order.items[index] : null;
    const r = perLine && item ? (item.vatRateBp as number) : l.lineType === 'SHIPPING' ? shipRate : rate;
    const tax = perLine && item ? (item.taxCents as number) : taxOn(l.netCents, r);
    return { index, lineType: l.lineType, treatment: t, rateBp: r, netCents: l.netCents, taxCents: tax, marginVatCents: 0 };
  });
  if (perLine) {
    // The shipping charge carries the rest of the charged tax (no rounding drift).
    const itemTax = order.items.reduce((a, i) => a + (i.taxCents as number), 0);
    const ship = lines.find((l, i) => i >= order.items.length && l.lineType === 'SHIPPING');
    if (ship) ship.taxCents = order.taxCents - itemTax;
  }
  const base = lines.reduce((a, l) => a + l.netCents, 0);
  const legalKey = t === 'EU_ICS_ZERO' ? 'ICS' : t === 'EXPORT_ZERO' ? 'EXPORT' : t === 'MARGIN_SCHEME' ? 'MARGIN' : t === 'EU_B2C_OSS' ? 'OSS' : null;
  const rows = new Map<number, { baseCents: number; taxCents: number }>();
  for (const l of lines) {
    const r = rows.get(l.rateBp) ?? { baseCents: 0, taxCents: 0 };
    r.baseCents += l.netCents;
    r.taxCents += l.taxCents;
    rows.set(l.rateBp, r);
  }
  const multiRate = perLine || shipRate !== rate;
  return {
    treatment: t,
    rateBp: rate,
    shippingRateBp: shipRate,
    lines,
    // The charged tax is authoritative for an engine-priced order.
    breakdown: multiRate
      ? [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([rateBp, r]) => ({ rateBp, treatment: t, baseCents: r.baseCents, taxCents: r.taxCents }))
      : [{ rateBp: rate, treatment: t, baseCents: base, taxCents: order.taxCents }],
    netCents: base,
    taxCents: order.taxCents,
    totalCents: base + order.taxCents,
    legalTextKey: legalKey,
    legalText: legalKey ? s.legalTexts[legalKey] : null,
    buyerVatIdRequired: t === 'EU_ICS_ZERO',
    reviewRequired: t === 'REVIEW_REQUIRED',
    blocked: false,
    reasons: ['VAT decided when the order was priced.'],
  };
}

export async function resolveOrderVat(
  order: OrderForVat,
  deps: { settings?: TaxSettings; countries?: CountryFacts; skipVies?: boolean; ignoreRecorded?: boolean } = {},
): Promise<OrderVatResolution> {
  const s = deps.settings ?? (await loadTaxSettings());
  const countries = deps.countries ?? (await loadCountryFacts());
  const shipTo = addressCountry(order.shippingAddress);
  const billing = addressCountry(order.billingAddress) ?? shipTo;
  const rawVatId = order.buyerVatId ?? addressVatId(order.billingAddress) ?? addressVatId(order.shippingAddress);
  const company = (() => {
    for (const a of [order.billingAddress, order.shippingAddress]) {
      if (a && typeof a === 'object' && str((a as Addr).company)) return true;
    }
    return false;
  })();

  let vatId: VatIdCheckResult | null = null;
  if (rawVatId) {
    if (deps.skipVies) {
      const p = parseVatId(rawVatId);
      vatId = p ? { vatId: p.vatId, country: p.country, status: 'NOT_CHECKED', source: 'DISABLED', validationId: null } : null;
    } else {
      vatId = await checkVatId(rawVatId);
    }
  }
  const context: VatContext = {
    shipToCountry: shipTo,
    billingCountry: billing,
    customerKind: rawVatId || company ? 'BUSINESS' : 'UNKNOWN',
    vatId: vatId && vatId.country ? vatId : null,
    // The billing company is compared with the name VIES returns (another company's VAT ID → review).
    buyerLegalName: order.billingAddress && typeof order.billingAddress === 'object' ? str((order.billingAddress as Addr).company) : null,
    lines: orderVatLines(order),
  };

  // ignoreRecorded: staff re-decide the VAT of a paid order on review (the rules
  // for the order's current details, compared with what was charged).
  if (!deps.ignoreRecorded && order.vatTreatment && order.vatTreatment !== 'LEGACY_UNSPECIFIED' && order.vatTreatment !== 'REVIEW_REQUIRED' && order.vatRateBp != null) {
    const decision = decisionFromRecorded(order, s);
    return {
      status: 'RECORDED', decision, chargedTaxCents: order.taxCents, expectedTaxCents: order.taxCents, vatId, context,
      message: `VAT recorded on the order: ${decision.treatment} at ${(decision.rateBp / 100).toString()}%.`,
    };
  }

  const decision = determineVat(context, s, countries);
  if (decision.reviewRequired || decision.blocked) {
    return {
      status: 'UNDETERMINED', decision, chargedTaxCents: order.taxCents, expectedTaxCents: null, vatId, context,
      message: decision.reasons.join(' '),
    };
  }
  if (decision.taxCents === order.taxCents) {
    return {
      status: 'MATCH', decision, chargedTaxCents: order.taxCents, expectedTaxCents: decision.taxCents, vatId, context,
      message: decision.reasons.join(' '),
    };
  }
  const fmt = (c: number) => (c / 100).toFixed(2);
  return {
    status: 'MISMATCH', decision, chargedTaxCents: order.taxCents, expectedTaxCents: decision.taxCents, vatId, context,
    message: `The order was charged VAT ${fmt(order.taxCents)} but the VAT rules require ${fmt(decision.taxCents)} (${decision.reasons.join(' ')})`,
  };
}
