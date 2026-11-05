import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideVat, DEFAULT_VAT_SETTINGS as S, vatCents } from './vat';

const valid = (vatId: string) => ({ vatId, status: 'VALID' as const, name: 'X GmbH' });

test('NL buyer pays 21%', () => {
  const d = decideVat({ country: 'NL', vatId: 'NL123456789B01' }, S);
  assert.equal(d.treatment, 'DOMESTIC');
  assert.equal(d.rateBp, 2100);
});

test('unknown country uses the default (21% NL)', () => {
  const d = decideVat({ country: '' }, S);
  assert.equal(d.treatment, 'DOMESTIC');
  assert.equal(d.rateBp, 2100);
  const e = decideVat({ country: null }, { ...S, defaultTreatment: 'EXPORT' });
  assert.equal(e.treatment, 'EXPORT');
  assert.equal(e.rateBp, 0);
});

test('EU business with VIES-valid VAT ID gets reverse charge', () => {
  const d = decideVat({ country: 'DE', vatId: 'DE 123 456 789', vies: valid('DE123456789') }, S);
  assert.equal(d.treatment, 'REVERSE_CHARGE');
  assert.equal(d.rateBp, 0);
});

test('VIES invalid → 21%', () => {
  const d = decideVat({ country: 'DE', vatId: 'DE123456789', vies: { vatId: 'DE123456789', status: 'INVALID' } }, S);
  assert.equal(d.treatment, 'DOMESTIC');
});

test('VIES down → policy decides', () => {
  const down = { vatId: 'DE123456789', status: 'UNAVAILABLE' as const, error: 'MS_UNAVAILABLE' };
  assert.equal(decideVat({ country: 'DE', vatId: 'DE123456789', vies: down }, S).treatment, 'REVIEW');
  assert.equal(decideVat({ country: 'DE', vatId: 'DE123456789', vies: down }, { ...S, viesDownPolicy: 'CHARGE_HOME' }).treatment, 'DOMESTIC');
  const b = decideVat({ country: 'DE', vatId: 'DE123456789', vies: down }, { ...S, viesDownPolicy: 'BLOCK' });
  assert.equal(b.treatment, 'REVIEW');
  assert.equal(b.blocked, true);
});

test('VIES evidence for another VAT ID is ignored', () => {
  const d = decideVat({ country: 'DE', vatId: 'DE123456789', vies: valid('DE999999999') }, S);
  assert.equal(d.treatment, 'REVIEW');
});

test('EU buyer without VAT ID or with an NL VAT ID → 21%', () => {
  assert.equal(decideVat({ country: 'BE' }, S).treatment, 'DOMESTIC');
  assert.equal(decideVat({ country: 'BE', vatId: 'NL123456789B01', vies: valid('NL123456789B01') }, S).treatment, 'DOMESTIC');
});

test('outside the EU → export 0% (or 21% when switched off)', () => {
  assert.equal(decideVat({ country: 'US' }, S).treatment, 'EXPORT');
  assert.equal(decideVat({ country: 'CH', vatId: 'CHE-123' }, S).treatment, 'EXPORT');
  assert.equal(decideVat({ country: 'US' }, { ...S, exportZeroEnabled: false }).treatment, 'DOMESTIC');
});

test('without the VIES requirement a well-formed ID is enough', () => {
  assert.equal(decideVat({ country: 'FR', vatId: 'FR12345678901' }, { ...S, requireVies: false }).treatment, 'REVERSE_CHARGE');
  assert.equal(decideVat({ country: 'FR', vatId: 'FR123' }, { ...S, requireVies: false }).treatment, 'DOMESTIC');
});

test('auto-decide off → always the default', () => {
  assert.equal(decideVat({ country: 'US' }, { ...S, autoDecide: false }).treatment, 'DOMESTIC');
});

test('rate setting and rounding', () => {
  assert.equal(decideVat({ country: 'NL' }, { ...S, standardRatePct: 9 }).rateBp, 900);
  assert.equal(vatCents(1_185_000 + 37_000 + 9_500, 2100), 258_615);
  assert.equal(vatCents(5, 2100), 1); // 1.05 → 1
  assert.equal(vatCents(10, 2100), 2); // 2.1 → 2
});
