import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_CSV_HEADER, orderCsvRow, printedVat, type OrderExportRecord } from './orders-export';

const D = (s: string) => new Date(s);
const snap = (vatId: string | null, rows: Array<[number, number, number]>) => ({
  vat: { buyerVatId: null, rows: rows.map(([rateBp, baseCents, taxCents]) => ({ rateBp, baseCents, taxCents })) },
  buyer: { vatId },
});

function order(over: Partial<OrderExportRecord> = {}): OrderExportRecord {
  return {
    orderNumber: 'L2D-2026-G0BJ4S',
    createdAt: D('2026-10-10T09:00:00Z'),
    status: 'DELIVERED',
    subtotalCents: 1_180_000,
    shippingCents: 45_000,
    taxCents: 257_250,
    totalCents: 1_482_250,
    currency: 'EUR',
    trackingCarrier: 'DHL',
    trackingNumber: 'JD0001',
    shippedAt: D('2026-10-17T09:00:00Z'),
    deliveredAt: D('2026-10-18T09:00:00Z'),
    paidAt: D('2026-10-16T12:00:00Z'),
    stripePaymentIntentId: null,
    poNumber: 'G1-PO-2026-0457',
    proformaNumber: null,
    vatTreatment: 'DOMESTIC_STANDARD',
    vatRateBp: 2100,
    shippingVatRateBp: 2100,
    buyerVatId: 'NL812345678B01',
    buyer: { name: 'Jan Bakker', email: 'g1.buyer@labtodate.com' },
    items: [{ titleSnapshot: 'Agilent 1200 series HPLC', quantity: 1, priceCentsSnapshot: 1_180_000 }],
    sourcingRequest: { proformaNumber: 'PF-2026-00004' },
    documents: [
      { id: 'pf', originalDocumentId: null, kind: 'PROFORMA', number: 'PF-2026-00004-r2', issueDate: D('2026-10-12T10:00:00Z'), createdAt: D('2026-10-12T10:00:00Z'), vatTreatment: 'DOMESTIC_STANDARD', taxCents: 257_250, totalCents: 1_482_250, voidedAt: null, snapshot: {} },
      { id: 'inv2', originalDocumentId: null, kind: 'INVOICE', number: 'INV-2026-00002', issueDate: D('2026-10-17T22:10:00Z'), createdAt: D('2026-10-17T22:10:00Z'), vatTreatment: 'DOMESTIC_STANDARD', taxCents: 257_250, totalCents: 1_482_250, voidedAt: null, snapshot: snap('NL812345678B01', [[2100, 1_225_000, 257_250]]) },
      { id: 'cn1', originalDocumentId: 'inv2', kind: 'CREDIT_NOTE', number: 'CN-2026-00001', issueDate: D('2026-10-18T00:23:00Z'), createdAt: D('2026-10-18T00:23:00Z'), vatTreatment: 'DOMESTIC_STANDARD', taxCents: -2_100, totalCents: -12_100, voidedAt: null, snapshot: snap('NL812345678B01', [[2100, -10_000, -2_100]]) },
    ],
    ...over,
  } as OrderExportRecord;
}

const col = (row: string[], k: (typeof ORDER_CSV_HEADER)[number]) => row[ORDER_CSV_HEADER.indexOf(k)];

test('invoice, VAT, PO, proforma and credit-note columns', () => {
  const row = orderCsvRow(order(), 'Europe/Amsterdam');
  assert.equal(row.length, ORDER_CSV_HEADER.length);
  assert.equal(col(row, 'invoice_number'), 'INV-2026-00002');
  assert.equal(col(row, 'invoice_date'), '2026-10-18'); // 00:10 on 18 Oct in Amsterdam
  assert.equal(col(row, 'vat_treatment'), 'DOMESTIC_STANDARD');
  assert.equal(col(row, 'vat_rate'), '21');
  assert.equal(col(row, 'vat_amount'), '2572.50');
  assert.equal(col(row, 'buyer_vat_id'), 'NL812345678B01');
  assert.equal(col(row, 'po_number'), 'G1-PO-2026-0457');
  assert.equal(col(row, 'proforma_number'), 'PF-2026-00004-r2');
  assert.equal(col(row, 'credit_note_numbers'), 'CN-2026-00001');
  assert.equal(col(row, 'credit_notes_total'), '-121.00');
  assert.equal(col(row, 'replaced_invoice_numbers'), '');
  assert.equal(col(row, 'replacement_credit_note_numbers'), '');
  assert.equal(col(row, 'subtotal'), '11800.00');
});

test('a corrected invoice: the replacing invoice is the current one, the replaced pair carries no amount', () => {
  // L2D-2026-K17OWI: INV-2026-00023 credited in full by CN-2026-00008 (replaced), INV-2026-00024 valid.
  const o = order();
  const fixed = order({
    documents: [
      ...o.documents.slice(0, 2),
      { ...o.documents[2], id: 'cn8', originalDocumentId: 'inv2', number: 'CN-2026-00008', totalCents: -1_482_250, taxCents: -257_250 },
      { ...o.documents[1], id: 'inv24', originalDocumentId: 'inv2', number: 'INV-2026-00024', issueDate: D('2026-10-18T01:08:14Z'), createdAt: D('2026-10-18T01:08:14Z') },
    ],
  });
  const row = orderCsvRow(fixed, 'Europe/Amsterdam');
  assert.equal(col(row, 'invoice_number'), 'INV-2026-00024');
  assert.equal(col(row, 'vat_amount'), '2572.50');
  assert.equal(col(row, 'credit_note_numbers'), '');
  assert.equal(col(row, 'credit_notes_total'), '');
  assert.equal(col(row, 'replaced_invoice_numbers'), 'INV-2026-00002');
  assert.equal(col(row, 'replacement_credit_note_numbers'), 'CN-2026-00008');

  // A later credit of the replacing invoice is a real credit again.
  const credited = order({
    documents: [
      ...fixed.documents,
      { ...o.documents[2], id: 'cn9', originalDocumentId: 'inv24', number: 'CN-2026-00009', issueDate: D('2026-10-19T09:00:00Z'), createdAt: D('2026-10-19T09:00:00Z') },
    ],
  });
  const r2 = orderCsvRow(credited, 'Europe/Amsterdam');
  assert.equal(col(r2, 'credit_note_numbers'), 'CN-2026-00009');
  assert.equal(col(r2, 'credit_notes_total'), '-121.00');
  assert.equal(col(r2, 'replacement_credit_note_numbers'), 'CN-2026-00008');
});

test('not invoiced yet: VAT from the order, proforma from the order or the quote', () => {
  const row = orderCsvRow(order({ documents: [], proformaNumber: 'PF-2026-00009', shippingVatRateBp: 0, vatRateBp: 2100 }), 'UTC');
  assert.equal(col(row, 'invoice_number'), '');
  assert.equal(col(row, 'vat_rate'), '21|0');
  assert.equal(col(row, 'vat_amount'), '2572.50');
  assert.equal(col(row, 'proforma_number'), 'PF-2026-00009');
  assert.equal(col(orderCsvRow(order({ documents: [] }), 'UTC'), 'proforma_number'), 'PF-2026-00004');
  assert.deepEqual(printedVat({ vat: { rows: [{ rateBp: 0 }, { rateBp: 0 }], buyerVatId: 'be 0123.456.789' } }), { rates: [0], buyerVatId: 'BE0123456789' });
});
