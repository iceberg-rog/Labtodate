/**
 * Checkout pricing — PURE assembly of the four rule engines into one priced
 * order (no I/O; unit tests: engine.test.ts):
 *
 *   lines     sell prices from lib/pricing/resolve.ts (markup applied, never
 *             the supplier price; FORCE_QUOTE / HIDE_PRICE never buyable)
 *   country   lib/compliance/country.ts  ALLOW | REVIEW (hold) | BLOCK (refused)
 *   shipping  lib/shipping/quote.ts      QUOTED | TO_BE_CONFIRMED (hold) | NOT_SHIPPABLE (refused)
 *   VAT       lib/tax/determine.ts       treatment + per-line tax; review (hold) | blocked (refused)
 *
 * The result is what the buyer sees AND what the order stores: the same
 * numbers feed the summary, the Order row, the OrderItem snapshot, the Stripe
 * line items and (through the recorded VAT) the proforma and invoice.
 * A hold never means a silent €0: the order is accepted, the open item is
 * named, and no payment is requested until staff resolve it.
 */
import type { CountryDecision } from '@/lib/compliance/country';
import type { ShippingQuote, ShippingClassCode } from '@/lib/shipping/quote';
import type { VatDecision, VatTreatmentCode } from '@/lib/tax/determine';

export type HoldCode = 'COMPLIANCE' | 'VAT_REVIEW' | 'ADDRESS_REVIEW' | 'SHIPPING_PENDING' | 'PAYMENT_REVIEW' | 'INVOICE_PENDING';
/** holdReason = the first open hold in this order. INVOICE_PENDING: paid, invoice not issued (missing details / technical error). */
export const HOLD_PRIORITY: readonly HoldCode[] = ['COMPLIANCE', 'VAT_REVIEW', 'ADDRESS_REVIEW', 'SHIPPING_PENDING', 'PAYMENT_REVIEW', 'INVOICE_PENDING'];

export function primaryHold(holds: readonly string[]): HoldCode | null {
  for (const h of HOLD_PRIORITY) if (holds.includes(h)) return h;
  return null;
}

export interface PricedLine {
  productId: string;
  slug: string;
  title: string;
  brand: string | null;
  qty: number;
  /** Sell price per unit, net (what is charged). */
  unitCents: number;
  /** Supplier / catalogue price per unit before the shop rule. */
  baseUnitCents: number;
  appliedMarkupBp: number;
  currency: string;
  vatScheme: 'STANDARD' | 'MARGIN';
  shippingClass: ShippingClassCode | null;
  weightKg: number | null;
}

export type RefusalCode = 'EMPTY' | 'UNAVAILABLE' | 'MIXED_CURRENCY' | 'COUNTRY_BLOCKED' | 'NOT_SHIPPABLE' | 'VAT_BLOCKED' | 'NO_PAYMENT_METHOD';

export interface CheckoutRefusal {
  code: RefusalCode;
  message: string;
}

export interface CheckoutHold {
  code: HoldCode;
  /** Buyer-facing sentence (from the configured texts). */
  message: string;
  /** Staff-facing detail (rule reasons). */
  detail: string;
}

export interface HoldTexts {
  SHIPPING_PENDING: string;
  COMPLIANCE: string;
  VAT_REVIEW: string;
}

export interface CheckoutComputation {
  currency: string;
  lines: Array<PricedLine & { lineCents: number; vatRateBp: number; taxCents: number }>;
  goodsCents: number;
  shipping:
    | { status: 'QUOTED'; cents: number; zone: string | null; leadTime: string | null; reasons: string[] }
    | { status: 'TO_BE_CONFIRMED'; cents: 0; zone: null; leadTime: null; reasons: string[] };
  vat: {
    treatment: VatTreatmentCode;
    /** Rate of the goods; null while a person must decide (review). */
    rateBp: number | null;
    shippingRateBp: number;
    shippingTaxCents: number;
    rows: Array<{ rateBp: number; baseCents: number; taxCents: number }>;
    legalText: string | null;
    reasons: string[];
    review: boolean;
    buyerVatIdRequired: boolean;
  };
  taxCents: number;
  totalCents: number;
  holds: CheckoutHold[];
  refusal: CheckoutRefusal | null;
}

export function fillHoldText(template: string, vars: { COUNTRY?: string | null; REASON?: string | null }): string {
  return template
    .replace(/\{COUNTRY\}/g, vars.COUNTRY || 'your country')
    .replace(/\{REASON\}/g, vars.REASON || 'a rule needs a person')
    .trim();
}

/** Goods lines for the shipping quote (qty, class, weight, value). */
export function shippingLinesOf(lines: readonly PricedLine[]) {
  return lines.map((l) => ({ qty: l.qty, shippingClass: l.shippingClass, weightKg: l.weightKg, valueCents: l.unitCents * l.qty }));
}

/** Lines for the VAT engine: goods (net = unit × qty) + the shipping charge when known. */
export function vatLinesOf(lines: readonly PricedLine[], shippingCents: number) {
  const out: Array<{ netCents: number; lineType: 'GOODS' | 'SHIPPING'; scheme: 'STANDARD' | 'MARGIN' }> = lines.map((l) => ({
    netCents: l.unitCents * l.qty,
    lineType: 'GOODS' as const,
    scheme: l.vatScheme,
  }));
  if (shippingCents > 0) out.push({ netCents: shippingCents, lineType: 'SHIPPING', scheme: 'STANDARD' });
  return out;
}

export function assembleCheckout(a: {
  lines: readonly PricedLine[];
  shipTo: CountryDecision;
  billing: CountryDecision | null;
  shipping: ShippingQuote;
  /** Decided on vatLinesOf(lines, shipping amount). */
  vat: VatDecision;
  texts: HoldTexts;
}): CheckoutComputation {
  const currency = a.lines[0]?.currency ?? 'EUR';
  const holds: CheckoutHold[] = [];
  let refusal: CheckoutRefusal | null = null;
  const refuse = (code: RefusalCode, message: string) => {
    if (!refusal) refusal = { code, message };
  };

  if (!a.lines.length) refuse('EMPTY', 'There is nothing to order.');
  if (a.lines.some((l) => l.currency !== currency)) refuse('MIXED_CURRENCY', 'Items priced in different currencies must be ordered separately.');

  // Destination (and the billing country — sanctions apply to the buyer too).
  const countryName = a.shipTo.name ?? a.shipTo.country;
  for (const d of [a.shipTo, ...(a.billing && a.billing.country !== a.shipTo.country ? [a.billing] : [])]) {
    if (d.mode === 'BLOCK') refuse('COUNTRY_BLOCKED', d.reason);
  }
  const reviewCountries = [a.shipTo, ...(a.billing && a.billing.country !== a.shipTo.country ? [a.billing] : [])].filter((d) => d.mode === 'REVIEW');
  if (reviewCountries.length) {
    holds.push({
      code: 'COMPLIANCE',
      message: fillHoldText(a.texts.COMPLIANCE, { COUNTRY: reviewCountries.map((d) => d.name ?? d.country).join(' / ') }),
      detail: reviewCountries.map((d) => d.reason).join(' '),
    });
  }

  // Shipping.
  let shipping: CheckoutComputation['shipping'];
  if (a.shipping.status === 'NOT_SHIPPABLE') {
    refuse('NOT_SHIPPABLE', `We cannot ship this order to ${countryName} online. ${a.shipping.reasons[0] ?? ''} Request a quote instead — we arrange the transport for you.`.replace(/\s+/g, ' ').trim());
    shipping = { status: 'TO_BE_CONFIRMED', cents: 0, zone: null, leadTime: null, reasons: a.shipping.reasons };
  } else if (a.shipping.status === 'TO_BE_CONFIRMED') {
    shipping = { status: 'TO_BE_CONFIRMED', cents: 0, zone: null, leadTime: null, reasons: a.shipping.reasons };
    holds.push({ code: 'SHIPPING_PENDING', message: fillHoldText(a.texts.SHIPPING_PENDING, { COUNTRY: countryName }), detail: a.shipping.reasons.join(' ') });
  } else {
    shipping = { status: 'QUOTED', cents: a.shipping.amountCents, zone: a.shipping.zone?.name ?? null, leadTime: a.shipping.leadTimeText, reasons: a.shipping.reasons };
  }

  // VAT.
  const d = a.vat;
  if (d.blocked) refuse('VAT_BLOCKED', d.reasons[d.reasons.length - 1] ?? 'This sale is not allowed by the VAT settings.');
  if (d.reviewRequired && !d.blocked) {
    const reason = d.reasons.find((r) => /review|unavailable|not checked|no vat rate|cannot be decided/i.test(r)) ?? d.reasons[0] ?? null;
    holds.push({ code: 'VAT_REVIEW', message: fillHoldText(a.texts.VAT_REVIEW, { REASON: reason ? reason.replace(/\.$/, '') : null }), detail: d.reasons.join(' ') });
  }
  const goodsResults = d.lines.filter((l) => l.lineType !== 'SHIPPING');
  const shipResult = d.lines.find((l) => l.lineType === 'SHIPPING') ?? null;
  const lines = a.lines.map((l, i) => ({
    ...l,
    lineCents: l.unitCents * l.qty,
    vatRateBp: goodsResults[i]?.rateBp ?? 0,
    taxCents: goodsResults[i]?.taxCents ?? 0,
  }));
  const goodsCents = lines.reduce((s, l) => s + l.lineCents, 0);
  const taxCents = d.taxCents;
  return {
    currency,
    lines,
    goodsCents,
    shipping,
    vat: {
      treatment: d.treatment,
      rateBp: d.reviewRequired ? null : d.rateBp,
      shippingRateBp: d.shippingRateBp,
      shippingTaxCents: shipResult?.taxCents ?? 0,
      rows: d.breakdown.map((r) => ({ rateBp: r.rateBp, baseCents: r.baseCents, taxCents: r.taxCents })),
      legalText: d.legalText,
      reasons: d.reasons,
      review: d.reviewRequired,
      buyerVatIdRequired: d.buyerVatIdRequired,
    },
    taxCents,
    totalCents: goodsCents + shipping.cents + taxCents,
    holds: holds.sort((x, y) => HOLD_PRIORITY.indexOf(x.code) - HOLD_PRIORITY.indexOf(y.code)),
    refusal,
  };
}

/** Stripe Checkout line items for a priced order: goods + shipping + VAT, summing to the total. */
export function stripeLineItems(o: {
  currency: string;
  items: ReadonlyArray<{ title: string; qty: number; unitCents: number }>;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  vatLabel: string;
  orderNumber: string;
}): Array<{ name: string; unitAmount: number; quantity: number }> {
  const lines: Array<{ name: string; unitAmount: number; quantity: number }> = o.items
    .filter((i) => i.qty > 0 && i.unitCents > 0)
    .map((i) => ({ name: i.title.slice(0, 250), unitAmount: i.unitCents, quantity: i.qty }));
  if (o.shippingCents > 0) lines.push({ name: 'Shipping', unitAmount: o.shippingCents, quantity: 1 });
  if (o.taxCents > 0) lines.push({ name: o.vatLabel.slice(0, 250), unitAmount: o.taxCents, quantity: 1 });
  const sum = lines.reduce((s, l) => s + l.unitAmount * l.quantity, 0);
  // Never let Stripe charge anything but the order total.
  if (sum !== o.totalCents || o.totalCents <= 0) return [{ name: `Order ${o.orderNumber}`, unitAmount: o.totalCents, quantity: 1 }];
  return lines;
}

/** Stripe reports amounts in the minor unit and the currency lower-case. */
export function stripeAmountMatches(order: { totalCents: number; currency: string }, session: { amount_total?: number | null; currency?: string | null }):
  { ok: true } | { ok: false; reason: string } {
  const amount = typeof session.amount_total === 'number' ? session.amount_total : null;
  const cur = (session.currency ?? '').toUpperCase();
  if (amount == null) return { ok: false, reason: 'Stripe did not report the amount paid.' };
  if (cur !== order.currency.toUpperCase()) return { ok: false, reason: `Stripe charged in ${cur || 'an unknown currency'}, the order is in ${order.currency.toUpperCase()}.` };
  if (amount !== order.totalCents) {
    return { ok: false, reason: `Stripe charged ${(amount / 100).toFixed(2)} ${cur} but the order total is ${(order.totalCents / 100).toFixed(2)} ${order.currency.toUpperCase()}.` };
  }
  return { ok: true };
}
