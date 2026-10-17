import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCountry, type CountryPolicyRow } from './country';

const rows: CountryPolicyRow[] = [
  { country: 'NL', name: 'Netherlands', isEu: true, mode: 'ALLOW', note: null },
  { country: 'IR', name: 'Iran', isEu: false, mode: 'REVIEW', note: 'screen end user' },
  { country: 'RU', name: 'Russia', isEu: false, mode: 'BLOCK', note: 'sanctions' },
];

test('table modes are applied as configured', () => {
  assert.equal(decideCountry('nl', rows, 'REVIEW').mode, 'ALLOW');
  const ir = decideCountry('IR', rows, 'REVIEW');
  assert.equal(ir.mode, 'REVIEW');
  assert.match(ir.reason, /reviewed/);
  const ru = decideCountry('RU', rows, 'REVIEW');
  assert.equal(ru.mode, 'BLOCK');
  assert.match(ru.reason, /cannot/);
});

test('unknown countries follow the unknown-country policy', () => {
  assert.equal(decideCountry('KP', rows, 'REVIEW').mode, 'REVIEW');
  assert.equal(decideCountry('KP', rows, 'BLOCK').mode, 'BLOCK');
  assert.equal(decideCountry('KP', rows, 'BLOCK').known, false);
});

test('garbage codes (__, XXX, empty) are blocked, never shipped to', () => {
  for (const c of ['__', 'XXX', '', null, 'N1']) assert.equal(decideCountry(c, rows, 'REVIEW').mode, 'BLOCK', String(c));
});
