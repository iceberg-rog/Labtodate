import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOC_CSV_HEADER,
  docCsvRows,
  docKindFilter,
  docRowOf,
  filterDocRows,
  icpCsvRows,
  icpSummary,
  normaliseVatId,
  rateTotals,
  vatCsvRows,
  vatIdCountry,
  vatSummary,
  type DocRecord,
} from './documents';

const TZ = 'Europe/Amsterdam';
let seq = 0;

function rec(p: {
  kind: DocRecord['kind'];
  number: string;
  issued: string;
  treatment?: DocRecord['vatTreatment'];
  rows: Array<[number | null, number, number]>;
  currency?: string;
  buyerVat?: string | null;
  company?: string;
  original?: string;
  voided?: boolean;
}): DocRecord {
  const net = p.rows.reduce((s, r) => s + r[1], 0);
  const tax = p.rows.reduce((s, r) => s + r[2], 0);
  return {
    id: `d${++seq}`,
    kind: p.kind,
    number: p.number,
    version: 1,
    issueDate: new Date(p.issued),
    currency: p.currency ?? 'EUR',
    vatTreatment: p.treatment ?? 'DOMESTIC_STANDARD',
    subtotalCents: net,
    taxCents: tax,
    totalCents: net + tax,
    sentAt: null,
    voidedAt: p.voided ? new Date(p.issued) : null,
    supersededById: null,
    legacy: false,
    snapshot: {
      orderNumber: 'L2D-2026-ABC123',
      buyer: { name: 'Contact', company: p.company ?? 'Buyer BV', vatId: p.buyerVat ?? null, country: 'NL' },
      vat: { buyerVatId: p.treatment === 'EU_ICS_ZERO' ? (p.buyerVat ?? null) : null, rows: p.rows.map(([rateBp, baseCents, taxCents]) => ({ rateBp, baseCents, taxCents })) },
      ...(p.original ? { original: { number: p.original } } : {}),
    },
    order: { id: 'o1', orderNumber: 'L2D-2026-ABC123' },
    originalDocument: p.original ? { number: p.original } : null,
  } as DocRecord;
}

const docs = [
  rec({ kind: 'PROFORMA', number: 'PF-2026-00001', issued: '2026-09-29T10:00:00Z', rows: [[2100, 1_225_000, 257_250]] }),
  rec({ kind: 'INVOICE', number: 'INV-2026-00002', issued: '2026-10-18T00:10:00Z', rows: [[2100, 1_225_000, 257_250]] }),
  rec({ kind: 'CREDIT_NOTE', number: 'CN-2026-00001', issued: '2026-10-18T00:23:00Z', rows: [[2100, -10_000, -2_100]], original: 'INV-2026-00002' }),
  rec({ kind: 'INVOICE', number: 'INV-2026-00040', issued: '2026-09-30T22:30:00Z', treatment: 'EU_ICS_ZERO', rows: [[0, 980_000, 0]], buyerVat: 'be 0123.456.789', company: 'Gent Lab NV' }),
  rec({ kind: 'CREDIT_NOTE', number: 'CN-2026-00010', issued: '2026-11-02T09:00:00Z', treatment: 'EU_ICS_ZERO', rows: [[0, -30_000, 0]], buyerVat: 'BE0123456789', company: 'Gent Lab NV', original: 'INV-2026-00040' }),
  rec({ kind: 'INVOICE', number: 'INV-2026-00041', issued: '2026-10-03T09:00:00Z', currency: 'USD', treatment: 'EXPORT_ZERO', rows: [[0, 1_650_000, 0]] }),
  rec({ kind: 'INVOICE', number: 'INV-2026-00042', issued: '2026-10-04T09:00:00Z', rows: [[2100, 100_000, 21_000], [900, 20_000, 1_800]] }),
];
const rows = docs.map((d) => docRowOf(d, TZ));

test('rows come from the frozen snapshot', () => {
  const inv = rows.find((r) => r.number === 'INV-2026-00040')!;
  // 00:30 on 1 October in Amsterdam.
  assert.equal(inv.day, '2026-10-01');
  assert.equal(inv.buyer.vatId, 'BE0123456789');
  assert.equal(rows.find((r) => r.number === 'CN-2026-00001')!.originalNumber, 'INV-2026-00002');
  assert.equal(normaliseVatId(' nl 8123.45678 b01 '), 'NL812345678B01');
  assert.equal(vatIdCountry('el123456789'), 'EL');
  assert.equal(vatIdCountry(null), null);
});

test('a margin-scheme document without VAT rows keeps its own amounts', () => {
  const m = docRowOf({ ...docs[1], vatTreatment: 'MARGIN_SCHEME', snapshot: { vat: { rows: [] } } } as DocRecord, TZ);
  assert.deepEqual(m.rates, [{ rateBp: null, baseCents: m.netCents, taxCents: m.taxCents }]);
});

test('totals per rate count invoices minus credit notes, never proformas', () => {
  const t = rateTotals(rows).filter((x) => x.currency === 'EUR' && x.treatment === 'DOMESTIC_STANDARD');
  assert.deepEqual(t.map((x) => [x.rateBp, x.baseCents, x.taxCents]), [
    [2100, 1_315_000, 276_150],
    [900, 20_000, 1_800],
  ]);
});

test('VAT summary per quarter / month', () => {
  const q = vatSummary(rows, 'quarter');
  const q4 = q.filter((r) => r.period === '2026-Q4' && r.currency === 'EUR' && r.treatment === 'DOMESTIC_STANDARD' && r.rateBp === 2100)[0];
  assert.deepEqual([q4.baseCents, q4.taxCents, q4.invoices, q4.creditNotes], [1_315_000, 276_150, 2, 1]);
  assert.ok(!q.some((r) => r.period === '2026-Q3')); // the only Q3 document is a proforma
  const m = vatSummary(rows, 'month');
  assert.ok(m.some((r) => r.period === '2026-11' && r.treatment === 'EU_ICS_ZERO' && r.baseCents === -30_000));
  const csv = vatCsvRows(q);
  assert.ok(csv.some((r) => r[0] === 'Q4 2026' && r[4] === '21' && r[5] === '13150.00'));
});

test('ICP listing: intra-EU 0% per quarter and VAT ID, credit notes in their own quarter', () => {
  const icp = icpSummary(rows);
  assert.deepEqual(icp.map((r) => [r.quarter, r.country, r.vatId, r.buyer, r.netCents, r.invoices, r.creditNotes]), [
    ['2026-Q4', 'BE', 'BE0123456789', 'Gent Lab NV', 950_000, 1, 1],
  ]);
  assert.deepEqual(icpCsvRows(icp)[0], ['Q4 2026', 'BE', 'BE0123456789', 'Gent Lab NV', 'EUR', '9500.00', '1', '1']);
});

test('filters and CSV: one row per document and rate', () => {
  assert.equal(filterDocRows(rows, { kind: 'fiscal' }).length, 6);
  assert.equal(filterDocRows(rows, { kind: 'PROFORMA' }).length, 1);
  assert.equal(filterDocRows(rows, { currency: 'USD' })[0].number, 'INV-2026-00041');
  assert.equal(filterDocRows(rows, { q: 'gent lab' }).length, 2);
  assert.equal(filterDocRows(rows, { treatment: 'EU_ICS_ZERO' }).length, 2);
  assert.equal(docKindFilter('nope'), 'all');
  const csv = docCsvRows(rows.filter((r) => r.number === 'INV-2026-00042'));
  assert.equal(csv.length, 2);
  assert.equal(csv[0].length, DOC_CSV_HEADER.length);
  assert.deepEqual(csv.map((r) => [r[9], r[10], r[11], r[12]]), [['21', '1000.00', '210.00', '1210.00'], ['9', '200.00', '18.00', '218.00']]);
});
