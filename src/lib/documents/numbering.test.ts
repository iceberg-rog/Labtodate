import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPattern, DEFAULT_NUMBERING, formatNumber } from './numbering';

const d = new Date('2026-12-31T23:30:00Z'); // already 1 January 2027 in Amsterdam

test('formats tokens in the business time zone', () => {
  assert.equal(formatNumber('INV-{YYYY}-{SEQ:5}', 12, d), 'INV-2027-00012');
  assert.equal(formatNumber('Q{YY}{MM}/{SEQ:3}', 7, d), 'Q2701/007');
  assert.match(formatNumber('L2D-{YYYY}-{RAND:6}', null, d), /^L2D-2027-[2-9A-HJ-NP-Z]{6}$/);
});

test('defaults are valid', () => {
  assert.deepEqual(checkPattern('QUOTE', DEFAULT_NUMBERING.QUOTE), []);
  assert.deepEqual(checkPattern('INVOICE', DEFAULT_NUMBERING.INVOICE), []);
  assert.deepEqual(checkPattern('RECEIPT', DEFAULT_NUMBERING.RECEIPT), []);
  assert.deepEqual(checkPattern('ORDER', DEFAULT_NUMBERING.ORDER), []);
});

test('invoice numbers must be consecutive and unique per year', () => {
  assert.ok(checkPattern('INVOICE', { pattern: 'INV-{RAND:6}' }).length > 0);
  assert.ok(checkPattern('INVOICE', { pattern: 'INV-{SEQ:5}', yearlyReset: true }).length > 0);
  assert.deepEqual(checkPattern('INVOICE', { pattern: 'INV-{SEQ:5}', yearlyReset: false }), []);
  assert.ok(checkPattern('INVOICE', { pattern: 'INV {SEQ:5}' }).length > 0); // space not allowed
  assert.ok(checkPattern('INVOICE', { pattern: 'INV-{SEQ5}' }).length > 0); // unknown token
});

test('order numbers need a random part', () => {
  assert.ok(checkPattern('ORDER', { pattern: 'LTD-{YYYY}' }).length > 0);
  assert.ok(checkPattern('ORDER', { pattern: 'LTD-{RAND:3}' }).length > 0);
  assert.deepEqual(checkPattern('ORDER', { pattern: 'LTD-{YY}{MM}-{RAND:6}' }), []);
});
