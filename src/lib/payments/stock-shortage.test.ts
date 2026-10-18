import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onStockShortage, stockShortageText } from './stock-shortage';

test('stock shortage: one buyer text with the amount, order and value date filled in', () => {
  const t = stockShortageText({ orderNumber: 'L2D-2026-ABC123', currency: 'EUR', amountCents: 121000, valueDate: new Date('2026-10-16T12:00:00Z') });
  assert.match(t.text, /L2D-2026-ABC123/);
  assert.match(t.text, /1[.,]210[.,]00/);
  assert.match(t.text, /16 Oct 2026/);
  assert.doesNotMatch(t.text, /\{[A-Z_]+\}/);
  // No "being prepared for shipping": the invoice follows the decision.
  assert.doesNotMatch(t.text, /prepar/i);
  assert.match(t.html, /<strong>L2D-2026-ABC123<\/strong>/);
});

test('stock shortage: on the hold list or as the primary hold', () => {
  assert.equal(onStockShortage({ openHolds: ['STOCK_SHORTAGE'], holdReason: null }), true);
  assert.equal(onStockShortage({ openHolds: [], holdReason: 'STOCK_SHORTAGE' }), true);
  assert.equal(onStockShortage({ openHolds: ['VAT_REVIEW'], holdReason: 'VAT_REVIEW' }), false);
});
