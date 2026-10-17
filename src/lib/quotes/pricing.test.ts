import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMarkup, fillPaymentTermsText, incotermLabel, offerAmounts, parseOfferTerms, parseSlaHours, pctLabel, previewTax } from './pricing';
import { offerPhase } from './offer';

test('supplier price + margin, rounded UP to the configured step', () => {
  assert.equal(applyMarkup(1_000_000, 1500, 'NONE'), 1_150_000); // €10,000 + 15% = €11,500
  assert.equal(applyMarkup(1_000_099, 1500, 'NONE'), 1_150_114); // cents kept
  assert.equal(applyMarkup(1_000_099, 1500, 'WHOLE'), 1_150_200); // → €11,502
  assert.equal(applyMarkup(1_000_099, 1500, 'TEN'), 1_151_000);   // → €11,510
  assert.equal(applyMarkup(1_000_099, 1500, 'HUNDRED'), 1_160_000); // → €11,600
  assert.equal(applyMarkup(50_000, 0, 'WHOLE'), 50_000);
});

test('SLA hours per priority; NORMAL always present', () => {
  assert.deepEqual(parseSlaHours('VIP:2,URGENT:2,HIGH:8,NORMAL:24,LOW:72'), { VIP: 2, URGENT: 2, HIGH: 8, NORMAL: 24, LOW: 72 });
  assert.equal(parseSlaHours('vip:1, bogus, HIGH:x').NORMAL, 24);
  assert.equal(parseSlaHours('vip:1').VIP, 1);
});

test('offer snapshot: decided VAT → gross total; undecided → net total "excl. VAT"', () => {
  const decided = offerAmounts({ quotedPriceCents: 820_000, offerSubtotalCents: 820_000, offerShippingCents: 35_000, offerVatTreatment: 'DOMESTIC_STANDARD', offerVatRateBp: 2100, offerVatCents: 179_550, offerTotalCents: 1_034_550 });
  assert.equal(decided.vatDecided, true);
  assert.equal(decided.totalCents, 1_034_550);
  assert.equal(decided.netCents, 855_000);
  const open = offerAmounts({ quotedPriceCents: 820_000, offerSubtotalCents: 820_000, offerShippingCents: 35_000, offerVatTreatment: null, offerVatCents: null, offerTotalCents: null });
  assert.equal(open.vatDecided, false);
  assert.equal(open.totalCents, 855_000);
  // Legacy offer without a snapshot: only the price, VAT at acceptance — never a live global rate.
  const legacy = offerAmounts({ quotedPriceCents: 123_400 });
  assert.equal(legacy.totalCents, 123_400);
  assert.equal(legacy.vatDecided, false);
});

test('a settings change can not move an offer: the stored totals are what the buyer sees', () => {
  const snap = { quotedPriceCents: 100_000, offerSubtotalCents: 100_000, offerShippingCents: 0, offerVatTreatment: 'DOMESTIC_STANDARD', offerVatRateBp: 2100, offerVatCents: 21_000, offerTotalCents: 121_000 };
  // (nothing in offerAmounts reads process.env / settings)
  process.env.DEFAULT_TAX_PERCENT = '0';
  assert.equal(offerAmounts(snap).totalCents, 121_000);
  process.env.DEFAULT_TAX_PERCENT = '25';
  assert.equal(offerAmounts(snap).totalCents, 121_000);
});

test('offer terms JSON is read tolerantly; labels', () => {
  const t = parseOfferTerms({ qty: 2, unitCents: 50_000, incoterm: 'DAP', incotermPlace: 'Utrecht', leadTime: '3 weeks', warranty: '6 months', paymentTerms: { kind: 'PREPAY', days: 14, text: 'x' }, vatBasis: { status: 'DECIDED', country: 'NL', reasons: ['r'] } });
  assert.ok(t);
  assert.equal(t!.qty, 2);
  assert.equal(incotermLabel(t), 'DAP Utrecht (Incoterms® 2020)');
  assert.equal(parseOfferTerms(null), null);
  assert.equal(parseOfferTerms({})!.vatBasis.status, 'AT_ACCEPTANCE');
  assert.equal(fillPaymentTermsText('Pay within {DAYS} days.', 30), 'Pay within 30 days.');
  assert.equal(pctLabel(2100), '21%');
  assert.equal(pctLabel(2550), '25.5%');
  assert.equal(pctLabel(0), '0%');
  assert.equal(previewTax(100_000, 10_000, 2100, 2100), 23_100);
  assert.equal(previewTax(100_000, 10_000, 0, 0), 0);
});

test('offer phase: a void legacy offer (its order canceled) can not be accepted', () => {
  const sr = { status: 'RESPONDED', quotedPriceCents: 100_000, validUntilAt: new Date(Date.now() + 86_400_000) };
  assert.equal(offerPhase(sr, null), 'open');
  assert.equal(offerPhase(sr, { status: 'CANCELED' }), 'void');
  assert.equal(offerPhase(sr, { status: 'PENDING_PAYMENT', paymentSubmittedAt: new Date() }), 'accepted');
  assert.equal(offerPhase({ ...sr, validUntilAt: new Date(Date.now() - 1000) }, null), 'expired');
  assert.equal(offerPhase({ ...sr, status: 'DECLINED' }, null), 'void');
});
