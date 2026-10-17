import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyerCancelExplanation } from './cancel-reason';

test('cancel explanation names the real reason', () => {
  assert.deepEqual(
    buyerCancelExplanation({ quote: { status: 'CLOSED', lostReason: 'Canceled by the buyer: Found a better offer', lostNote: 'Local supplier.' } }),
    { title: 'You canceled this order.', detail: 'Reason: Found a better offer.' },
  );
  assert.deepEqual(
    buyerCancelExplanation({ quote: { status: 'CLOSED', lostReason: 'Not paid by the due date', lostNote: null }, proformaVoidReason: 'Order canceled: Not paid by the due date (29 Sept 2026, plus 3 days grace)' }),
    { title: 'This order was canceled because it was not paid in time.', detail: 'Not paid by the due date (29 Sept 2026, plus 3 days grace).' },
  );
  assert.deepEqual(
    buyerCancelExplanation({ quote: { status: 'CLOSED', lostReason: 'Canceled by lab2date after acceptance', lostNote: 'Unit failed our final inspection — sorry.' } }),
    { title: 'Our team canceled this order.', detail: 'Reason: Unit failed our final inspection — sorry.' },
  );
  assert.equal(buyerCancelExplanation({ quote: { status: 'DECLINED', lostReason: 'Price too high', lostNote: null } }).title, 'You declined the offer, so this order was canceled.');
  assert.deepEqual(buyerCancelExplanation({ quote: null, proformaVoidReason: null }), { title: 'This order was canceled.', detail: null });
  // checkout order canceled by the buyer (no quote): admin notes carry it
  assert.equal(buyerCancelExplanation({ quote: null, adminNotes: '[2026-10-03] Canceled by the buyer: x' }).title, 'You canceled this order.');
});
