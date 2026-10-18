// Server modules import lib/auth-server (React `cache`): the project's test shim provides it outside Next.
import '../../../scripts/react-cache-shim.cjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyerHoldText, holdReleaseOutcome, sellerDetailsHoldOnly } from './holds';

const SELLER_NOTE = 'No proforma (payment request) issued for order L2D-2026-K7Q2M4: the seller details are incomplete — missing IBAN (Settings → Payments & credit terms).';

test('last hold released while the seller details are incomplete: not payable, the buyer is not told to pay, staff are told why', () => {
  const r = holdReleaseOutcome('SHIPPING_PENDING', { emailed: false, proforma: null, note: SELLER_NOTE, code: 'SELLER_INCOMPLETE' });
  assert.equal(r.payable, false);
  assert.match(r.message, /^Shipping cost to be confirmed released, but the order is on hold again/);
  assert.match(r.message, /Settings → Company \/ Payments & credit terms/);
  assert.match(r.message, /Nothing is due for the buyer and nothing was e-mailed\./);
  assert.ok(r.message.includes('missing IBAN'));
  assert.doesNotMatch(r.message, /now payable|could NOT be sent/);
});

test('last hold released with a proforma: payable, the staff message names the proforma and the mail', () => {
  const ok = holdReleaseOutcome('VAT_REVIEW', { emailed: true, proforma: 'PF-2026-00031', note: null, code: null });
  assert.equal(ok.payable, true);
  assert.equal(ok.message, 'VAT to be confirmed released — the order is now payable. Proforma PF-2026-00031 emailed to the buyer.');
  const bounced = holdReleaseOutcome('COMPLIANCE', { emailed: false, proforma: 'PF-2026-00032', note: null, code: null });
  assert.match(bounced.message, /could NOT be sent — contact them\.$/);
});

test('“payment details being prepared” only when the seller-details hold is the only pre-payment hold of an unpaid order', () => {
  assert.equal(sellerDetailsHoldOnly({ status: 'PENDING_PAYMENT', openHolds: ['INVOICE_PENDING'], holdReason: 'INVOICE_PENDING' }), true);
  // A shipping / VAT / compliance hold as well: the total is not final yet.
  assert.equal(sellerDetailsHoldOnly({ status: 'PENDING_PAYMENT', openHolds: ['SHIPPING_PENDING', 'INVOICE_PENDING'], holdReason: 'SHIPPING_PENDING' }), false);
  assert.equal(sellerDetailsHoldOnly({ status: 'PENDING_PAYMENT', openHolds: [], holdReason: 'COMPLIANCE' }), false);
  // A paid order whose invoice is withheld is not waiting for payment details.
  assert.equal(sellerDetailsHoldOnly({ status: 'PAID', openHolds: ['INVOICE_PENDING'], holdReason: 'INVOICE_PENDING' }), false);
});

test('the INVOICE_PENDING buyer text is a setting: payment details on an unpaid order, the invoice on a paid one', () => {
  delete process.env.CHECKOUT_MSG_PAYMENT_DETAILS_PENDING;
  const unpaid = buyerHoldText('INVOICE_PENDING', { status: 'PENDING_PAYMENT' });
  assert.equal(unpaid.title, 'Payment details being prepared');
  assert.match(unpaid.template, /^Our team is completing the payment details for this order\. Nothing is due yet/);
  assert.notEqual(unpaid.template, unpaid.title);
  const paid = buyerHoldText('INVOICE_PENDING', { status: 'PAID' });
  assert.equal(paid.title, 'Invoice being prepared');
  assert.match(paid.template, /^Your invoice is being prepared/);
  process.env.CHECKOUT_MSG_PAYMENT_DETAILS_PENDING = 'Wij ronden de betaalgegevens af.';
  try {
    assert.equal(buyerHoldText('INVOICE_PENDING', { status: 'PENDING_PAYMENT' }).template, 'Wij ronden de betaalgegevens af.');
  } finally {
    delete process.env.CHECKOUT_MSG_PAYMENT_DETAILS_PENDING;
  }
  // The other holds keep their own settings.
  assert.equal(buyerHoldText('SHIPPING_PENDING', { status: 'PENDING_PAYMENT' }).title, 'Shipping cost to be confirmed');
});
