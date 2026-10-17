import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressGaps, baseForGross, chargedVat, creditableGross, missingInvoiceDetails, partyFromAddress, splitGrossOverRows, type DocumentSnapshot } from './snapshot';
import { renderDocumentHtml } from './render';
import { DOC_LABEL_DEFS, DOC_LABEL_KEYS, defaultDocLabel } from './labels';
import { paymentFacts, readableIssueError } from './issue';
import { Prisma } from '@prisma/client';
import { determineVat, type TaxSettings, type CountryFacts } from '../tax/determine';

const seller: DocumentSnapshot['seller'] = {
  name: 'lab2date B.V.', addressLines: ['Industrieweg 12', '2712 LB Zoetermeer'], country: 'Netherlands', city: 'Zoetermeer',
  kvk: '12345678', vatId: 'NL123456789B01', eori: '', email: 'billing@example.nl', phone: '', web: '', logoPath: '',
};

test('invoice details: a country alone is not an address (street, postcode and city are required)', () => {
  assert.deepEqual(addressGaps({ company: 'Country Only Lab B.V.', address: { country: 'NL' } }), ['street', 'postcode', 'city']);
  assert.deepEqual(addressGaps({ address: { line1: 'Science Park 904', postal_code: '1098 XH', city: 'Amsterdam', country: 'NL' } }), []);
  assert.deepEqual(addressGaps(null), ['street', 'postcode', 'city', 'country']);
  const snap = {
    seller,
    buyer: { name: 'QA Buyer', company: 'Country Only Lab B.V.', email: null, phone: null, vatId: null, lines: ['Netherlands'], country: 'NL' },
    vat: { treatment: 'DOMESTIC_STANDARD', label: '', rows: [], legalText: null, buyerVatId: null, viesConsultation: null, pendingNote: null },
  } as unknown as Pick<DocumentSnapshot, 'seller' | 'buyer' | 'vat'>;
  const missing = missingInvoiceDetails(snap, true, addressGaps({ address: { country: 'NL' } }));
  assert.equal(missing.length, 1);
  assert.match(missing[0], /buyer billing address \(street, postcode, city missing\)/);
});

test('party: the country is printed in full; the code is kept', () => {
  const p = partyFromAddress({ name: 'Jan', company: 'Lab B.V.', address: { line1: 'Weg 1', postal_code: '1000 AA', city: 'Amsterdam', country: 'NL' } }, 'x', (c) => (c === 'NL' ? 'Netherlands' : c));
  assert.deepEqual(p?.lines, ['Weg 1', '1000 AA Amsterdam', 'Netherlands']);
  assert.equal(p?.country, 'NL');
});

test('legacy charged VAT: the rate that produced the charged amount is found (not only the interim flat rate)', () => {
  // €123.00 charged €25.83 — exactly 21% — while the interim flat setting was 0.
  const r = chargedVat(12_300, 0, 2_583, 0, [2100, 900]);
  assert.deepEqual(r.rows, [{ rateBp: 2100, baseCents: 12_300, taxCents: 2_583 }]);
  const nine = chargedVat(10_000, 0, 900, 0, [2100, 900]);
  assert.equal(nine.goodsRateBp, 900);
  const odd = chargedVat(10_000, 0, 1_234, 0, [2100, 900]);
  assert.equal(odd.rows[0].rateBp, null);
});

test('partial credit: VAT of each row is the rate on its base (never €17.36 on €82.64 at 21%)', () => {
  const rows = [{ rateBp: 2100, baseCents: 100_000, taxCents: 21_000 }];
  const [r] = splitGrossOverRows(10_000, rows);
  assert.equal(r.baseCents, 8_264);
  assert.equal(r.taxCents, 1_735);
  assert.equal(creditableGross(10_000, rows), 9_999);
  // An amount that has an exact split keeps it.
  const [e] = splitGrossOverRows(12_100, rows);
  assert.deepEqual([e.baseCents, e.taxCents], [10_000, 2_100]);
  assert.equal(baseForGross(12_100, 2100), 10_000);
  // Two rates (goods 21%, shipping 0%): proportional, exact per row.
  const two = splitGrossOverRows(60_000, [{ rateBp: 2100, baseCents: 100_000, taxCents: 21_000 }, { rateBp: 0, baseCents: 10_000, taxCents: 0 }]);
  for (const x of two) if (x.rateBp) assert.equal(x.taxCents, Math.round((x.baseCents * x.rateBp) / 10000));
});

test('line VAT stays proportional (largest remainder), and adds up to the rate total', () => {
  const s: TaxSettings = {
    homeCountry: 'NL', standardRateBp: 2100, shippingFollowsMain: true, icsEnabled: true, icsRequireVies: true, viesDownPolicy: 'MANUAL_REVIEW',
    exportZeroEnabled: true, euB2cMode: 'HOME_RATE', marginSchemeEnabled: false, salesMode: 'B2B_ONLY', legalTexts: { ICS: '', EXPORT: '', MARGIN: '', OSS: '' },
  };
  const facts: CountryFacts = { isEu: (c) => ['NL', 'DE', 'BE'].includes(c), standardRateBp: () => 2100 };
  const d = determineVat({ shipToCountry: 'NL', billingCountry: 'NL', customerKind: 'BUSINESS', vatId: null, lines: Array.from({ length: 5 }, () => ({ netCents: 2, lineType: 'GOODS' as const })) }, s, facts);
  assert.deepEqual(d.lines.map((l) => l.taxCents), [1, 1, 0, 0, 0]);
  assert.equal(d.taxCents, 2);
  const big = determineVat({ shipToCountry: 'NL', billingCountry: 'NL', customerKind: 'BUSINESS', vatId: null, lines: [{ netCents: 33_333, lineType: 'GOODS' }, { netCents: 33_333, lineType: 'GOODS' }, { netCents: 33_334, lineType: 'GOODS' }] }, s, facts);
  assert.equal(big.lines.reduce((a, l) => a + l.taxCents, 0), big.breakdown[0].taxCents);
});

test('paid in full: the value date of the payment that completed it; short payments are not "paid in full"', () => {
  const base = { totalCents: 121_000, financialStatus: 'PAID', amountPaidCents: 0, paidAt: new Date('2026-10-03T09:00:00Z'), paymentVerifiedAt: new Date('2026-10-03T09:00:00Z'), paymentMethodManual: 'BANK_TRANSFER', status: 'PAID' } as const;
  const two = paymentFacts({ ...base, payments: [
    { amountCents: 100_000, receivedAt: new Date('2026-09-28T00:00:00Z'), method: 'BANK_TRANSFER' },
    { amountCents: 21_000, receivedAt: new Date('2026-10-01T00:00:00Z'), method: 'BANK_TRANSFER' },
  ] } as never);
  assert.equal(two.inFull, true);
  assert.equal(two.paidAt?.toISOString(), '2026-10-01T00:00:00.000Z');
  const short = paymentFacts({ ...base, payments: [{ amountCents: 120_000, receivedAt: new Date('2026-09-30T00:00:00Z'), method: 'BANK_TRANSFER' }] } as never);
  assert.equal(short.inFull, false);
  assert.equal(short.paidCents, 120_000);
  const tolerated = paymentFacts({ ...base, payments: [{ amountCents: 120_990, receivedAt: new Date('2026-09-30T00:00:00Z'), method: 'BANK_TRANSFER' }] } as never, 1_000);
  assert.equal(tolerated.inFull, true);
  const legacy = paymentFacts({ ...base, payments: [] } as never);
  assert.equal(legacy.inFull, true);
  assert.equal(legacy.paidAt?.toISOString(), '2026-10-03T09:00:00.000Z');
});

function snapshotFixture(extra: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    v: 1, kind: 'CREDIT_NOTE', title: 'Credit note', number: 'CN-2026-00007', version: 1,
    issueDate: '2026-10-03T10:00:00.000Z', supplyDate: null, dueDate: null, currency: 'EUR', orderNumber: 'L2D-2026-X',
    refs: [], seller, bank: null,
    buyer: { name: 'QA Buyer', company: 'QA Lab B.V.', email: 'ap@qa.nl', phone: null, vatId: null, lines: ['Weg 1', '1000 AA Amsterdam', 'NL'], country: 'NL' },
    shipTo: null,
    lines: [{ description: 'Item', detail: null, qty: -1, unitCents: 10_000, netCents: -10_000, vatRateBp: 2100, taxCents: -2_100, lineType: 'GOODS' }],
    vat: { treatment: 'DOMESTIC_STANDARD', label: '', rows: [{ rateBp: 2100, baseCents: -10_000, taxCents: -2_100 }], legalText: null, buyerVatId: null, viesConsultation: null, pendingNote: null },
    totals: { goodsCents: -10_000, shippingCents: 0, netCents: -10_000, taxCents: -2_100, totalCents: -12_100 },
    payment: { kind: 'CREDIT', originalNumber: 'INV-2026-00002', refundMethod: 'bank transfer' },
    notes: [], terms: [], clauses: [], original: { number: 'INV-2026-00002', issueDate: '2026-10-02T10:00:00.000Z' }, footerExtra: null,
    audit: { vatReasons: [], warnings: [] },
    ...extra,
  };
}

test('renderer: an older snapshot (no frozen texts) prints exactly its old English texts', () => {
  const html = renderDocumentHtml(snapshotFixture());
  assert.match(html, /Refund by bank transfer\./); // what that document said when issued
  assert.match(html, /This document credits invoice <strong class="mono">INV-2026-00002<\/strong>\. No payment is due\./);
  assert.doesNotMatch(html, /of 2 October 2026/);
  assert.match(html, /<div dir="auto">NL<\/div>/);
});

test('renderer: frozen texts — credit note names the original invoice date, Dutch layout, Attn. structure', () => {
  const labels = Object.fromEntries(DOC_LABEL_KEYS.map((k) => [k, defaultDocLabel(k, 'nl')]));
  const html = renderDocumentHtml(snapshotFixture({
    labels,
    locale: { lang: 'nl', dateLocale: 'nl-NL', moneyLocale: 'nl-NL', timeZone: 'Europe/Amsterdam' },
    buyer: { name: 'Jan de Vries', company: 'QA Lab B.V.', attention: 'Jan de Vries', email: 'ap@qa.nl', phone: null, vatId: 'NL859876543B01', lines: ['Weg 1', '1000 AA Amsterdam', 'Nederland'], country: 'NL' },
    terms: ['Deze creditnota corrigeert factuur INV-2026-00002 van 2 oktober 2026.'],
  }));
  assert.match(html, /Correctie op factuur/);
  assert.match(html, /INV-2026-00002<\/span> van 2 oktober 2026/);
  assert.match(html, /t\.a\.v\.<\/span> <span dir="auto">Jan de Vries/);
  assert.match(html, /Nederland/);
  assert.match(html, /Factuuradres/);
  assert.match(html, /<html lang="nl">/);
  assert.doesNotMatch(html, /Refund by/);
  // Every label has both languages.
  for (const k of DOC_LABEL_KEYS) assert.ok(DOC_LABEL_DEFS[k].en && DOC_LABEL_DEFS[k].nl, k);
});

test('renderer: prepaid invoice shows the advance-payment date, not an invented supply date', () => {
  const labels = Object.fromEntries(DOC_LABEL_KEYS.map((k) => [k, defaultDocLabel(k, 'en')]));
  const html = renderDocumentHtml(snapshotFixture({
    kind: 'INVOICE', title: 'Invoice', number: 'INV-2026-00012', original: null, labels,
    locale: { lang: 'en', dateLocale: 'en-GB', moneyLocale: 'en-IE', timeZone: 'Europe/Amsterdam' },
    supplyDate: null, advancePaymentDate: '2026-10-01T00:00:00.000Z',
    payment: { kind: 'PAID', paidAt: '2026-10-01T00:00:00.000Z', method: 'Bank transfer', amountCents: 12_100 },
    totals: { goodsCents: 10_000, shippingCents: 0, netCents: 10_000, taxCents: 2_100, totalCents: 12_100 },
  }));
  assert.match(html, /Advance payment received<\/td><td>1 October 2026/);
  assert.doesNotMatch(html, /Date of supply/);
  assert.match(html, /Paid in full on 1 October 2026/);
});

test('a failed invoice gives a readable reason — never a stack trace', () => {
  const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`number`)', { code: 'P2002', clientVersion: 'test', meta: { target: ['number'] } });
  assert.match(readableIssueError(p2002), /^The next invoice number is already used by an earlier document .*Nothing was issued and no number was used up\.$/);
  const dup = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target: ['orderId'] } });
  assert.equal(readableIssueError(dup), 'This order already has an invoice. Reload the page.');
  // A database guard (trigger) speaks for itself.
  assert.equal(readableIssueError(new Error('ERROR: Number series INVOICE/2026 can only move forward.\nCONTEXT: …')), 'Number series INVOICE/2026 can only move forward. Nothing was issued.');
  const other = readableIssueError(new Error('connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect'));
  assert.match(other, /^A technical error stopped the invoice \(connect ECONNREFUSED 127\.0\.0\.1:5432 at TCPConnectWrap/);
  assert.match(other, /Nothing was issued and no number was used up; the details are in the error log\.$/);
});

test('renderer: margin scheme — goods without VAT (*), the shipping keeps its VAT row and the total adds up', () => {
  const labels = Object.fromEntries(DOC_LABEL_KEYS.map((k) => [k, defaultDocLabel(k, 'en')]));
  const html = renderDocumentHtml(snapshotFixture({
    kind: 'INVOICE', title: 'Invoice', number: 'INV-2026-00074', original: null, labels,
    locale: { lang: 'en', dateLocale: 'en-GB', moneyLocale: 'en-IE', timeZone: 'Europe/Amsterdam' },
    lines: [
      { description: 'Stirrer (second-hand)', detail: null, qty: 1, unitCents: 23_500, netCents: 23_500, vatRateBp: 0, taxCents: 0, lineType: 'GOODS' },
      { description: 'Shipping', detail: null, qty: 1, unitCents: 4_500, netCents: 4_500, vatRateBp: 2100, taxCents: 945, lineType: 'SHIPPING' },
    ],
    vat: { treatment: 'MARGIN_SCHEME', label: 'Margin scheme', rows: [{ rateBp: 2100, baseCents: 4_500, taxCents: 945 }, { rateBp: 0, baseCents: 23_500, taxCents: 0 }], legalText: 'Margin scheme — second-hand goods.', buyerVatId: null, viesConsultation: null, pendingNote: null },
    totals: { goodsCents: 23_500, shippingCents: 4_500, netCents: 28_000, taxCents: 945, totalCents: 28_945 },
    payment: { kind: 'PAID', paidAt: '2026-10-03T00:00:00.000Z', method: 'Bank transfer', amountCents: 28_945 },
  }));
  assert.match(html, /<td>€235\.00<\/td>\s*<td>\*<\/td>/);
  assert.match(html, /<td>€45\.00<\/td>\s*<td>21%<\/td>/);
  assert.match(html, /<tr><td>VAT 21%<\/td><td>€9\.45<\/td><\/tr><tr><td class="sub" colspan="2">over €45\.00<\/td><\/tr>/);
  assert.doesNotMatch(html, /VAT 0%/);
  assert.match(html, /\* Margin scheme — VAT included, not shown separately/);
  assert.match(html, /€289\.45/);
});
