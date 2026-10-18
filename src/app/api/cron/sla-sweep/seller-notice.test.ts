import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sellerSlaNotice } from './seller-notice';

test('supplier SLA notice: names the request like the supplier inbox, never the buyer or the priority', () => {
  const full = sellerSlaNotice({ ref: 'PRO-2026-ABC123', productTitle: 'Centrifuge 5810 R', productCategory: 'Centrifuges' }, '1h 35m');
  assert.deepEqual(full, {
    subject: 'Centrifuge 5810 R',
    title: 'A buyer is waiting · PRO-2026-ABC123',
    body: '“Centrifuge 5810 R” — reply time passed 1h 35m ago',
  });
  assert.equal(sellerSlaNotice({ ref: 'Q-1', productTitle: null, productCategory: 'Pipettes' }, '5m').subject, 'Pipettes');
  // No product and no category: a neutral name, never "from <buyer>".
  const bare = sellerSlaNotice({ ref: 'Q-2', productTitle: null, productCategory: '' }, '2h');
  assert.equal(bare.subject, 'General sourcing request');
  for (const text of [bare.title, bare.body]) {
    assert.doesNotMatch(text, /\bfrom\b|SLA|VIP|URGENT|HIGH/);
  }
});
