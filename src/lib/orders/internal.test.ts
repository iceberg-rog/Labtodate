// Server modules import lib/auth-server (React `cache`): the project's test shim provides it outside Next.
import '../../../scripts/react-cache-shim.cjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentMail, orderDocumentRecipients, recipientsLabel } from './internal';

const proforma = {
  kind: 'PROFORMA' as const,
  number: 'PF-2026-00079',
  currency: 'EUR',
  dueDate: new Date('2026-11-01T23:59:59.999Z'),
  snapshot: {
    payment: { kind: 'INSTRUCTIONS', reference: 'PF-2026-00079', amountCents: 530_585, dueDate: '2026-11-01T23:59:59.999Z', bankAvailable: true },
    bank: { beneficiary: 'Labtodate B.V.', bankName: 'ABN AMRO', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' },
    totals: { totalCents: 530_585 },
  },
};

test('a proforma mail states the bank details, reference and pay-by date of the proforma itself', () => {
  const m = documentMail(proforma, { orderNumber: 'L2D-2026-G5M5Q6', buyerName: 'Ann', attached: true });
  assert.equal(m.subject, 'Proforma invoice PF-2026-00079 — order L2D-2026-G5M5Q6');
  assert.match(m.html, /NL91ABNA0417164300/);
  assert.match(m.html, /Pay by<\/td><td[^>]*><strong>1 Nov 2026<\/strong>/);
  assert.match(m.html, /€5,305\.85/);
  assert.match(m.html, /is attached \(PDF\)/);
  const again = documentMail(proforma, { orderNumber: 'L2D-2026-G5M5Q6', buyerName: 'Ann', attached: true, again: true });
  assert.match(again.html, /We are sending you proforma invoice <strong>PF-2026-00079<\/strong> for order <strong>L2D-2026-G5M5Q6<\/strong> again\./);
});

test('a paid invoice mail names the amount received (a written-off shortfall included)', () => {
  delete process.env.EMAIL_INVOICE_PAID_BODY;
  process.env.EMAIL_INVOICE_PAID_BODY = 'We received your payment of {AMOUNT} for order {ORDER}.';
  try {
    const m = documentMail(
      { kind: 'INVOICE', number: 'INV-2026-00012', currency: 'EUR', dueDate: null, snapshot: { payment: { kind: 'PAID', amountCents: 150_950, writtenOffCents: 300 }, totals: { totalCents: 151_250 } } },
      { orderNumber: 'L2D-2026-FKFE30', buyerName: null, attached: false },
    );
    assert.equal(m.subject, 'Invoice INV-2026-00012 — order L2D-2026-FKFE30 (paid)');
    assert.match(m.html, /We received your payment of <strong>€1,509\.50<\/strong>/);
    assert.match(m.html, /\/api\/documents\/doc\/INV-2026-00012\/pdf/);
  } finally {
    delete process.env.EMAIL_INVOICE_PAID_BODY;
  }
});

test('a credit note mail names the invoice it credits', () => {
  const m = documentMail(
    { kind: 'CREDIT_NOTE', number: 'CN-2026-00003', currency: 'EUR', dueDate: null, snapshot: { payment: { kind: 'CREDIT', originalNumber: 'INV-2026-00026' }, totals: { totalCents: -12_100 }, terms: ['We refund €121.00 by bank transfer.'] } },
      { orderNumber: 'L2D-2026-PHR1C8', buyerName: 'Bo', attached: true, again: true },
  );
  assert.equal(m.subject, 'Credit note CN-2026-00003 — order L2D-2026-PHR1C8');
  assert.match(m.html, /It credits invoice <strong>INV-2026-00026<\/strong> for <strong>€121\.00<\/strong>\./);
  assert.match(m.html, /We refund €121\.00 by bank transfer\./);
});

test('documents go to the accounts-payable address with a copy to the account', () => {
  process.env.INVOICE_EMAIL_CC_ACCOUNT = 'true';
  try {
    const r = orderDocumentRecipients({ invoiceEmail: 'ap@delft.example.org', billingAddress: null, buyer: { email: 'b1@delft.example.org' } });
    assert.deepEqual(r, { to: 'ap@delft.example.org', cc: ['b1@delft.example.org'] });
    assert.equal(recipientsLabel(r), 'ap@delft.example.org (copy to b1@delft.example.org)');
    // Older orders: the e-mail in the billing details.
    assert.equal(orderDocumentRecipients({ invoiceEmail: null, billingAddress: { email: 'finance@x.example.org' }, buyer: { email: 'b@x.example.org' } }).to, 'finance@x.example.org');
    assert.equal(recipientsLabel(orderDocumentRecipients({ invoiceEmail: null, billingAddress: null, buyer: { email: 'b@x.example.org' } })), 'b@x.example.org');
  } finally {
    delete process.env.INVOICE_EMAIL_CC_ACCOUNT;
  }
});

test('with “Also send invoices to the account email” off, the order confirmation (proforma mails) still reaches the account', () => {
  process.env.INVOICE_EMAIL_CC_ACCOUNT = 'false';
  try {
    const order = { invoiceEmail: 'ap@delft.example.org', billingAddress: null, buyer: { email: 'b1@delft.example.org' } };
    // Invoices / credit notes: the AP address only.
    assert.deepEqual(orderDocumentRecipients(order), { to: 'ap@delft.example.org', cc: [] });
    // Checkout confirmation, “you can now pay”, revisions, a proforma resend: the account always in copy.
    assert.deepEqual(orderDocumentRecipients(order, { alwaysCopyAccount: true }), { to: 'ap@delft.example.org', cc: ['b1@delft.example.org'] });
    // The same address twice is one mail; no AP address: the account itself.
    assert.deepEqual(orderDocumentRecipients({ ...order, invoiceEmail: 'B1@delft.example.org' }, { alwaysCopyAccount: true }), { to: 'B1@delft.example.org', cc: [] });
    assert.deepEqual(orderDocumentRecipients({ ...order, invoiceEmail: null }, { alwaysCopyAccount: true }), { to: 'b1@delft.example.org', cc: [] });
  } finally {
    delete process.env.INVOICE_EMAIL_CC_ACCOUNT;
  }
});
