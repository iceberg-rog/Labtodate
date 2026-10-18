import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buyerVatExplanation, buyerVatLabel, buyerVatRow, compareCompanyNames, companyNameTokens, determineVat, orderBuyerVatRow, taxOn, vatInMargin, vatRowTitle,
  type TaxSettings, type CountryFacts, type VatContext, type VatIdEvidence,
} from './determine';
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

// ── VIES name vs the buyer's legal name ──

const named = (vatId: string, name: string | null): VatIdEvidence => ({ ...id(vatId, 'VALID'), name });

test('a VIES-valid VAT ID of ANOTHER company: review, not 0% ("VAT ID belongs to …")', () => {
  const d = determineVat(
    ctx({ shipToCountry: 'BE', billingCountry: 'BE', vatId: named('BE0417497106', 'NV Anheuser-Busch InBev'), buyerLegalName: 'G4 Brussels Research Lab NV' }),
    S(),
    countries,
  );
  assert.equal(d.treatment, 'REVIEW_REQUIRED');
  assert.equal(d.reviewRequired, true);
  assert.equal(d.taxCents, 0);
  assert.match(d.reasons.join(' '), /VAT ID belongs to NV Anheuser-Busch InBev/);
  assert.match(buyerVatExplanation(d), /lists VAT ID BE0417497106 for “NV Anheuser-Busch InBev”, not for “G4 Brussels Research Lab NV”/);
  assert.doesNotMatch(buyerVatExplanation(d), /policy|review required|try again/i);
  assert.equal(d.reviewCause, 'VAT_ID_NAME_MISMATCH', 'retrying never helps: the buyer is not told to try again later');
});

test('the same company under its legal form / spelling still gets 0%', () => {
  for (const [vies, billing] of [
    ['ACME LABORATORIES B.V.', 'Acme Labs'],
    ['NV ANHEUSER-BUSCH INBEV', 'Anheuser Busch InBev N.V.'],
    ['STICHTING WAGENINGEN RESEARCH', 'Wageningen University & Research'],
    ['Max-Planck-Gesellschaft zur Förderung der Wissenschaften e.V.', 'Max Planck Institut für Biochemie'],
    ['QA LAB GMBH', 'QA Lab GmbH'],
  ]) {
    const d = determineVat(ctx({ shipToCountry: 'DE', billingCountry: 'DE', vatId: named('DE123456789', vies), buyerLegalName: billing }), S(), countries);
    assert.equal(d.treatment, 'EU_ICS_ZERO', `${vies} vs ${billing}`);
  }
});

test('no VIES name (DE answers "---"), no legal name or another script: no conclusion, 0% stands', () => {
  assert.equal(determineVat(ctx({ shipToCountry: 'DE', vatId: named('DE123456789', null), buyerLegalName: 'Anything GmbH' }), S(), countries).treatment, 'EU_ICS_ZERO');
  assert.equal(determineVat(ctx({ shipToCountry: 'DE', vatId: named('DE123456789', 'Other GmbH') }), S(), countries).treatment, 'EU_ICS_ZERO');
  const greek = determineVat(ctx({ shipToCountry: 'GR', vatId: named('EL123456789', 'ΦΑΡΜΑ ΕΛΛΑΣ Α.Ε.'), buyerLegalName: 'Pharma Hellas SA' }), S(), countries);
  assert.equal(greek.treatment, 'EU_ICS_ZERO');
  assert.match(greek.reasons.join(' '), /could not be compared/);
});

test('name normalisation drops legal forms, case, accents and punctuation', () => {
  assert.deepEqual(companyNameTokens('N.V. Anheuser-Busch InBev'), ['ANHEUSER', 'BUSCH', 'INBEV']);
  assert.deepEqual(companyNameTokens('Société Générale S.A.'), ['SOCIETE', 'GENERALE']);
  assert.equal(compareCompanyNames('XYZ Research NV', 'G4 Brussels Research Lab NV'), 'MISMATCH', 'a shared generic word is not enough');
  assert.equal(compareCompanyNames('B.V.', 'Acme'), 'UNKNOWN');
});

// ── buyer-facing texts ──

test('buyer texts never carry staff wording (policy, evidence, review required)', () => {
  const cases: Array<[Partial<VatContext>, Partial<TaxSettings>]> = [
    [{}, {}],
    [{ shipToCountry: 'US', billingCountry: 'US' }, {}],
    [{ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'VALID') }, {}],
    [{ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'INVALID') }, {}],
    [{ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'UNAVAILABLE') }, { viesDownPolicy: 'MANUAL_REVIEW' }],
    [{ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'UNAVAILABLE') }, { viesDownPolicy: 'CHARGE_HOME_VAT' }],
    [{ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'UNAVAILABLE') }, { viesDownPolicy: 'BLOCK' }],
    [{ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('NL123456789B01', 'VALID') }, {}],
    [{ shipToCountry: 'FR', billingCountry: 'FR', customerKind: 'CONSUMER' }, { salesMode: 'B2B_AND_B2C', euB2cMode: 'OSS' }],
    [{ shipToCountry: 'FR', billingCountry: 'FR', customerKind: 'CONSUMER' }, { salesMode: 'B2B_ONLY' }],
    [{ shipToCountry: null, billingCountry: null }, {}],
  ];
  for (const [c, st] of cases) {
    const d = determineVat(ctx(c), S(st), countries);
    const text = `${buyerVatExplanation(d)} ${buyerVatLabel(d)}`;
    assert.ok(buyerVatExplanation(d).length > 10, JSON.stringify(c));
    assert.doesNotMatch(text, /policy|evidence|review required|home rate|dispatch country/i, `${JSON.stringify(c)} ${JSON.stringify(st)} → ${text}`);
  }
});

test('export: "export at 0% VAT" for the buyer, the evidence reminder stays for staff', () => {
  const d = determineVat(ctx({ shipToCountry: 'US', billingCountry: 'US' }), S(), countries);
  assert.match(buyerVatExplanation(d), /Delivery to US, outside the EU: export at 0% VAT/);
  assert.match(d.reasons.join(' '), /keep the export evidence/);
  assert.equal(vatRowTitle(d), 'VAT 0%');
});

test('CHARGE_HOME_VAT for a VAT ID VIES could not confirm: labelled as such for the buyer', () => {
  const d = determineVat(ctx({ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'UNAVAILABLE') }), S({ viesDownPolicy: 'CHARGE_HOME_VAT' }), countries);
  assert.equal(d.treatment, 'EU_B2C_HOME');
  assert.equal(buyerVatLabel(d), 'Home VAT (VAT ID not yet confirmed — credited later)');
  assert.match(buyerVatExplanation(d), /could not check your VAT ID DE123456789/);
  const none = determineVat(ctx({ shipToCountry: 'DE', billingCountry: 'DE' }), S(), countries);
  assert.equal(buyerVatLabel(none), 'Standard rate (no EU VAT ID)');
});

test('margin scheme with freight: only the margin explanation, the row reads "VAT 21% on freight"', () => {
  const lines = [{ netCents: 50_000, lineType: 'GOODS' as const, scheme: 'MARGIN' as const, purchaseCostCents: 42_000 }, { netCents: 15_000, lineType: 'SHIPPING' as const }];
  const d = determineVat(ctx({ lines }), S({ marginSchemeEnabled: true }), countries);
  assert.equal(d.treatment, 'MARGIN_SCHEME');
  assert.equal(d.taxCents, 3_150);
  assert.equal(vatRowTitle(d), 'VAT 21% on freight');
  assert.deepEqual(d.buyerReasons, ['Margin scheme for second-hand goods: the VAT is included in the price and not shown separately; VAT 21% is charged on the freight only.']);
  assert.equal(buyerVatLabel(d), 'Margin scheme — VAT included in the price');
  assert.doesNotMatch(d.reasons.join(' '), /no purchase cost/, 'the cost is on file');
  const noCost = determineVat(ctx({ lines: [{ ...lines[0], purchaseCostCents: null }, lines[1]] }), S({ marginSchemeEnabled: true }), countries);
  assert.match(noCost.reasons.join(' '), /no purchase cost recorded/, 'staff still learn that the cost is missing');
  assert.doesNotMatch(buyerVatExplanation(noCost), /purchase cost/);
});

test('VAT row title: one rate, freight only, nothing taxed', () => {
  assert.equal(vatRowTitle(determineVat(ctx(), S(), countries)), 'VAT 21%');
  const exportFreight = determineVat(ctx({ shipToCountry: 'US' }), S({ shippingFollowsMain: false }), countries);
  assert.equal(vatRowTitle(exportFreight), 'VAT 21% on freight');
  const marginOnly = determineVat(ctx({ lines: [{ netCents: 50_000, lineType: 'GOODS', scheme: 'MARGIN', purchaseCostCents: 1 }] }), S({ marginSchemeEnabled: true }), countries);
  assert.equal(vatRowTitle(marginOnly), 'VAT');
});

test('review decisions say why (the next step for the buyer depends on it); others have no cause', () => {
  const vies = (status: VatIdEvidence['status'], st: Partial<TaxSettings> = {}) =>
    determineVat(ctx({ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', status) }), S(st), countries);
  assert.equal(vies('UNAVAILABLE').reviewCause, 'VIES_UNAVAILABLE');
  assert.equal(vies('NOT_CHECKED').reviewCause, 'VAT_ID_NOT_CHECKED');
  const blocked = vies('UNAVAILABLE', { viesDownPolicy: 'BLOCK' });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reviewCause, 'VIES_UNAVAILABLE');
  assert.match(buyerVatExplanation(blocked), /Please try again later/);
  assert.doesNotMatch(buyerVatExplanation(vies('NOT_CHECKED', { viesDownPolicy: 'BLOCK' })), /try again/, 'not checked: waiting does not help');
  assert.equal(determineVat(ctx({ shipToCountry: null, billingCountry: null }), S(), countries).reviewCause, 'NO_COUNTRY');
  const noRate: CountryFacts = { isEu: (c) => c in EU || c === 'XX', standardRateBp: (c) => EU[c] ?? null };
  assert.equal(determineVat(ctx({ shipToCountry: 'XX', billingCountry: 'XX', customerKind: 'CONSUMER' }), S({ salesMode: 'B2B_AND_B2C', euB2cMode: 'OSS' }), noRate).reviewCause, 'NO_DESTINATION_RATE');
  assert.equal(vies('VALID').reviewCause, null);
  assert.equal(determineVat(ctx(), S(), countries).reviewCause, null);
  // Cause only: the context (acceptance refusal, VAT hold) adds the next step.
  assert.doesNotMatch(buyerVatExplanation(vies('UNAVAILABLE')), /before asking for payment|try again/);
});

// ── the buyer's VAT row rebuilt from stored fields ──

test('a stored offer / order shows the same VAT row as the decision did', () => {
  const margin = [{ netCents: 50_000, lineType: 'GOODS' as const, scheme: 'MARGIN' as const, purchaseCostCents: 42_000 }, { netCents: 15_000, lineType: 'SHIPPING' as const }];
  const cases: Array<[Partial<VatContext>, Partial<TaxSettings>]> = [
    [{}, {}],
    [{ lines: margin }, { marginSchemeEnabled: true }],
    [{ shipToCountry: 'US', billingCountry: 'US' }, {}],
    [{ shipToCountry: 'US', billingCountry: 'US' }, { shippingFollowsMain: false }],
    [{ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'VALID') }, {}],
    [{ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'UNAVAILABLE') }, { viesDownPolicy: 'CHARGE_HOME_VAT' }],
    [{ shipToCountry: 'DE', billingCountry: 'DE', vatId: id('DE123456789', 'INVALID') }, {}],
    [{ shipToCountry: 'DE', billingCountry: 'DE' }, {}],
    [{ shipToCountry: 'FR', billingCountry: 'FR', customerKind: 'CONSUMER' }, { salesMode: 'B2B_AND_B2C', euB2cMode: 'OSS' }],
    [{ lines: [{ netCents: 100_000, lineType: 'GOODS' }] }, {}],
  ];
  for (const [c, st] of cases) {
    const d = determineVat(ctx(c), S(st), countries);
    const shipping = d.lines.filter((l) => l.lineType === 'SHIPPING').reduce((a, l) => a + l.netCents, 0);
    const stored = { treatment: d.treatment, rateBp: d.rateBp, shippingRateBp: d.shippingRateBp, shippingCents: shipping, taxCents: d.taxCents };
    const row = buyerVatRow({ ...stored, buyerLabel: buyerVatLabel(d) });
    assert.deepEqual(row, { title: vatRowTitle(d), label: buyerVatLabel(d) }, JSON.stringify(c));
  }
});

test('margin item with freight after a refresh: "VAT 21% on freight", never "VAT 0%" next to an amount', () => {
  const row = buyerVatRow({ treatment: 'MARGIN_SCHEME', rateBp: 0, shippingRateBp: 2100, shippingCents: 15_000, taxCents: 3_150 });
  assert.deepEqual(row, { title: 'VAT 21% on freight', label: 'Margin scheme — VAT included in the price' });
  // Freight rate not recorded (legacy offer): a plain "VAT", not a false rate.
  assert.equal(buyerVatRow({ treatment: 'MARGIN_SCHEME', rateBp: 0, shippingCents: 15_000, taxCents: 3_150 }).title, 'VAT');
  assert.equal(buyerVatRow({ treatment: 'DOMESTIC_STANDARD', rateBp: null, taxCents: 2_100 }).title, 'VAT');
  assert.equal(buyerVatRow({ treatment: 'EU_ICS_ZERO', rateBp: 0, shippingRateBp: 0, shippingCents: 5_000, taxCents: 0 }).title, 'VAT 0%');
  assert.equal(buyerVatRow({ treatment: 'REVIEW_REQUIRED', rateBp: 0, taxCents: 0 }).title, 'VAT');
  // No label recorded: buyer wording from the treatment, never the staff label.
  assert.equal(buyerVatRow({ treatment: 'EU_B2C_HOME', rateBp: 2100, taxCents: 1, hasVatId: false }).label, 'Standard rate (no EU VAT ID)');
  assert.equal(buyerVatRow({ treatment: 'EU_B2C_HOME', rateBp: 2100, taxCents: 1, hasVatId: true }).label, 'Standard rate');
});

test('order row: the recorded buyer label is used only while that VAT decision stands', () => {
  const decidedAt = new Date('2026-10-18T09:00:00Z');
  const order = {
    vatTreatment: 'EU_B2C_HOME', vatRateBp: 2100, shippingVatRateBp: 2100, shippingCents: 5_000, taxCents: 22_050, buyerVatId: 'DE123456789', vatDecidedAt: decidedAt,
    pricingSnapshot: { buyerVat: { treatment: 'EU_B2C_HOME', decidedAt: decidedAt.toISOString(), label: 'Home VAT (VAT ID not yet confirmed — credited later)', title: 'VAT 21%' } },
  };
  assert.deepEqual(orderBuyerVatRow(order), { title: 'VAT 21%', label: 'Home VAT (VAT ID not yet confirmed — credited later)' });
  // Staff re-decided the VAT (VIES confirmed → 0%): the old label would be false.
  const redecided = { ...order, vatTreatment: 'EU_ICS_ZERO', vatRateBp: 0, shippingVatRateBp: 0, taxCents: 0, vatDecidedAt: new Date('2026-10-20T09:00:00Z') };
  assert.deepEqual(orderBuyerVatRow(redecided), { title: 'VAT 0%', label: 'Intra-EU supply, 0% (reverse charge)' });
  assert.equal(orderBuyerVatRow({ ...order, vatDecidedAt: new Date('2026-10-20T09:00:00Z') }).label, 'Standard rate', 'same treatment, later decision');
  // A checkout order (no recorded buyer texts).
  assert.equal(orderBuyerVatRow({ ...order, pricingSnapshot: { vat: { label: 'EU buyer without VAT ID (home rate)' } } }).label, 'Standard rate');
});
