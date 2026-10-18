import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDocumentHtml } from './render';
import { localityLines, partyFromAddress, type DocumentSnapshot } from './snapshot';
import { DOC_LABEL_KEYS, defaultDocLabel } from './labels';

const labels = Object.fromEntries(DOC_LABEL_KEYS.map((k) => [k, defaultDocLabel(k, 'en')]));
const locale = { lang: 'en', dateLocale: 'en-GB', moneyLocale: 'en-IE', timeZone: 'Europe/Amsterdam' };

function invoice(extra: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    v: 1, kind: 'INVOICE', title: 'Invoice', number: 'INV-2026-00012', version: 1,
    issueDate: '2026-10-17T10:00:00.000Z', supplyDate: null, dueDate: null, currency: 'EUR', orderNumber: 'L2D-2026-FKFE30',
    refs: [],
    seller: { name: 'Labtodate B.V.', addressLines: ['Weg 1', '1000 AA Amsterdam'], country: 'Netherlands', city: 'Amsterdam', kvk: '12345678', vatId: 'NL123456789B01', eori: '', email: '', phone: '', web: '', logoPath: '' },
    bank: { beneficiary: 'Labtodate B.V.', bankName: '', iban: 'NL91ABNA0417164300', bic: '' },
    buyer: { name: 'QA Buyer', company: 'QA Lab B.V.', attention: 'QA Buyer', email: 'ap@qa.nl', phone: null, vatId: null, lines: ['Weg 2', '2600 AA Delft', 'Netherlands'], country: 'NL' },
    shipTo: null,
    lines: [{ description: 'Centrifuge', detail: null, qty: 1, unitCents: 125_000, netCents: 125_000, vatRateBp: 2100, taxCents: 26_250, lineType: 'GOODS' }],
    vat: { treatment: 'DOMESTIC_STANDARD', label: '', rows: [{ rateBp: 2100, baseCents: 125_000, taxCents: 26_250 }], legalText: null, buyerVatId: null, viesConsultation: null, pendingNote: null },
    totals: { goodsCents: 125_000, shippingCents: 0, netCents: 125_000, taxCents: 26_250, totalCents: 151_250 },
    payment: { kind: 'PAID', paidAt: '2026-10-17T00:00:00.000Z', method: 'Bank transfer', amountCents: 151_250 },
    notes: [], terms: [], clauses: [], original: null, footerExtra: null, labels, locale,
    audit: { vatReasons: [], warnings: [] },
    ...extra,
  };
}

test('a short payment written off within the tolerance: "Received … — … written off" and the total is not "Total paid"', () => {
  const html = renderDocumentHtml(invoice({ payment: { kind: 'PAID', paidAt: '2026-10-17T00:00:00.000Z', method: 'Bank transfer', amountCents: 150_950, writtenOffCents: 300 } }));
  assert.match(html, /Received <strong>€1,509\.50<\/strong> on 17 October 2026 — €3\.00 bank charges written off — Bank transfer\./);
  assert.match(html, /<tr class="grand"><td>Total<\/td><td>€1,512\.50<\/td><\/tr>/);
  assert.doesNotMatch(html, /Total paid/);
  assert.doesNotMatch(html, /Paid in full/);
  // Paid exactly: as before.
  const full = renderDocumentHtml(invoice());
  assert.match(full, /<p><strong>Paid in full on 17 October 2026<\/strong> — Bank transfer\.<\/p>/);
  assert.match(full, /<td>Total paid<\/td><td>€1,512\.50<\/td>/);
});

test('the offer remark is printed under "Remark", other notes under "Note"', () => {
  const html = renderDocumentHtml(invoice({ remarks: ['Installation on site included.'], notes: ['Corrected invoice: wrong VAT ID'] }));
  assert.match(html, /Remark<\/div><div dir="auto">Installation on site included\.<\/div>/);
  assert.match(html, /Note<\/div><div dir="auto">Corrected invoice: wrong VAT ID<\/div>/);
  assert.doesNotMatch(renderDocumentHtml(invoice()), /Remark</);
});

test('an old proforma without bank details still renders exactly what it printed', () => {
  const html = renderDocumentHtml(invoice({
    kind: 'PROFORMA', title: 'Proforma invoice', number: 'PF-2026-00080', bank: null, labels: undefined, locale: undefined,
    payment: { kind: 'INSTRUCTIONS', reference: 'PF-2026-00080', amountCents: 151_250, dueDate: null, bankAvailable: false },
  }));
  assert.match(html, /Our bank details will be sent to you by email\. Please quote <strong class="mono">PF-2026-00080<\/strong> as the reference of your transfer\./);
  // There is no such text to configure any more (a new proforma always has bank details).
  assert.ok(!(DOC_LABEL_KEYS as string[]).includes('NO_BANK_DETAILS'));
});

test('addresses follow the destination format: US/CA/AU "City, ST ZIP", GB postcode on its own line, NL "ZIP City"', () => {
  const name = (c: string) => ({ US: 'United States', GB: 'United Kingdom', NL: 'Netherlands', CA: 'Canada' })[c] ?? c;
  assert.deepEqual(partyFromAddress({ address: { line1: '1 Main St', city: 'Boston', state: 'MA', postal_code: '02115', country: 'US' } }, 'x', name)?.lines, ['1 Main St', 'Boston, MA 02115', 'United States']);
  assert.deepEqual(partyFromAddress({ address: { line1: '10 Downing St', city: 'London', postal_code: 'SW1A 2AA', country: 'GB' } }, 'x', name)?.lines, ['10 Downing St', 'London', 'SW1A 2AA', 'United Kingdom']);
  assert.deepEqual(partyFromAddress({ address: { line1: 'Weg 1', city: 'Amsterdam', postal_code: '1000 AA', country: 'NL' } }, 'x', name)?.lines, ['Weg 1', '1000 AA Amsterdam', 'Netherlands']);
  assert.deepEqual(localityLines({ postalCode: 'M5V 2T6', city: 'Toronto', region: 'ON' }, 'CA'), ['Toronto, ON M5V 2T6']);
  assert.deepEqual(localityLines({ postalCode: '3000', city: 'Melbourne', region: 'VIC' }, 'au'), ['Melbourne, VIC 3000']);
  assert.deepEqual(localityLines({ postalCode: '20095', city: 'Hamburg', region: 'Hamburg' }, 'DE'), ['20095 Hamburg, Hamburg']);
  assert.deepEqual(localityLines({ postalCode: null, city: null, region: null }, 'US'), []);
});
