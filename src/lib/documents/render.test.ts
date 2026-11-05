import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GENERAL, DEFAULT_LABELS, DEFAULT_TEXTS, defaultOptions } from './defaults';
import { computeTotals } from './build';
import { renderDocumentHtml } from './render';
import type { DocKind, DocSnapshot, Lang } from './types';

function snap(kind: DocKind, lang: Lang, over: Partial<DocSnapshot> = {}): DocSnapshot {
  const lines = [{ title: 'Pump <b>X</b>', qty: 2, unitCents: 10_000 }];
  const t = computeTotals(lines, 1_000, 2100);
  return {
    v: 1, kind, lang, number: 'PRO-2026-0001', revision: 1, paid: false, issuedAt: '2026-11-05T10:00:00Z',
    validUntil: '2026-11-19T23:59:59Z', dueDate: '2026-11-10T23:59:59Z', currency: 'EUR',
    company: { name: 'Labtodate B.V.', addressLines: ['Stationsplein 1', '3511 ED Utrecht'], city: 'Utrecht', phone: '', email: 'billing@labtodate.com', web: '', kvk: '12345678', vat: 'NL123456789B01', iban: 'NL91ABNA0417164300', bic: '', bank: '', logo: null },
    customer: { name: '<script>alert(1)</script>', company: 'ACME "GmbH"', email: 'a@b.de', addressLines: ['Weg 1'], country: 'DE', vatId: 'DE123456789' },
    lines, shippingCents: t.shippingCents, subtotalCents: t.subtotalCents,
    vat: { treatment: 'DOMESTIC', rateBp: 2100, cents: t.vatCents }, totalCents: t.totalCents, refs: {},
    texts: DEFAULT_TEXTS[kind][lang], labels: DEFAULT_LABELS[lang], options: defaultOptions(kind), accent: DEFAULT_GENERAL.accent, timeZone: 'Europe/Amsterdam',
    ...over,
  };
}

test('person-entered values are escaped', () => {
  const html = renderDocumentHtml(snap('QUOTE', 'en'));
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<b>X</b>'));
  assert.ok(!/<script/i.test(html.replace(/&lt;script/g, '')));
});

test('totals: VAT on goods + shipping', () => {
  const s = snap('QUOTE', 'en');
  assert.equal(s.subtotalCents, 20_000);
  assert.equal(s.vat.cents, 4_410);
  assert.equal(s.totalCents, 25_410);
  assert.ok(renderDocumentHtml(s).includes('€254.10'));
});

test('reverse charge and export print their legal text and the VAT ID', () => {
  const rc = renderDocumentHtml(snap('QUOTE', 'nl', { vat: { treatment: 'REVERSE_CHARGE', rateBp: 0, cents: 0 } }));
  assert.ok(rc.includes('Intracommunautaire levering'));
  assert.ok(rc.includes('DE123456789'));
  assert.ok(rc.includes('Btw 0%'));
  const ex = renderDocumentHtml(snap('INVOICE', 'en', { vat: { treatment: 'EXPORT', rateBp: 0, cents: 0 }, paid: true }));
  assert.ok(ex.includes('Export of goods outside the EU'));
});

test('an unpaid invoice is a payment request, a paid one a settled invoice', () => {
  const unpaid = renderDocumentHtml(snap('INVOICE', 'en', { number: 'L2D-2026-ABC123' }));
  assert.ok(unpaid.includes('Proforma invoice'));
  assert.ok(unpaid.includes('Payment due'));
  assert.ok(unpaid.includes('NL91ABNA0417164300'));
  const paid = renderDocumentHtml(snap('INVOICE', 'en', { paid: true, paidAt: '2026-11-06T09:00:00Z', paymentMethod: 'BANK_TRANSFER' }));
  assert.ok(paid.includes('>Invoice<'));
  assert.ok(paid.includes('Paid — nothing left to pay'));
  assert.ok(!paid.includes('Please transfer'));
});

test('Dutch document has no English labels and uses Dutch formats', () => {
  const html = renderDocumentHtml(snap('QUOTE', 'nl'));
  for (const en of ['Description', 'Unit price', 'Valid until', 'Payment details', 'Dear ']) assert.ok(!html.includes(en), en);
  assert.ok(html.includes('19 november 2026'));
  assert.match(html, /€\s254,10/); // nl-NL puts a no-break space after €
});

test('greeting falls back when no name is known', () => {
  const html = renderDocumentHtml(snap('QUOTE', 'en', { customer: { name: '', company: 'ACME', addressLines: [] } }));
  assert.ok(html.includes('Dear Sir or Madam,'));
});
