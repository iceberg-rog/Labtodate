import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWarranty, resolveInspection, orderLineTruthSnapshot, DEFAULT_WARRANTY_FALLBACK_TEXT } from '../../src/lib/catalog/warranty';

const usedNone = { label: 'Used', defaultWarrantyMonths: null, warrantyScope: null };
const refurb6 = { label: 'Refurbished', defaultWarrantyMonths: 6, warrantyScope: 'parts and labour' };

test('no item warranty and no condition default → fallback text, no warranty', () => {
  const w = resolveWarranty({ warrantyMonths: null, warrantyText: null }, usedNone);
  assert.equal(w.hasWarranty, false);
  assert.equal(w.source, 'NONE');
  assert.equal(w.headline, DEFAULT_WARRANTY_FALLBACK_TEXT);
  assert.equal(w.months, 0);
});

test('condition default applies when the item states nothing', () => {
  const w = resolveWarranty({ warrantyMonths: null, warrantyText: null }, refurb6);
  assert.equal(w.source, 'CONDITION');
  assert.equal(w.months, 6);
  assert.equal(w.full, '6-month warranty — parts and labour');
});

test('item months beat the condition default; item text is the scope', () => {
  const w = resolveWarranty({ warrantyMonths: 12, warrantyText: 'functional defects only' }, refurb6);
  assert.equal(w.source, 'ITEM');
  assert.equal(w.full, '12-month warranty — functional defects only');
});

test('item set to 0 = explicitly sold as-is, even if the condition has a default', () => {
  const w = resolveWarranty({ warrantyMonths: 0, warrantyText: 'sold for parts' }, refurb6, 'Sold as-is');
  assert.equal(w.hasWarranty, false);
  assert.equal(w.headline, 'Sold as-is');
  assert.equal(w.full, 'Sold as-is — sold for parts');
});

test('custom fallback text from settings; blank fallback falls back to the default text', () => {
  assert.equal(resolveWarranty({ warrantyMonths: null, warrantyText: null }, usedNone, 'No warranty').headline, 'No warranty');
  assert.equal(resolveWarranty({ warrantyMonths: null, warrantyText: null }, usedNone, '   ').headline, DEFAULT_WARRANTY_FALLBACK_TEXT);
});

test('inspection is claimed only with a date, and (by default) a report', () => {
  assert.equal(resolveInspection({ inspectedAt: null, inspectionReportUrl: '/r.pdf' }, true).claim, false);
  const noReport = resolveInspection({ inspectedAt: '2026-09-30', inspectionReportUrl: '' }, true);
  assert.equal(noReport.claim, false);
  assert.equal(noReport.reason, 'NO_REPORT');
  assert.equal(resolveInspection({ inspectedAt: '2026-09-30', inspectionReportUrl: '' }, false).claim, true);
  assert.equal(resolveInspection({ inspectedAt: new Date('2026-09-30'), inspectionReportUrl: '/r.pdf' }, true).claim, true);
  assert.equal(resolveInspection({ inspectedAt: 'not a date', inspectionReportUrl: '/r.pdf' }, true).claim, false);
});

test('order line snapshot freezes condition label and warranty sentence', () => {
  const snap = orderLineTruthSnapshot({ warrantyMonths: null, warrantyText: null }, refurb6);
  assert.deepEqual(snap, { conditionSnapshot: 'Refurbished', warrantySnapshot: '6-month warranty — parts and labour', warrantyMonthsSnapshot: 6 });
  const none = orderLineTruthSnapshot({ warrantyMonths: null, warrantyText: null }, usedNone);
  assert.equal(none.warrantyMonthsSnapshot, 0);
  assert.equal(none.warrantySnapshot, DEFAULT_WARRANTY_FALLBACK_TEXT);
});
