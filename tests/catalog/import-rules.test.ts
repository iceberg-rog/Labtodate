import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  brandRulesFrom,
  conditionConflict,
  DEFAULT_BRAND_ALIASES,
  DEFAULT_BRAND_NAMES,
  DEFAULT_CATEGORY_RULES,
  DEFAULT_CONDITION_WORDS,
  hasPriceText,
  matchBrand,
  matchCategory,
  parseAliasLines,
  parseCategoryRules,
  parseConditionWords,
  phrasesRegex,
} from '../../src/lib/catalog/import-rules';
import { importSettingsFrom } from '../../src/lib/catalog/import-settings';
import { cleanSupplierHtmlDetailed, cleanSupplierText } from '../../src/lib/marketplace/import-clean';
import { renderTermsBlocks, DEFAULT_TERMS_TEXT } from '../../src/lib/catalog/texts';
import { warrantyMonthsLabel, resolveWarranty } from '../../src/lib/catalog/warranty';

const brands = brandRulesFrom(DEFAULT_BRAND_NAMES, DEFAULT_BRAND_ALIASES);
const cats = parseCategoryRules(DEFAULT_CATEGORY_RULES).rules;

test('brands: whole words, earliest in the title, aliases — never a substring guess', () => {
  assert.equal(matchBrand(null, 'Eppendorf ThermoMixer C', brands).brand, 'Eppendorf', '“ThermoMixer” is not “Thermo”');
  assert.equal(matchBrand(null, 'ThermoMixer C', brands).brand, null);
  assert.equal(matchBrand(null, 'HP 5890 Series II GC', brands).brand, 'Hewlett-Packard');
  assert.equal(matchBrand(null, 'Thermo Scientific Orbitrap', brands).brand, 'Thermo');
  assert.equal(matchBrand(null, 'Product 9108', brands).brand, null);
  // The source's own brand field wins, through the alias table; placeholders are not brands.
  assert.equal(matchBrand('Hewlett Packard', 'Agilent pump', brands).brand, 'Hewlett-Packard');
  assert.equal(matchBrand('Other', 'Agilent pump', brands).brand, 'Agilent');
  const both = matchBrand(null, 'Agilent /HP 7694 Headspace sampler', brands);
  assert.equal(both.brand, 'Agilent');
  assert.deepEqual(both.candidates, ['Agilent', 'Hewlett-Packard']);
  // Owner-configured lists.
  const own = brandRulesFrom('Acme Labs', 'ACME => Acme Labs');
  assert.equal(matchBrand(null, 'ACME centrifuge', own).brand, 'Acme Labs');
  assert.deepEqual(parseAliasLines('HP Hewlett').errors.length, 1);
});

test('categories: configurable rules; nothing matched → null (review), never the first category', () => {
  assert.equal(matchCategory('Eppendorf ThermoMixer C', '', cats), null);
  assert.equal(matchCategory('Sartorius pipette set', '', cats), null);
  assert.equal(matchCategory('Varian motor', '', cats), null);
  assert.equal(matchCategory('Waters 2489 UV/Vis Detector', '', cats), 'detectors', 'a detector, not a spectrometer');
  assert.equal(matchCategory('Thermo Vanquish Split Sampler', '', cats), 'autosamplers');
  assert.equal(matchCategory('Agilent 6890N GC', '', cats), 'gc');
  assert.equal(matchCategory('Waters Micromass ZQ LC/MS', '', cats), 'mass-spec');
  assert.equal(matchCategory('Some unit', 'Spectrophotometers', cats), 'spectroscopy', 'source category names count too');
  // Unknown slugs (category deleted) are skipped.
  assert.equal(matchCategory('Agilent 6890N GC', '', cats, (s) => s !== 'gc'), null);
  const own = parseCategoryRules('centrifuges: thermomixer*, centrifug*');
  assert.equal(own.errors.length, 0);
  assert.equal(matchCategory('Eppendorf ThermoMixer C', '', own.rules), 'centrifuges');
  assert.ok(parseCategoryRules('no colon here').errors.length);
});

test('conditions stated by the listing itself', () => {
  const w = parseConditionWords(DEFAULT_CONDITION_WORDS);
  assert.equal(conditionConflict('USED', 'Agilent G7077-65404 CI Source - Brand New', '', w), 'NEW');
  assert.equal(conditionConflict('USED', 'Agilent 6890N with CTC sampler', 'For sale: Refurbished Agilent 6890N with CTC sampler', w), 'REFURBISHED');
  assert.equal(conditionConflict('REFURBISHED', 'Agilent 6890N', 'For sale: Refurbished Agilent 6890N', w), null);
  assert.equal(conditionConflict('REFURBISHED', 'Agilent pump', 'Used for Agilent LC/MS TOF systems.', w), null, '“used for” is not a condition');
  assert.equal(conditionConflict('USED', 'Agilent DEI pulser', 'For sale: used Agilent G2597.', w), null);
});

test('prices inside texts are recognised; part numbers are not prices', () => {
  for (const t of ['€ 4,500.00', '€4,500.00', 'Prices from: 17.500 euro', 'EUR 9500,-', '4.500,- EUR', 'Price: 1200 EUR', '$1,200', 'Pricing: from EUR 9500']) {
    assert.equal(hasPriceText(t), true, t);
  }
  for (const t of ['G1311-66530 mainboard', '1260 series pump, 600 bar', 'Flow cell 10 mm, 14 µL', 'Agilent 7890A GC with 2 inlets']) {
    assert.equal(hasPriceText(t), false, t);
  }
});

test('settings → rules: claim mode REVIEW keeps texts; thresholds parsed; defaults when unset', () => {
  const d = importSettingsFrom(() => '');
  assert.equal(d.priceDropReviewBp, 3000);
  assert.equal(d.priceRiseReviewBp, 5000);
  assert.equal(d.archiveStopBp, 1000);
  assert.equal(d.archiveStopAllow, 3);
  assert.equal(d.priceReviewHold, true);
  assert.equal(d.backorderSellable, false);
  assert.equal(d.sourceTimeoutMs, 45_000);
  assert.equal(d.reportsKeep, 100);
  const env: Record<string, string> = {
    IMPORT_CLAIM_MODE: 'REVIEW',
    SYNC_PRICE_DROP_REVIEW_PCT: '12.5',
    SYNC_PRICE_REVIEW_HOLD: 'KEEP',
    SYNC_BACKORDER_MODE: 'SELLABLE',
    SYNC_ARCHIVE_STOP_PCT: '50',
    IMPORT_FALLBACK_CATEGORY: 'parts-modules',
  };
  const s = importSettingsFrom((k) => env[k] ?? '');
  assert.equal(s.claimMode, 'REVIEW');
  assert.equal(s.clean.claims, null, 'REVIEW: claims are kept in the text');
  assert.ok(s.detect.claims, 'but still detected for the audit');
  assert.equal(s.priceDropReviewBp, 1250);
  assert.equal(s.priceReviewHold, false);
  assert.equal(s.backorderSellable, true);
  assert.equal(s.archiveStopBp, 5000);
  assert.equal(s.fallbackCategorySlug, 'parts-modules');
  const kept = cleanSupplierHtmlDetailed('<p>Pump. Comes with 6 month warranty.</p>', { name: 'X' }, s.clean);
  assert.equal(kept.html, '<p>Pump. Comes with 6 month warranty.</p>');
  // Owner phrases.
  const own = importSettingsFrom((k) => (k === 'IMPORT_CLAIM_PHRASES' ? 'calibrated, iso 17025*' : ''));
  assert.equal(cleanSupplierHtmlDetailed('<p>HPLC pump. Calibrated last year.</p>', { name: 'X' }, own.clean).html, '<p>HPLC pump.</p>');
  assert.ok(phrasesRegex('iso 17025*')?.test('ISO-17025 certified'));
});

test('summary written apart from the description is cleaned with the same rules', () => {
  const r = cleanSupplierText('Agilent /HP 7694 Headspace sampler € 4,500.00. For sale: refurbished Agilent G1888 Headspace sampler.', { name: 'Lab2' });
  assert.equal(r.text, 'For sale: refurbished Agilent G1888 Headspace sampler.');
  assert.equal(r.removed[0].reason, 'PRICE');
});

test('terms text: every number comes from a setting; unknown placeholders stay visible', () => {
  const blocks = renderTermsBlocks(DEFAULT_TERMS_TEXT, {
    '{SITE}': 'lab2date', '{LEGAL_NAME}': 'Lab2date B.V.', '{COUNTRY}': ' (Netherlands)', '{RETURN_DAYS}': '30', '{OFFER_VALID_DAYS}': '21',
    '{PAYMENT_TERM_DAYS}': '10', '{PRICE_BASIS}': 'excluding VAT', '{WARRANTY_FALLBACK}': 'No warranty', '{INSPECTION_REPORT_CLAUSE}': '', '{SHIPPING_SENTENCE}': 'Shipped insured.',
  });
  const text = blocks.map((b) => b.parts.map((p) => ('text' in p ? p.text : '[contact]')).join('')).join('\n');
  assert.ok(text.includes('within 30 days of delivery'));
  assert.ok(!/\b7 days\b/.test(text), 'no hard-coded 7 days');
  assert.ok(text.includes('valid for 21 days'));
  assert.ok(text.includes('(10 days unless stated otherwise)'));
  assert.ok(!/\{[A-Z_]+\}/.test(text), 'every placeholder filled');
  assert.ok(text.includes('[contact]'), '{CONTACT} becomes the contact link');
  assert.equal(blocks.filter((b) => b.kind === 'h2').length, 8);
  const unknown = renderTermsBlocks('Call {PHONE}.', {});
  assert.equal(unknown[0].parts.map((p) => ('text' in p ? p.text : '')).join(''), 'Call {PHONE}.');
});

test('warranty length wording is configurable', () => {
  assert.equal(warrantyMonthsLabel(12), '12-month warranty');
  assert.equal(warrantyMonthsLabel(6, '{MONTHS} months warranty'), '6 months warranty');
  assert.equal(warrantyMonthsLabel(6, 'no placeholder'), '6-month warranty', 'an invalid format falls back');
  const w = resolveWarranty({ warrantyMonths: 3, warrantyText: null }, null, 'No warranty', '{MONTHS} maanden garantie');
  assert.equal(w.headline, '3 maanden garantie');
});

test('claims: only the claim goes — whole supplier sentences, or just the claim words inside a technical line', () => {
  const sup = { name: 'Lab2' };
  const clean = (h: string) => cleanSupplierHtmlDetailed(h, sup).html;
  assert.equal(clean('<div>Part number: 0950-2528</div><div>We do have all other parts for the 1100/1200 series HPLC modules</div>'), '<div>Part number: 0950-2528</div>', 'a supplier sentence goes whole (never “all other parts …” left behind)');
  assert.equal(clean('<h4>Fully Tested Agilent G1311-66530 / G1311-66540 Mainboard for G1311A</h4>'), '<h4>Agilent G1311-66530 / G1311-66540 Mainboard for G1311A</h4>');
  assert.equal(clean('<p>For sale: Agilent 240FS AAS system (please ask for official quote) Complete working system with burner.</p>'), '<p>For sale: Agilent 240FS AAS system Complete working system with burner.</p>');
  assert.equal(clean('<p>Complete with cables, connections and test report</p>'), '<p>Complete with cables, connections</p>');
  assert.equal(clean('<li>Look like new 7890A GC</li>'), null, 'a short claim line goes whole');
  assert.equal(clean('<p>Part number: G1322-60001 We do have most other parts for the Agilent degasser modules: G1322</p>'), '<p>Part number: G1322-60001</p>', 'run-together lines: the claim sentence takes the rest of the line');
});
