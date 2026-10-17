import { test } from 'node:test';
import assert from 'node:assert/strict';
import { determineVat, taxOn, vatInMargin, type TaxSettings, type CountryFacts, type VatContext, type VatIdEvidence } from './determine';
import { parseVatId, vatIdLooksValid, viesPrefixFor } from './vatid';

const EU: Record<string, number> = { NL: 2100, DE: 1900, FR: 2000, BE: 2100, GR: 2400, IE: 2300 };
const countries: CountryFacts = {
  isEu: (c) => c in EU,
  standardRateBp: (c) => EU[c] ?? null,
};
const base: TaxSettings = {
  homeCountry: 'NL',
  standardRateBp: 2100,
  shippingFollowsMain: true,
  icsEnabled: true,
  icsRequireVies: true,
  viesDownPolicy: 'MANUAL_REVIEW',
  exportZeroEnabled: true,
  euB2cMode: 'HOME_RATE',
  marginSchemeEnabled: false,
  salesMode: 'B2B_ONLY',
  legalTexts: { ICS: 'ICS-TEXT', EXPORT: 'EXPORT-TEXT', MARGIN: 'MARGIN-TEXT', OSS: 'OSS-TEXT' },
};
const S = (o: Partial<TaxSettings> = {}): TaxSettings => ({ ...base, ...o });
const id = (vatId: string, status: VatIdEvidence['status'], country?: string): VatIdEvidence => ({
  vatId, country: country ?? parseVatId(vatId)!.country, status, formatValid: true,
});
const ctx = (o: Partial<VatContext> = {}): VatContext => ({
  shipToCountry: 'NL',
  billingCountry: 'NL',
  customerKind: 'BUSINESS',
  vatId: null,
  lines: [{ netCents: 100_000, lineType: 'GOODS' }, { netCents: 5_000, lineType: 'SHIPPING' }],
  ...o,
});

test('NL domestic: 21% on goods AND shipping', () => {
  const d = determineVat(ctx(), S(), countries);
  assert.equal(d.treatment, 'DOMESTIC_STANDARD');
  assert.equal(d.rateBp, 2100);
  assert.equal(d.shippingRateBp, 2100);
  assert.equal(d.taxCents, taxOn(105_000, 2100));
  assert.equal(d.taxCents, 22_050);
  assert.equal(d.totalCents, 127_050);
  assert.equal(d.legalText, null);
  assert.equal(d.reviewRequired, false);
});

test('NL buyer with a valid NL VAT ID is still domestic 21% (no reverse charge for the dispatch country)', () => {
  const d = determineVat(ctx({ vatId: id('NL123456789B01', 'VALID') }), S(), countries);
  assert.equal(d.treatment, 'DOMESTIC_STANDARD');
  assert.equal(d.taxCents, 22_050);
});

test('EU B2B with a VIES-valid VAT ID: intra-Community supply 0% + legal text + buyer VAT ID required', () => {
  const d = determineVat(ctx({ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'VALID') }), S(), countries);
  assert.equal(d.treatment, 'EU_ICS_ZERO');
  assert.equal(d.rateBp, 0);
  assert.equal(d.shippingRateBp, 0, 'shipping follows the zero-rated goods');
  assert.equal(d.taxCents, 0);
  assert.equal(d.legalTextKey, 'ICS');
  assert.equal(d.legalText, 'ICS-TEXT');
  assert.equal(d.buyerVatIdRequired, true);
});

test('EU B2B with an INVALID VAT ID is charged the home rate', () => {
  const d = determineVat(ctx({ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'INVALID') }), S(), countries);
  assert.equal(d.treatment, 'EU_B2C_HOME');
  assert.equal(d.rateBp, 2100);
  assert.equal(d.taxCents, 22_050);
  assert.match(d.reasons.join(' '), /NOT valid/);
});

test('VIES unavailable follows TAX_VIES_DOWN_POLICY', () => {
  const c = ctx({ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'UNAVAILABLE') });
  const review = determineVat(c, S({ viesDownPolicy: 'MANUAL_REVIEW' }), countries);
  assert.equal(review.treatment, 'REVIEW_REQUIRED');
  assert.equal(review.reviewRequired, true);
  assert.equal(review.taxCents, 0);
  const home = determineVat(c, S({ viesDownPolicy: 'CHARGE_HOME_VAT' }), countries);
  assert.equal(home.treatment, 'EU_B2C_HOME');
  assert.equal(home.taxCents, 22_050);
  const block = determineVat(c, S({ viesDownPolicy: 'BLOCK' }), countries);
  assert.equal(block.blocked, true);
  assert.equal(block.reviewRequired, true);
});

test('without the VIES requirement a well-formed but unchecked VAT ID gets 0%', () => {
  const d = determineVat(ctx({ shipToCountry: 'BE', billingCountry: 'BE', vatId: id('BE0123456789', 'NOT_CHECKED') }), S({ icsRequireVies: false }), countries);
  assert.equal(d.treatment, 'EU_ICS_ZERO');
});

test('ICS switched off: EU business pays the home rate', () => {
  const d = determineVat(ctx({ shipToCountry: 'DE', vatId: id('DE123456789', 'VALID') }), S({ icsEnabled: false }), countries);
  assert.equal(d.treatment, 'EU_B2C_HOME');
  assert.equal(d.rateBp, 2100);
});

test('Greek VAT IDs use the EL prefix and still qualify', () => {
  const p = parseVatId('el 123 456 789');
  assert.deepEqual(p && [p.prefix, p.country, p.vatId], ['EL', 'GR', 'EL123456789']);
  assert.equal(viesPrefixFor('GR'), 'EL');
  const d = determineVat(ctx({ shipToCountry: 'GR', billingCountry: 'GR', vatId: id('EL123456789', 'VALID') }), S(), countries);
  assert.equal(d.treatment, 'EU_ICS_ZERO');
});

test('export outside the EU is 0% with the export text, whatever the billing country', () => {
  const d = determineVat(ctx({ shipToCountry: 'US', billingCountry: 'NL', customerKind: 'UNKNOWN' }), S(), countries);
  assert.equal(d.treatment, 'EXPORT_ZERO');
  assert.equal(d.taxCents, 0);
  assert.equal(d.legalText, 'EXPORT-TEXT');
  const ch = determineVat(ctx({ shipToCountry: 'CH', billingCountry: 'CH', vatId: null }), S(), countries);
  assert.equal(ch.treatment, 'EXPORT_ZERO');
});

test('a non-EU buyer taking delivery in NL is domestic', () => {
  const d = determineVat(ctx({ shipToCountry: 'NL', billingCountry: 'US' }), S(), countries);
  assert.equal(d.treatment, 'DOMESTIC_STANDARD');
});

test('export 0% switched off → home rate', () => {
  const d = determineVat(ctx({ shipToCountry: 'US', billingCountry: 'US' }), S({ exportZeroEnabled: false }), countries);
  assert.equal(d.treatment, 'DOMESTIC_STANDARD');
  assert.equal(d.rateBp, 2100);
});

test('EU consumers: home rate, or the destination rate under OSS', () => {
  const c = ctx({ shipToCountry: 'FR', billingCountry: 'FR', customerKind: 'CONSUMER', vatId: null });
  const home = determineVat(c, S({ salesMode: 'B2B_AND_B2C' }), countries);
  assert.equal(home.treatment, 'EU_B2C_HOME');
  assert.equal(home.rateBp, 2100);
  const oss = determineVat(c, S({ salesMode: 'B2B_AND_B2C', euB2cMode: 'OSS' }), countries);
  assert.equal(oss.treatment, 'EU_B2C_OSS');
  assert.equal(oss.rateBp, 2000);
  assert.equal(oss.legalText, 'OSS-TEXT');
  assert.equal(oss.taxCents, taxOn(105_000, 2000));
});

test('OSS without a configured destination rate needs review', () => {
  const noRate: CountryFacts = { isEu: (c) => c === 'NL' || c === 'IE', standardRateBp: (c) => (c === 'NL' ? 2100 : null) };
  const d = determineVat(ctx({ shipToCountry: 'IE', customerKind: 'CONSUMER' }), S({ salesMode: 'B2B_AND_B2C', euB2cMode: 'OSS' }), noRate);
  assert.equal(d.treatment, 'REVIEW_REQUIRED');
});

test('consumers are blocked when sales are B2B only', () => {
  const d = determineVat(ctx({ shipToCountry: 'DE', customerKind: 'CONSUMER' }), S({ salesMode: 'B2B_ONLY' }), countries);
  assert.equal(d.blocked, true);
});

test('margin scheme: VAT included in the price, not shown; exports stay 0%', () => {
  const lines = [{ netCents: 50_000, lineType: 'GOODS' as const, scheme: 'MARGIN' as const, purchaseCostCents: 30_000 }];
  const nl = determineVat(ctx({ lines }), S({ marginSchemeEnabled: true }), countries);
  assert.equal(nl.treatment, 'MARGIN_SCHEME');
  assert.equal(nl.taxCents, 0);
  assert.equal(nl.totalCents, 50_000);
  assert.equal(nl.lines[0].marginVatCents, vatInMargin(20_000, 2100));
  assert.equal(nl.lines[0].marginVatCents, 3471);
  assert.equal(nl.legalText, 'MARGIN-TEXT');
  const us = determineVat(ctx({ shipToCountry: 'US', lines }), S({ marginSchemeEnabled: true }), countries);
  assert.equal(us.treatment, 'EXPORT_ZERO');
  const off = determineVat(ctx({ lines }), S({ marginSchemeEnabled: false }), countries);
  assert.equal(off.treatment, 'DOMESTIC_STANDARD');
  assert.equal(off.taxCents, 10_500);
});

test('shipping taxed separately at the home rate when it does not follow the goods', () => {
  const d = determineVat(ctx({ shipToCountry: 'US' }), S({ shippingFollowsMain: false }), countries);
  assert.equal(d.treatment, 'EXPORT_ZERO');
  assert.equal(d.shippingRateBp, 2100);
  assert.equal(d.taxCents, taxOn(5_000, 2100));
});

test('no country at all → review, never a silent 0%', () => {
  const d = determineVat(ctx({ shipToCountry: null, billingCountry: null }), S(), countries);
  assert.equal(d.treatment, 'REVIEW_REQUIRED');
  assert.equal(d.reviewRequired, true);
});

test('tax is computed per rate group and the lines always add up to the breakdown', () => {
  const lines = [1, 2, 2, 3].map((n) => ({ netCents: n, lineType: 'GOODS' as const }));
  const d = determineVat(ctx({ lines }), S(), countries);
  const lineSum = d.lines.reduce((a, l) => a + l.taxCents, 0);
  const rowSum = d.breakdown.reduce((a, r) => a + r.taxCents, 0);
  assert.equal(rowSum, taxOn(8, 2100)); // 1.68 → 2
  assert.equal(lineSum, rowSum);
  assert.equal(d.taxCents, rowSum);
});

test('VAT ID shapes', () => {
  assert.equal(vatIdLooksValid('NL123456789B01'), true);
  assert.equal(vatIdLooksValid('NL12345678'), false);
  assert.equal(vatIdLooksValid('DE 123 456 789'), true);
  assert.equal(vatIdLooksValid('ATU12345678'), true);
  assert.equal(vatIdLooksValid('XX123'), false);
  assert.equal(parseVatId('12345'), null);
});
