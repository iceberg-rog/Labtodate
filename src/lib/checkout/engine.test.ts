import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleCheckout, primaryHold, shippingLinesOf, stripeAmountMatches, stripeLineItems, vatLinesOf, type PricedLine } from './engine';
import { determineVat, type TaxSettings, type CountryFacts } from '../tax/determine';
import { quoteShipping, type ShippingSettings, type ZoneRow } from '../shipping/quote';
import { decideCountry, type CountryPolicyRow } from '../compliance/country';
import { resolveSellPrice } from '../pricing/resolve';
import { formValuesFrom, validateCheckoutFields, type CheckoutRules } from './input';
import { netFromImportedPrice } from '../pricing/import-vat';
import { effectiveDisplayMode, priceParts, shownToNetCents, type PriceDisplaySettings } from '../pricing/display';
import { decisionFromRecorded, type OrderForVat } from '../tax/order';

const tax: TaxSettings = {
  homeCountry: 'NL', standardRateBp: 2100, shippingFollowsMain: true, icsEnabled: true, icsRequireVies: true,
  viesDownPolicy: 'MANUAL_REVIEW', exportZeroEnabled: true, euB2cMode: 'HOME_RATE', marginSchemeEnabled: false,
  salesMode: 'B2B_ONLY', legalTexts: { ICS: 'ICS text', EXPORT: 'EXPORT text', MARGIN: 'MARGIN text', OSS: 'OSS text' },
};
const EU = new Set(['NL', 'DE', 'BE', 'FR', 'IE']);
const countries: CountryFacts = { isEu: (c) => EU.has(c), standardRateBp: (c) => ({ DE: 1900, BE: 2100, FR: 2000, IE: 2300, NL: 2100 } as Record<string, number>)[c] ?? null };
const policy: CountryPolicyRow[] = [
  { country: 'NL', name: 'Netherlands', isEu: true, mode: 'ALLOW', note: null },
  { country: 'DE', name: 'Germany', isEu: true, mode: 'ALLOW', note: null },
  { country: 'US', name: 'United States', isEu: false, mode: 'ALLOW', note: null },
  { country: 'TR', name: 'Türkiye', isEu: false, mode: 'REVIEW', note: null },
  { country: 'RU', name: 'Russia', isEu: false, mode: 'BLOCK', note: null },
];
const ship: ShippingSettings = { mode: 'ZONE_TABLE', flatCents: 0, unmatched: 'TO_BE_CONFIRMED', defaultClass: 'FREIGHT_QUOTE', handlingCents: 0, freeAboveCents: null };
const zones: ZoneRow[] = [
  { id: 'z1', name: 'Benelux', countries: ['NL', 'BE'], active: true, sortOrder: 0, rates: [
    { id: 'r1', name: 'Parcel', shippingClass: 'PARCEL', basis: 'FLAT', amountCents: 2500, currency: 'EUR', freeAboveCents: null, handlingCents: 0, minKg: null, maxKg: null, leadTimeText: '2–3 days', active: true },
  ] },
  { id: 'z2', name: 'World', countries: ['*'], active: true, sortOrder: 9, rates: [
    { id: 'r2', name: 'Parcel world', shippingClass: 'PARCEL', basis: 'FLAT', amountCents: 9000, currency: 'EUR', freeAboveCents: null, handlingCents: 0, minKg: null, maxKg: null, leadTimeText: null, active: true },
  ] },
];
const texts = { SHIPPING_PENDING: 'Shipping to {COUNTRY} is quoted.', COMPLIANCE: 'Orders to {COUNTRY} are reviewed.', VAT_REVIEW: 'VAT check ({REASON}).' };

function line(over: Partial<PricedLine> = {}): PricedLine {
  return { productId: 'p1', slug: 'p1', title: 'HPLC pump', brand: 'Agilent', qty: 1, unitCents: 110000, baseUnitCents: 100000, appliedMarkupBp: 1000, currency: 'EUR', vatScheme: 'STANDARD', shippingClass: 'PARCEL', weightKg: 12, ...over };
}

function price(lines: PricedLine[], country: string, opts: { business?: boolean; vatId?: { vatId: string; country: string; status: 'VALID' | 'INVALID' | 'UNAVAILABLE' | 'NOT_CHECKED' } | null; billing?: string } = {}) {
  const shipTo = decideCountry(country, policy, 'REVIEW');
  const billing = opts.billing ? decideCountry(opts.billing, policy, 'REVIEW') : null;
  const sq = quoteShipping({ country, lines: shippingLinesOf(lines), currency: 'EUR' }, ship, zones);
  const shippingCents = sq.status === 'QUOTED' ? sq.amountCents : 0;
  const vat = determineVat({ shipToCountry: country, billingCountry: opts.billing ?? country, customerKind: opts.business === false ? 'CONSUMER' : 'BUSINESS', vatId: opts.vatId ?? null, lines: vatLinesOf(lines, shippingCents) }, tax, countries);
  return assembleCheckout({ lines, shipTo, billing, shipping: sq, vat, texts });
}

test('NL buyer: sell price (markup) + zone shipping + 21% on goods AND shipping', () => {
  const r = price([line()], 'NL');
  assert.equal(r.refusal, null);
  assert.deepEqual(r.holds, []);
  assert.equal(r.goodsCents, 110000);
  assert.equal(r.shipping.cents, 2500);
  assert.equal(r.vat.treatment, 'DOMESTIC_STANDARD');
  assert.equal(r.taxCents, Math.round(110000 * 0.21) + Math.round(2500 * 0.21));
  assert.equal(r.totalCents, 110000 + 2500 + r.taxCents);
  assert.equal(r.lines[0].taxCents + r.vat.shippingTaxCents, r.taxCents);
});

test('DE business with a VIES-valid VAT ID: intra-EU 0% with legal text; without ID: home rate', () => {
  const ics = price([line()], 'DE', { vatId: { vatId: 'DE123456789', country: 'DE', status: 'VALID' } });
  assert.equal(ics.vat.treatment, 'EU_ICS_ZERO');
  assert.equal(ics.taxCents, 0);
  assert.equal(ics.vat.legalText, 'ICS text');
  const noId = price([line()], 'DE');
  assert.equal(noId.vat.treatment, 'EU_B2C_HOME');
  assert.ok(noId.taxCents > 0);
});

test('VIES unavailable → VAT review hold (no payment), never a silent 0%', () => {
  const r = price([line()], 'DE', { vatId: { vatId: 'DE123456789', country: 'DE', status: 'UNAVAILABLE' } });
  assert.equal(r.refusal, null);
  assert.deepEqual(r.holds.map((h) => h.code), ['VAT_REVIEW']);
  assert.equal(r.vat.rateBp, null);
  assert.equal(r.taxCents, 0);
  assert.match(r.holds[0].message, /VAT check/);
});

test('freight items or no rate → shipping TO BE CONFIRMED hold, never €0 "free"', () => {
  const r = price([line({ shippingClass: 'FREIGHT_QUOTE' })], 'NL');
  assert.equal(r.shipping.status, 'TO_BE_CONFIRMED');
  assert.equal(r.shipping.cents, 0);
  assert.deepEqual(r.holds.map((h) => h.code), ['SHIPPING_PENDING']);
  assert.match(r.holds[0].message, /Netherlands/);
});

test('country policy: BLOCK refused (shipping or billing), REVIEW held for compliance', () => {
  assert.equal(price([line()], 'RU').refusal?.code, 'COUNTRY_BLOCKED');
  assert.equal(price([line()], 'NL', { billing: 'RU' }).refusal?.code, 'COUNTRY_BLOCKED');
  const tr = price([line()], 'TR');
  assert.equal(tr.refusal, null);
  assert.equal(tr.holds[0].code, 'COMPLIANCE');
  assert.match(tr.holds[0].message, /Türkiye/);
  assert.equal(primaryHold(['SHIPPING_PENDING', 'COMPLIANCE']), 'COMPLIANCE');
});

test('export outside the EU at 0% (shipping follows the goods)', () => {
  const r = price([line()], 'US');
  assert.equal(r.vat.treatment, 'EXPORT_ZERO');
  assert.equal(r.taxCents, 0);
  assert.equal(r.shipping.cents, 9000);
  assert.equal(r.totalCents, 110000 + 9000);
});

test('consumer while B2B only is refused', () => {
  const r = price([line()], 'DE', { business: false });
  assert.equal(r.refusal?.code, 'VAT_BLOCKED');
});

test('mixed currencies refused', () => {
  assert.equal(price([line(), line({ productId: 'p2', currency: 'USD' })], 'NL').refusal?.code, 'MIXED_CURRENCY');
});

test('A07: hidden / forced-quote prices are never buyable; markup is charged', () => {
  const base = { priceCents: 100000, currency: 'EUR', mode: 'HYBRID' as const, status: 'PUBLISHED', quantity: 1 };
  assert.equal(resolveSellPrice(base, { pricingMode: 'HIDE_PRICE', pricingMarkupBp: 0 }).buyable, false);
  assert.equal(resolveSellPrice(base, { pricingMode: 'HIDE_PRICE', pricingMarkupBp: 0 }).sellPriceCents, null);
  assert.equal(resolveSellPrice(base, { pricingMode: 'FORCE_QUOTE', pricingMarkupBp: 0 }).buyable, false);
  const m = resolveSellPrice({ ...base, priceCents: 1005 }, { pricingMode: 'MARKUP_PERCENT', pricingMarkupBp: 1000 });
  assert.equal(m.sellPriceCents, 1106); // 1105.5 rounded half up, exactly like the SQL twin
  assert.equal(resolveSellPrice({ ...base, priceCents: 1000 }, { pricingMode: 'MARKUP_PERCENT', pricingMarkupBp: -2500 }).sellPriceCents, 750);
});

test('A24: Stripe lines add up to the order total (goods + shipping + VAT)', () => {
  const lines = stripeLineItems({ currency: 'EUR', items: [{ title: 'Pump', qty: 2, unitCents: 50000 }], shippingCents: 2500, taxCents: 21525, totalCents: 124025, vatLabel: 'VAT 21%', orderNumber: 'L2D-1' });
  assert.equal(lines.reduce((s, l) => s + l.unitAmount * l.quantity, 0), 124025);
  assert.deepEqual(lines.map((l) => l.name), ['Pump', 'Shipping', 'VAT 21%']);
  // A mismatch never charges anything but the total.
  const fallback = stripeLineItems({ currency: 'EUR', items: [{ title: 'Pump', qty: 1, unitCents: 100 }], shippingCents: 0, taxCents: 0, totalCents: 150, vatLabel: 'VAT', orderNumber: 'L2D-2' });
  assert.deepEqual(fallback, [{ name: 'Order L2D-2', unitAmount: 150, quantity: 1 }]);
});

test('A24: webhook amount / currency check', () => {
  assert.deepEqual(stripeAmountMatches({ totalCents: 124025, currency: 'EUR' }, { amount_total: 124025, currency: 'eur' }), { ok: true });
  assert.equal(stripeAmountMatches({ totalCents: 124025, currency: 'EUR' }, { amount_total: 100000, currency: 'eur' }).ok, false);
  assert.equal(stripeAmountMatches({ totalCents: 124025, currency: 'EUR' }, { amount_total: 124025, currency: 'usd' }).ok, false);
  assert.equal(stripeAmountMatches({ totalCents: 124025, currency: 'EUR' }, { amount_total: null, currency: 'eur' }).ok, false);
});

const rules: CheckoutRules = { salesMode: 'B2B_ONLY', requireCompanyAndId: true, poMode: 'OPTIONAL', poRequiredByProfile: false, askInvoiceEmail: true, requirePhone: true, paymentMethods: ['BANK_TRANSFER'] };
const form = (o: Record<string, string>) => formValuesFrom((k) => o[k] ?? null);
const good = { name: 'Jan Jansen', phone: '+31 6 1234 5678', line1: 'Lab street 1', city: 'Leiden', postal: '2333 AA', country: 'NL', customerType: 'BUSINESS', company: 'BioLab BV', kvk: '12345678', b2bDeclaration: 'on', paymentMethod: 'BANK_TRANSFER' };

test('checkout fields: business needs company + KvK/VAT ID + declaration; PO per setting', () => {
  assert.deepEqual(validateCheckoutFields(form(good), rules), {});
  const e = validateCheckoutFields(form({ ...good, company: '', kvk: '', b2bDeclaration: '' }), rules);
  assert.ok(e.company && e.kvk && e.b2bDeclaration);
  assert.ok(validateCheckoutFields(form(good), { ...rules, poMode: 'REQUIRED' }).poNumber);
  assert.ok(validateCheckoutFields(form(good), { ...rules, poRequiredByProfile: true }).poNumber);
  assert.ok(validateCheckoutFields(form({ ...good, customerType: 'CONSUMER' }), rules).customerType);
  assert.deepEqual(validateCheckoutFields(form({ ...good, customerType: 'CONSUMER' }), { ...rules, salesMode: 'B2B_AND_B2C' }), {});
  assert.ok(validateCheckoutFields(form({ ...good, vatId: '123' }), rules).vatId);
  assert.ok(validateCheckoutFields(form({ ...good, billingSame: 'off' }), rules).b_line1);
  assert.ok(validateCheckoutFields(form({ ...good, invoiceEmail: 'nope' }), rules).invoiceEmail);
  assert.ok(validateCheckoutFields(form({ ...good, paymentMethod: 'STRIPE_CARD' }), rules).paymentMethod);
});

test('A26: imported gross prices converted to net', () => {
  assert.equal(netFromImportedPrice(121000, true, 2100), 100000);
  assert.equal(netFromImportedPrice(100, true, 2100), 83); // 82.64 → 83
  assert.equal(netFromImportedPrice(121000, false, 2100), 121000);
  assert.equal(netFromImportedPrice(null, true, 2100), null);
});

test('price display basis: EXCL / INCL / BOTH; consumers force incl.', () => {
  const s: PriceDisplaySettings = { mode: 'EXCL', standardRateBp: 2100, labelExcl: 'excl. VAT', labelIncl: 'incl. VAT', labelMargin: 'margin', note: '', marginSchemeEnabled: true };
  assert.deepEqual(priceParts(100000, s), { primaryCents: 100000, primaryLabel: 'excl. VAT', secondaryCents: null, secondaryLabel: null });
  assert.equal(priceParts(100000, { ...s, mode: 'INCL' }).primaryCents, 121000);
  assert.equal(priceParts(100000, { ...s, mode: 'BOTH' }).secondaryCents, 121000);
  assert.equal(priceParts(100000, s, { scheme: 'MARGIN' }).primaryLabel, 'margin');
  assert.equal(effectiveDisplayMode('EXCL', 'B2B_AND_B2C'), 'BOTH');
  assert.equal(effectiveDisplayMode('EXCL', 'B2B_ONLY'), 'EXCL');
  assert.equal(shownToNetCents(121000, { mode: 'INCL', standardRateBp: 2100 }, 'ceil'), 100000);
  assert.equal(shownToNetCents(121000, { mode: 'EXCL', standardRateBp: 2100 }, 'ceil'), 121000);
});

test('documents reproduce the recorded checkout VAT per line (shipping at its own rate)', () => {
  const order: OrderForVat = {
    vatTreatment: 'EXPORT_ZERO', vatRateBp: 0, buyerVatId: null, shippingAddress: null, billingAddress: null,
    subtotalCents: 100000, shippingCents: 5000, taxCents: 1050, shippingVatRateBp: 2100,
    items: [{ priceCentsSnapshot: 100000, quantity: 1, vatRateBp: 0, taxCents: 0 }],
  };
  const d = decisionFromRecorded(order, tax);
  assert.equal(d.taxCents, 1050);
  assert.deepEqual(d.breakdown.map((r) => [r.rateBp, r.baseCents, r.taxCents]), [[2100, 5000, 1050], [0, 100000, 0]]);
  // Older engine-priced orders (no per-line data) keep the single row.
  const legacy = decisionFromRecorded({ ...order, shippingVatRateBp: null, items: [{ priceCentsSnapshot: 100000, quantity: 1 }] }, tax);
  assert.equal(legacy.breakdown.length, 1);
});

test('integration s2a+s2b: checkout asks for the VAT ID per DETAILS_VAT_ID_REQUIRED (no later block on the payment page)', () => {
  // NL business with a KvK but no VAT ID: fine when the rule is off, asked for under "EU".
  assert.deepEqual(validateCheckoutFields(form(good), { ...rules, vatIdRule: 'OFF' }), {});
  assert.ok(validateCheckoutFields(form(good), { ...rules, vatIdRule: 'EU' }).vatId);
  assert.deepEqual(validateCheckoutFields(form({ ...good, vatId: 'NL859876543B01' }), { ...rules, vatIdRule: 'EU' }), {});
  // Outside the EU only "ALWAYS" asks; consumers are never asked.
  assert.deepEqual(validateCheckoutFields(form({ ...good, country: 'US' }), { ...rules, vatIdRule: 'EU' }), {});
  assert.ok(validateCheckoutFields(form({ ...good, country: 'US' }), { ...rules, vatIdRule: 'ALWAYS' }).vatId);
  assert.deepEqual(validateCheckoutFields(form({ ...good, customerType: 'CONSUMER' }), { ...rules, salesMode: 'B2B_AND_B2C', vatIdRule: 'ALWAYS' }), {});
});
