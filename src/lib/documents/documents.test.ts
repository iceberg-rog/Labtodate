import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDocNumber, fiscalYearOf } from './numbering';
import { chargedVat, splitGrossOverRows, negateLines, missingInvoiceDetails, partyFromAddress } from './snapshot';
import { fmtRate } from './render';

test('number format: prefix, fiscal year, zero-padded sequence', () => {
  assert.equal(formatDocNumber('{PREFIX}-{YYYY}-{SEQ:5}', { prefix: 'INV', fiscalYear: 2026, seq: 1 }), 'INV-2026-00001');
  assert.equal(formatDocNumber('{PREFIX}{YY}/{SEQ}', { prefix: 'CN', fiscalYear: 2026, seq: 42 }), 'CN26/42');
  assert.equal(formatDocNumber('{PREFIX}-{SEQ:3}', { prefix: 'PF', fiscalYear: 2026, seq: 12345 }), 'PF-12345');
});

test('fiscal year follows the Amsterdam calendar day and the start month', () => {
  // 31 Dec 23:30 UTC is already 1 January in Amsterdam.
  assert.equal(fiscalYearOf(new Date('2026-12-31T23:30:00Z')), 2027);
  assert.equal(fiscalYearOf(new Date('2026-12-31T22:30:00Z')), 2026);
  // Fiscal year starting in July is named after the year it starts in.
  assert.equal(fiscalYearOf(new Date('2027-03-01T12:00:00Z'), 7), 2026);
  assert.equal(fiscalYearOf(new Date('2027-07-01T12:00:00Z'), 7), 2027);
});

test('charged VAT is shown honestly: a clean rate, 0%, or no percentage at all (never 21.01%)', () => {
  // Legacy formula: 21% on the goods subtotal only, shipping untaxed.
  const a = chargedVat(199_999, 0, 42_000, 2100);
  assert.deepEqual(a.rows, [{ rateBp: 2100, baseCents: 199_999, taxCents: 42_000 }]);
  const b = chargedVat(100_000, 5_000, 21_000, 2100);
  assert.equal(b.rows.length, 2);
  assert.equal(b.shippingRateBp, 0);
  const zero = chargedVat(100_000, 0, 0, 2100);
  assert.deepEqual(zero.rows, [{ rateBp: 0, baseCents: 100_000, taxCents: 0 }]);
  // 33,333 at 21% is 6,999.93 → 7,000: printed as 21% (the old code derived 21.01%).
  assert.equal(chargedVat(33_333, 0, 7_000, 2100).rows[0].rateBp, 2100);
  const odd = chargedVat(33_333, 0, 7_100, 2100); // not a rate the settings produce
  assert.equal(odd.rows[0].rateBp, null);
  assert.equal(fmtRate(odd.rows[0].rateBp), '—');
  assert.equal(fmtRate(2100), '21%');
  assert.equal(fmtRate(2550), '25.5%');
});

test('partial credit is split over the VAT rows exactly to the cent', () => {
  const rows = [{ rateBp: 2100, baseCents: 100_000, taxCents: 21_000 }];
  const part = splitGrossOverRows(12_100, rows);
  assert.deepEqual(part, [{ rateBp: 2100, baseCents: 10_000, taxCents: 2_100 }]);
  const two = splitGrossOverRows(10_001, [{ rateBp: 2100, baseCents: 1000, taxCents: 210 }, { rateBp: 0, baseCents: 1000, taxCents: 0 }]);
  assert.equal(two.reduce((s, r) => s + r.baseCents + r.taxCents, 0), 10_001);
});

test('a full credit note mirrors the invoice lines negated', () => {
  const lines = negateLines([{ description: 'Centrifuge', detail: null, qty: 1, unitCents: 1000, netCents: 1000, vatRateBp: 2100, taxCents: 210, lineType: 'GOODS' }]);
  assert.equal(lines[0].qty, -1);
  assert.equal(lines[0].netCents, -1000);
  assert.equal(lines[0].taxCents, -210);
  assert.equal(lines[0].unitCents, 1000);
});

test('legal invoice details: what is missing is named', () => {
  const seller = { name: 'Lab BV', addressLines: ['Street 1'], country: 'Netherlands', city: '', kvk: '12345678', vatId: 'NL123456789B01', eori: '', email: '', phone: '', web: '', logoPath: '' };
  const buyer = partyFromAddress({ name: 'A. Buyer', company: 'Uni', address: { line1: 'Lab road 2', city: 'Delft', postal_code: '2600 AA', country: 'NL' } }, 'x')!;
  assert.deepEqual(missingInvoiceDetails({ seller, buyer, vat: { treatment: 'DOMESTIC_STANDARD', label: '', rows: [], legalText: null, buyerVatId: null, viesConsultation: null, pendingNote: null } }), []);
  const missing = missingInvoiceDetails({ seller: { ...seller, kvk: '', vatId: '' }, buyer: { ...buyer, lines: [] }, vat: { treatment: 'EU_ICS_ZERO', label: '', rows: [], legalText: null, buyerVatId: null, viesConsultation: null, pendingNote: null } });
  assert.equal(missing.length, 4);
  assert.ok(missing.some((m) => m.includes('KvK')));
  assert.ok(missing.some((m) => m.includes('buyer VAT ID')));
});
