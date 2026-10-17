import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingAddressJson, detailsDiffer, detailsSummary, orderDetailsProblems, parseDetailsInput, prefillDetails, shippingAddressJson } from './details';

const base = {
  b_legalName: 'آزمایشگاه پارس B.V.', b_contactName: 'Dr. A', b_vatId: 'nl 8598.76543.b01', b_line1: 'Keizersgracht 123', b_line2: 'طبقه دوم، واحد ۴',
  b_postalCode: '1015 CJ', b_city: 'Amsterdam', b_region: '', b_country: 'nl', b_phone: '+31 20 1234567', b_invoiceEmail: 'ap@example.org', b_poNumber: 'PO-2026-00471',
};

test('billing + "deliver to the billing address" parse into both blobs', () => {
  const r = parseDetailsInput({ ...base, d_same: 'on', d_name: 'Goods-in', d_phone: '+31 20 7654321' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.details.billing.vatId, 'NL859876543B01');
  assert.equal(r.details.billing.country, 'NL');
  assert.equal(r.details.delivery.sameAsBilling, true);
  assert.equal(r.details.delivery.line1, 'Keizersgracht 123');
  assert.equal(r.details.delivery.name, 'Goods-in');
  const bill = billingAddressJson(r.details.billing);
  const ship = shippingAddressJson(r.details.delivery);
  assert.deepEqual(orderDetailsProblems({ billingAddress: bill, shippingAddress: ship }), []);
  const sum = detailsSummary({ billingAddress: bill, shippingAddress: ship });
  assert.equal(sum.billing[0], 'آزمایشگاه پارس B.V.');
  assert.ok(sum.billing.includes('1015 CJ Amsterdam'));
  assert.equal(sum.po, 'PO-2026-00471');
});

test('missing fields come back per field, nothing is half-saved', () => {
  const r = parseDetailsInput({ ...base, b_legalName: '', b_city: '', d_same: '', d_name: '', d_phone: '12', d_line1: '', d_postalCode: '', d_city: '', d_country: '' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.fieldErrors.b_legalName);
  assert.ok(r.fieldErrors.b_city);
  assert.match(r.message, /Company \/ institution/);
});

test('a separate delivery address must be complete (carrier needs name, phone, street, postcode, city, country)', () => {
  const r = parseDetailsInput({ ...base, d_name: 'Lab 4', d_phone: '+49 30 123456', d_line1: 'Laborstrasse 5', d_postalCode: '10115', d_city: 'Berlin', d_country: 'de' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.details.delivery.country, 'DE');
  const bad = parseDetailsInput({ ...base, d_name: 'Lab 4', d_phone: '+49 30 123456', d_line1: 'Laborstrasse 5', d_postalCode: '10115', d_city: 'Berlin', d_country: 'Germany' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.fieldErrors.d_country);
});

test('bad VAT ID shape is refused with an example', () => {
  const r = parseDetailsInput({ ...base, b_vatId: '123456789', d_same: 'on', d_name: 'x y', d_phone: '+31 20 7654321' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.fieldErrors.b_vatId, /country code/);
});

test('problems: a checkout order with only a delivery address bills to it; a quote order without details lists both', () => {
  const ship = { name: 'Jan', phone: '+31 6 1', address: { line1: 'Teststraat 7', postal_code: '3511 AB', city: 'Utrecht', country: 'NL' } };
  assert.deepEqual(orderDetailsProblems({ billingAddress: null, shippingAddress: ship }), []);
  assert.deepEqual(orderDetailsProblems({ billingAddress: null, shippingAddress: null }), ['billing details', 'delivery address']);
  assert.ok(orderDetailsProblems({ billingAddress: null, shippingAddress: { ...ship, phone: '' } }).includes('delivery phone'));
});

test('prefill: order details > saved profile > the quote request company', () => {
  const p = prefillDetails({ profile: null, companyName: 'QA Lab BV', buyerName: 'QA Buyer' });
  assert.equal(p.b.legalName, 'QA Lab BV');
  assert.equal(p.b.contactName, 'QA Buyer');
  assert.equal(p.same, true);
  const q = prefillDetails({ profile: { legalName: 'Profile GmbH', contactName: null, vatId: 'DE123456789', address: { line1: 'A 1', postalCode: '10115', city: 'Berlin', country: 'DE' }, country: 'DE', phone: null, invoiceEmail: null }, companyName: 'QA Lab BV' });
  assert.equal(q.b.legalName, 'Profile GmbH');
  assert.equal(q.b.postalCode, '10115');
});

test('a change in printed details is detected (→ proforma revision)', () => {
  const a = { billingAddress: { company: 'X', address: { line1: 'A' } }, shippingAddress: { name: 'n', address: { line1: 'B' } } };
  assert.equal(detailsDiffer(a, JSON.parse(JSON.stringify(a))), false);
  assert.equal(detailsDiffer(a, { ...a, billingAddress: { company: 'Y', address: { line1: 'A' } } }), true);
});

test('VAT ID rule (DETAILS_VAT_ID_REQUIRED): EU buyers must give one, others may not have one', () => {
  const noVat = { ...base, b_vatId: '', d_same: 'on', d_name: 'Jan de Vries', d_phone: '+31 20 7654321' };
  const r = parseDetailsInput(noVat, { vatIdRule: 'EU' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.fieldErrors.b_vatId, /VAT ID/);
  assert.equal(parseDetailsInput(noVat, { vatIdRule: 'OFF' }).ok, true);
  assert.equal(parseDetailsInput(noVat).ok, true);
  // outside the EU: not required under "EU", required under "ALWAYS"
  const ch = { ...noVat, b_country: 'CH', b_postalCode: '4057', b_city: 'Basel' };
  assert.equal(parseDetailsInput(ch, { vatIdRule: 'EU' }).ok, true);
  assert.equal(parseDetailsInput(ch, { vatIdRule: 'ALWAYS' }).ok, false);
  const ship = { name: 'Jan', phone: '+31 6 12345678', address: { line1: 'Teststraat 7', postal_code: '3511 AB', city: 'Utrecht', country: 'NL' } };
  assert.deepEqual(orderDetailsProblems({ billingAddress: null, shippingAddress: ship }, { vatIdRule: 'EU' }), ['VAT ID']);
  assert.deepEqual(orderDetailsProblems({ billingAddress: null, shippingAddress: { ...ship, vat: 'NL859876543B01' } }, { vatIdRule: 'EU' }), []);
  assert.deepEqual(orderDetailsProblems({ billingAddress: null, shippingAddress: { ...ship, address: { ...ship.address, country: 'US' } } }, { vatIdRule: 'EU' }), []);
});

test('integration s2a+s2b: a CONSUMER checkout order never needs a VAT ID; a business order does (EU rule)', () => {
  const ship = { name: 'Jan', phone: '+31 6 1234 5678', address: { line1: 'Lab street 1', postal_code: '2333 AA', city: 'Leiden', country: 'NL' } };
  const bill = { name: 'Jan', email: 'jan@example.org', address: { line1: 'Lab street 1', postal_code: '2333 AA', city: 'Leiden', country: 'NL' } };
  assert.deepEqual(orderDetailsProblems({ billingAddress: bill, shippingAddress: ship, customerType: 'CONSUMER' }, { vatIdRule: 'EU' }), []);
  assert.deepEqual(orderDetailsProblems({ billingAddress: bill, shippingAddress: ship, customerType: 'BUSINESS' }, { vatIdRule: 'EU' }), ['VAT ID']);
  assert.deepEqual(orderDetailsProblems({ billingAddress: { ...bill, vat: 'NL859876543B01' }, shippingAddress: ship, customerType: 'BUSINESS' }, { vatIdRule: 'EU' }), []);
});

test('integration s2a+s2b: prefill / summary read the checkout PO + invoice-email columns', () => {
  const p = prefillDetails({ billingAddress: { company: 'BioLab BV', address: { line1: 'x 1', postal_code: '1', city: 'Leiden', country: 'NL' } }, poNumber: 'PO-77', invoiceEmail: 'ap@biolab.example' });
  assert.equal(p.b.poNumber, 'PO-77');
  assert.equal(p.b.invoiceEmail, 'ap@biolab.example');
  assert.equal(detailsSummary({ billingAddress: { company: 'BioLab BV' }, shippingAddress: null, poNumber: 'PO-77' }).po, 'PO-77');
});
