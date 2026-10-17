import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteShipping, zoneFor, type ShippingSettings, type ZoneRow, type RateRow } from './quote';

const s: ShippingSettings = { mode: 'ZONE_TABLE', flatCents: 0, unmatched: 'TO_BE_CONFIRMED', defaultClass: 'FREIGHT_QUOTE', handlingCents: 0, freeAboveCents: null };
const rate = (o: Partial<RateRow>): RateRow => ({
  id: 'r', name: 'rate', shippingClass: 'PARCEL', basis: 'FLAT', amountCents: 1500, currency: 'EUR', freeAboveCents: null,
  handlingCents: 0, minKg: null, maxKg: null, leadTimeText: null, active: true, ...o,
});
const zones: ZoneRow[] = [
  { id: 'nl', name: 'Netherlands', countries: ['NL'], active: true, sortOrder: 0, rates: [
    rate({ id: 'nl-parcel', name: 'PostNL parcel', amountCents: 1295, leadTimeText: '1–2 days' }),
    rate({ id: 'nl-pallet', name: 'Pallet NL', shippingClass: 'PALLET', amountCents: 9500 }),
  ] },
  { id: 'eu', name: 'EU', countries: ['DE', 'BE', 'FR'], active: true, sortOrder: 1, rates: [
    rate({ id: 'eu-kg', name: 'DHL per kg', basis: 'PER_KG', amountCents: 250, minKg: 0, maxKg: 30 }),
  ] },
  { id: 'old', name: 'Old zone', countries: ['US'], active: false, sortOrder: 2, rates: [rate({ id: 'us' })] },
];

test('zone lookup: listed country, inactive zones ignored, * as fallback', () => {
  assert.equal(zoneFor('nl', zones)?.id, 'nl');
  assert.equal(zoneFor('US', zones), null);
  assert.equal(zoneFor('US', [...zones, { id: 'w', name: 'World', countries: ['*'], active: true, sortOrder: 9, rates: [] }])?.id, 'w');
});

test('parcel to NL is quoted from the table', () => {
  const q = quoteShipping({ country: 'NL', currency: 'EUR', lines: [{ qty: 1, shippingClass: 'PARCEL', valueCents: 50_000 }] }, s, zones);
  assert.equal(q.status, 'QUOTED');
  assert.equal(q.status === 'QUOTED' && q.amountCents, 1295);
  assert.equal(q.status === 'QUOTED' && q.leadTimeText, '1–2 days');
});

test('per-kg rate uses the weight; unknown weight is never guessed', () => {
  const ok = quoteShipping({ country: 'DE', currency: 'EUR', lines: [{ qty: 2, shippingClass: 'PARCEL', weightKg: 4.2, valueCents: 1000 }] }, s, zones);
  assert.equal(ok.status === 'QUOTED' && ok.amountCents, 250 * 9); // 8.4 kg → 9 kg
  const unknown = quoteShipping({ country: 'DE', currency: 'EUR', lines: [{ qty: 1, shippingClass: 'PARCEL', weightKg: null, valueCents: 1000 }] }, s, zones);
  assert.equal(unknown.status, 'TO_BE_CONFIRMED');
});

test('freight items and uncovered countries are “to be confirmed” (or refused by setting), never €0', () => {
  const freight = quoteShipping({ country: 'NL', currency: 'EUR', lines: [{ qty: 1, shippingClass: null, valueCents: 1000 }] }, s, zones);
  assert.equal(freight.status, 'TO_BE_CONFIRMED');
  const us = quoteShipping({ country: 'US', currency: 'EUR', lines: [{ qty: 1, shippingClass: 'PARCEL', valueCents: 1000 }] }, s, zones);
  assert.equal(us.status, 'TO_BE_CONFIRMED');
  const refused = quoteShipping({ country: 'US', currency: 'EUR', lines: [{ qty: 1, shippingClass: 'PARCEL', valueCents: 1000 }] }, { ...s, unmatched: 'NOT_SHIPPABLE' }, zones);
  assert.equal(refused.status, 'NOT_SHIPPABLE');
  const noCountry = quoteShipping({ country: null, currency: 'EUR', lines: [{ qty: 1, shippingClass: 'PARCEL', valueCents: 1000 }] }, s, zones);
  assert.equal(noCountry.status, 'TO_BE_CONFIRMED');
});

test('mixed classes add up; handling and free-shipping thresholds apply', () => {
  const lines = [{ qty: 1, shippingClass: 'PARCEL' as const, valueCents: 1000 }, { qty: 1, shippingClass: 'PALLET' as const, valueCents: 1000 }];
  const q = quoteShipping({ country: 'NL', currency: 'EUR', lines }, { ...s, handlingCents: 500 }, zones);
  assert.equal(q.status === 'QUOTED' && q.amountCents, 1295 + 9500 + 500);
  const free = quoteShipping({ country: 'NL', currency: 'EUR', lines }, { ...s, freeAboveCents: 1500 }, zones);
  assert.equal(free.status === 'QUOTED' && free.amountCents, 0);
});

test('flat mode charges the flat amount', () => {
  const q = quoteShipping({ country: 'US', currency: 'EUR', lines: [{ qty: 1, valueCents: 1 }] }, { ...s, mode: 'FLAT', flatCents: 2500 }, []);
  assert.equal(q.status === 'QUOTED' && q.amountCents, 2500);
});

test('a rate in another currency is not silently applied', () => {
  const usd = [{ ...zones[0], rates: [rate({ currency: 'USD' })] }];
  const q = quoteShipping({ country: 'NL', currency: 'EUR', lines: [{ qty: 1, shippingClass: 'PARCEL', valueCents: 1 }] }, s, usd);
  assert.equal(q.status, 'TO_BE_CONFIRMED');
});
