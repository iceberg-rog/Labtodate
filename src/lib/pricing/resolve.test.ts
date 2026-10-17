import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSellPrice, assertBuyable, roundPrice } from './resolve';

const p = (o: Partial<Parameters<typeof resolveSellPrice>[0]> = {}) => ({
  priceCents: 100_000, currency: 'EUR', mode: 'HYBRID' as const, status: 'PUBLISHED', quantity: 1, ...o,
});

test('pass-through: shown and charged price are the base price', () => {
  const r = resolveSellPrice(p(), { pricingMode: 'PASS_THROUGH', pricingMarkupBp: 0 });
  assert.equal(r.sellPriceCents, 100_000);
  assert.equal(r.buyable, true);
  assert.deepEqual(assertBuyable(r), { ok: true, priceCents: 100_000 });
});

test('markup is applied to the price that is SHOWN and CHARGED (same number)', () => {
  const r = resolveSellPrice(p(), { pricingMode: 'MARKUP_PERCENT', pricingMarkupBp: 1500 });
  assert.equal(r.basePriceCents, 100_000);
  assert.equal(r.sellPriceCents, 115_000);
  assert.equal(r.appliedMarkupBp, 1500);
  assert.deepEqual(assertBuyable(r), { ok: true, priceCents: 115_000 });
});

test('negative markup is a discount, never more than the base', () => {
  const r = resolveSellPrice(p(), { pricingMode: 'MARKUP_PERCENT', pricingMarkupBp: -1000 });
  assert.equal(r.sellPriceCents, 90_000);
});

test('FORCE_QUOTE and HIDE_PRICE can never be bought at a hidden price', () => {
  for (const mode of ['FORCE_QUOTE', 'HIDE_PRICE'] as const) {
    const r = resolveSellPrice(p({ mode: 'BUY_NOW' }), { pricingMode: mode, pricingMarkupBp: 0 });
    assert.equal(r.sellPriceCents, null, mode);
    assert.equal(r.priceVisible, false, mode);
    assert.equal(r.buyable, false, mode);
    assert.equal(r.mode, 'QUOTE_ONLY', mode);
    assert.equal(r.quotable, true, mode);
    assert.equal(assertBuyable(r).ok, false, mode);
  }
});

test('quote-only products, missing prices, sold-out and unpublished items are not buyable', () => {
  assert.equal(resolveSellPrice(p({ mode: 'QUOTE_ONLY' }), null).buyable, false);
  const noPrice = resolveSellPrice(p({ priceCents: null }), null);
  assert.equal(noPrice.buyable, false);
  assert.equal(noPrice.mode, 'QUOTE_ONLY');
  const sold = resolveSellPrice(p({ quantity: 0 }), null);
  assert.equal(sold.buyable, false);
  assert.equal(sold.soldOut, true);
  const draft = resolveSellPrice(p({ status: 'DRAFT' }), null);
  assert.equal(draft.buyable, false);
  assert.equal(draft.quotable, false);
});

test('rounding rules', () => {
  assert.equal(roundPrice(123_456, 'NONE'), 123_456);
  assert.equal(roundPrice(123_456, 'WHOLE_EURO'), 123_500);
  assert.equal(roundPrice(123_456, 'TEN_EURO'), 123_000);
  assert.equal(roundPrice(123_456, 'CHARM_99'), 123_499);
  const r = resolveSellPrice(p({ priceCents: 99_999 }), { pricingMode: 'MARKUP_PERCENT', pricingMarkupBp: 1000 }, { rounding: 'WHOLE_EURO' });
  assert.equal(r.sellPriceCents, 110_000);
});

test('a price on hold for review (8f) is never shown, bought or charged — in every shop rule', () => {
  for (const shop of [null, { pricingMode: 'PASS_THROUGH' as const, pricingMarkupBp: 0 }, { pricingMode: 'MARKUP_PERCENT' as const, pricingMarkupBp: 1000 }]) {
    const r = resolveSellPrice(p({ priceOnHold: true }), shop);
    assert.equal(r.sellPriceCents, null);
    assert.equal(r.priceVisible, false);
    assert.equal(r.buyable, false);
    assert.equal(r.quotable, true);
    assert.equal(r.mode, 'QUOTE_ONLY');
    assert.match(r.reasons[0] ?? '', /being confirmed/);
  }
  assert.equal(resolveSellPrice(p({ priceOnHold: false }), null).buyable, true);
});
