import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextNumberNow, numberingConfigProblems, numberingFromValues, numberingLockProblems, type NumberingSettings } from './numbering';

const base = numberingFromValues({});

test('numbering config: defaults are valid', () => {
  assert.deepEqual(numberingConfigProblems(base), []);
});

test('numbering config: prefixes must differ (an invoice and a credit note could share a number)', () => {
  const p = numberingConfigProblems(numberingFromValues({ INVOICE_PREFIX: 'CN' }));
  assert.equal(p.length, 1);
  assert.match(p[0], /invoice and credit note prefixes would both be “CN”/);
  assert.equal(numberingConfigProblems(numberingFromValues({ PROFORMA_PREFIX: 'inv' })).length, 1, 'case-insensitive');
});

test('numbering config: a yearly restart needs the year in the number; {PREFIX} and {SEQ} are required', () => {
  assert.match(numberingConfigProblems(numberingFromValues({ INVOICE_NUMBER_FORMAT: '{PREFIX}-{SEQ:5}' })).join(' '), /year/);
  assert.deepEqual(numberingConfigProblems(numberingFromValues({ INVOICE_NUMBER_FORMAT: '{PREFIX}-{SEQ:5}', NUMBERING_RESET_YEARLY: 'false' })), []);
  assert.deepEqual(numberingConfigProblems(numberingFromValues({ INVOICE_NUMBER_FORMAT: '{PREFIX}{YY}{SEQ:4}' })), []);
  assert.match(numberingConfigProblems(numberingFromValues({ INVOICE_NUMBER_FORMAT: '{YYYY}-{SEQ:5}' })).join(' '), /\{PREFIX\}/);
});

test('numbering lock: fiscal-year start and yearly restart are locked once a series started', () => {
  const started = [{ series: 'INVOICE', fiscalYear: 2026, nextValue: 12 }];
  const month = numberingLockProblems(base, numberingFromValues({ FISCAL_YEAR_START_MONTH: '11' }), started);
  assert.equal(month.length, 1);
  assert.match(month[0], /locked/);
  const reset = numberingLockProblems(base, numberingFromValues({ NUMBERING_RESET_YEARLY: 'false' }), started);
  assert.equal(reset.length, 1);
  assert.deepEqual(numberingLockProblems(base, numberingFromValues({ FISCAL_YEAR_START_MONTH: '11' }), []), [], 'free before the first number');
  assert.deepEqual(numberingLockProblems(base, numberingFromValues({ INVOICE_PREFIX: 'FAC' }), started), [], 'a prefix change continues the same counter');
});

test('next number now = what allocateNumber returns (counter year, start number)', () => {
  const s: NumberingSettings = { ...base, start: { INVOICE: 1, CREDIT_NOTE: 1, PROFORMA: 100 } };
  const now = new Date('2026-10-03T10:00:00Z');
  assert.equal(nextNumberNow('INVOICE', s, [{ series: 'INVOICE', fiscalYear: 2026, nextValue: 12 }], now), 'INV-2026-00012');
  assert.equal(nextNumberNow('PROFORMA', s, [], now), 'PF-2026-00100');
  // continuous numbering uses counter year 0
  const c = { ...s, resetYearly: false };
  assert.equal(nextNumberNow('INVOICE', c, [{ series: 'INVOICE', fiscalYear: 2026, nextValue: 12 }, { series: 'INVOICE', fiscalYear: 0, nextValue: 3 }], now), 'INV-2026-00003');
  // fiscal year starting in November: October 2026 belongs to 2025
  assert.equal(nextNumberNow('INVOICE', { ...s, fiscalYearStartMonth: 11 }, [], now), 'INV-2025-00001');
});
