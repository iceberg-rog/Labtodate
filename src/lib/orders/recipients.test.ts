import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingEmailOf, documentRecipients, paymentsInboxAddress } from './recipients';

test('the accounts-payable address gets the document, the account a copy when it differs', () => {
  assert.deepEqual(
    documentRecipients({ invoiceEmail: 'ap@lab.example.org', accountEmail: 'buyer@lab.example.org' }, { ccAccount: true }),
    { to: 'ap@lab.example.org', cc: ['buyer@lab.example.org'] },
  );
  // Same address (any case): no duplicate copy.
  assert.deepEqual(
    documentRecipients({ invoiceEmail: 'Buyer@Lab.example.org', accountEmail: 'buyer@lab.example.org' }, { ccAccount: true }),
    { to: 'Buyer@Lab.example.org', cc: [] },
  );
  // INVOICE_EMAIL_CC_ACCOUNT off: AP only.
  assert.deepEqual(
    documentRecipients({ invoiceEmail: 'ap@lab.example.org', accountEmail: 'buyer@lab.example.org' }, { ccAccount: false }),
    { to: 'ap@lab.example.org', cc: [] },
  );
});

test('older orders: the billing-details e-mail is the AP address; none at all → the account', () => {
  assert.deepEqual(
    documentRecipients({ invoiceEmail: null, billingEmail: 'finance@uni.example.org', accountEmail: 'buyer@uni.example.org' }, { ccAccount: true }),
    { to: 'finance@uni.example.org', cc: ['buyer@uni.example.org'] },
  );
  assert.deepEqual(documentRecipients({ invoiceEmail: '', billingEmail: 'not an e-mail', accountEmail: 'buyer@uni.example.org' }), { to: 'buyer@uni.example.org', cc: [] });
});

test('the copy follows INVOICE_EMAIL_CC_ACCOUNT when not given (default on)', () => {
  delete process.env.INVOICE_EMAIL_CC_ACCOUNT;
  assert.deepEqual(documentRecipients({ invoiceEmail: 'ap@x.example.org', accountEmail: 'b@x.example.org' }).cc, ['b@x.example.org']);
  process.env.INVOICE_EMAIL_CC_ACCOUNT = 'false';
  assert.deepEqual(documentRecipients({ invoiceEmail: 'ap@x.example.org', accountEmail: 'b@x.example.org' }).cc, []);
  delete process.env.INVOICE_EMAIL_CC_ACCOUNT;
});

test('billingEmailOf reads only a well-formed e-mail from the billing JSON', () => {
  assert.equal(billingEmailOf({ email: ' ap@x.example.org ' }), 'ap@x.example.org');
  assert.equal(billingEmailOf({ email: 'nope' }), null);
  assert.equal(billingEmailOf(null), null);
  assert.equal(billingEmailOf('ap@x.example.org'), null);
});

test('payment receipts go to PAYMENTS_INBOX_EMAIL, else the billing inbox, never a placeholder address', () => {
  process.env.PAYMENTS_INBOX_EMAIL = 'payments@labtodate.com';
  process.env.COMPANY_EMAIL = 'billing@labtodate.com';
  assert.equal(paymentsInboxAddress(), 'payments@labtodate.com');
  delete process.env.PAYMENTS_INBOX_EMAIL;
  assert.equal(paymentsInboxAddress(), 'billing@labtodate.com');
  process.env.COMPANY_EMAIL = 'billing@lab2date.local';
  assert.equal(paymentsInboxAddress(), null);
  delete process.env.COMPANY_EMAIL;
});
