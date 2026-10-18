import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buyerOf,
  costOf,
  filterSoldRows,
  marginOf,
  SOLD_CSV_HEADER,
  soldCsvRows,
  soldFilterOptions,
  soldRowOf,
  soldStatusView,
  soldTotals,
  supplierOf,
  type SoldItemRecord,
} from './sold';

const D = (s: string) => new Date(s);
const seller = { id: 'u_s1', name: 'QA Seller', role: 'SELLER', company: null };
const admin = { id: 'u_a', name: 'Admin', role: 'ADMIN' as const, company: null };

type Doc = SoldItemRecord['order']['documents'][number];
/** A fiscal document as the register loads it (net incl. freight; frozen freight in the snapshot). */
function fdoc(kind: Doc['kind'], id: string, number: string, issued: string, net: number, p: { freight?: number; original?: string; treatment?: Doc['vatTreatment'] } = {}): Doc {
  return {
    id,
    kind,
    number,
    vatTreatment: p.treatment ?? 'DOMESTIC_STANDARD',
    originalDocumentId: p.original ?? null,
    issueDate: D(issued),
    createdAt: D(issued),
    subtotalCents: net,
    voidedAt: null,
    snapshot: { totals: { shippingCents: p.freight ?? 0 } },
  };
}

function item(over: { order?: Partial<SoldItemRecord['order']>; product?: Partial<NonNullable<SoldItemRecord['product']>> | null } & Partial<Omit<SoldItemRecord, 'order' | 'product'>> = {}): SoldItemRecord {
  const { order: o, product: p, ...rest } = over;
  return {
    id: 'it1',
    quantity: 1,
    priceCentsSnapshot: 1_200_000,
    titleSnapshot: 'Agilent 1200 series HPLC',
    brandSnapshot: 'Agilent',
    basePriceCents: null,
    product:
      p === null
        ? null
        : {
            id: 'p1',
            slug: 'agilent-1200-hplc',
            sku: null,
            currency: 'EUR',
            vatScheme: 'STANDARD',
            purchaseCostCents: null,
            category: { name: 'Chromatography', slug: 'chromatography' },
            company: null,
            seller,
            ...p,
          },
    order: {
      id: 'o1',
      orderNumber: 'L2D-2026-G0BJ4S',
      status: 'DELIVERED',
      financialStatus: 'PAID',
      currency: 'EUR',
      vatTreatment: 'DOMESTIC_STANDARD',
      paidAt: D('2026-10-16T12:00:00Z'),
      shippedAt: D('2026-10-17T09:00:00Z'),
      deliveredAt: D('2026-10-18T09:00:00Z'),
      createdAt: D('2026-10-10T09:00:00Z'),
      buyerVatId: 'NL812345678B01',
      poNumber: 'G1-PO-2026-0457',
      proformaNumber: 'PF-2026-00004',
      billingAddress: {
        name: 'Dr. Eva de Wit',
        company: 'G1- Wageningen Bioanalytics B.V.',
        email: 'g1.ap@labtodate.com',
        address: { line1: 'Nieuwe Kanaal 7', city: 'Wageningen', postal_code: '6709 PA', country: 'nl' },
      },
      buyer: { name: 'Jan Bakker', email: 'g1.buyer@labtodate.com' },
      sourcingRequest: {
        productId: 'p1',
        proformaNumber: 'PF-2026-00004',
        offerSupplierCostCents: null,
        offerSupplierCostCurrency: null,
        sellerProposalCurrency: null,
        assignedTo: seller,
      },
      documents: [
        fdoc('PROFORMA', 'pf4', 'PF-2026-00004', '2026-10-12T10:00:00Z', 1_225_000, { freight: 45_000 }),
        fdoc('INVOICE', 'inv2', 'INV-2026-00002', '2026-10-18T00:10:00Z', 1_225_000, { freight: 45_000 }),
        fdoc('CREDIT_NOTE', 'cn1', 'CN-2026-00001', '2026-10-18T00:23:00Z', -10_000, { original: 'inv2' }),
      ],
      items: [],
      _count: { items: 1 },
      ...o,
    },
    ...rest,
  } as SoldItemRecord;
}

test('the J1 unit: dates, buyer, net, documents', () => {
  const r = soldRowOf(item(), 'Labtodate');
  assert.equal(r.saleAt?.toISOString(), '2026-10-16T12:00:00.000Z');
  assert.equal(r.netCents, 1_200_000);
  assert.deepEqual(r.buyer, { name: 'Dr. Eva de Wit', company: 'G1- Wageningen Bioanalytics B.V.', email: 'g1.ap@labtodate.com', vatId: 'NL812345678B01', country: 'NL' });
  assert.equal(r.invoice?.number, 'INV-2026-00002');
  assert.equal(r.proformaNumber, 'PF-2026-00004');
  assert.deepEqual(r.creditNotes.map((c) => [c.number, c.goodsCents]), [['CN-2026-00001', -10_000]]);
  assert.deepEqual([r.replacedInvoices, r.replacementCreditNotes, r.marginScheme], [[], [], null]);
  assert.deepEqual(r.supplier, { key: 'seller:u_s1', name: 'QA Seller', kind: 'seller' });
  // No supplier cost recorded on the offer: no cost, no margin (never invented).
  assert.equal(r.cost, null);
  assert.equal(r.marginCents, null);

  const [csv] = soldCsvRows([r], 'Europe/Amsterdam');
  const col = (k: (typeof SOLD_CSV_HEADER)[number]) => csv[SOLD_CSV_HEADER.indexOf(k)];
  assert.equal(csv.length, SOLD_CSV_HEADER.length);
  assert.equal(col('paid_date'), '2026-10-16');
  assert.equal(col('shipped_date'), '2026-10-17');
  assert.equal(col('delivered_date'), '2026-10-18');
  assert.equal(col('line_total_excl_vat'), '12000.00');
  assert.equal(col('invoice_number'), 'INV-2026-00002');
  assert.equal(col('invoice_date'), '2026-10-18');
  assert.equal(col('buyer_company'), 'G1- Wageningen Bioanalytics B.V.');
  assert.equal(col('order_credit_notes_goods_excl_vat'), '-100.00');
  assert.equal(col('vat_scheme'), '');
  assert.equal(col('invoiced_line_total'), '12000.00');
  assert.equal(col('supplier_cost'), '');
});

test('supplier: shop listing, quoting supplier, own stock', () => {
  assert.deepEqual(supplierOf({ company: { name: 'LabShop', slug: 'labshop' }, seller: admin }, null, 'Labtodate'), { key: 'shop:labshop', name: 'LabShop', kind: 'shop' });
  assert.equal(supplierOf({ company: null, seller: admin }, seller, 'Labtodate').key, 'seller:u_s1');
  assert.equal(supplierOf({ company: null, seller: { ...seller, company: { name: 'S1 BV', slug: 's1' } } }, null, 'Labtodate').key, 'shop:s1');
  assert.deepEqual(supplierOf({ company: null, seller: admin }, admin, 'Labtodate'), { key: 'own', name: 'Labtodate', kind: 'own' });
  assert.equal(supplierOf(null, null, 'Labtodate').kind, 'own');
});

test('cost and margin: quote cost in its own currency, supplier price, purchase cost', () => {
  const quote = { offerSupplierCostCents: 380_000, offerSupplierCostCurrency: 'GBP', sellerProposalCurrency: 'GBP' };
  const c = costOf({ qty: 1, orderCurrency: 'EUR', basePriceCents: null, supplierKind: 'seller', quote, quotedLine: true, product: null });
  assert.deepEqual(c, { cents: 380_000, currency: 'GBP', source: 'quote' });
  // GBP cost against a EUR sale: no margin (no exchange rate is stored).
  assert.equal(marginOf(437_000, 'EUR', c), null);
  const eur = costOf({ qty: 1, orderCurrency: 'EUR', basePriceCents: null, supplierKind: 'seller', quote: { ...quote, offerSupplierCostCurrency: 'EUR' }, quotedLine: true, product: null });
  assert.equal(marginOf(437_000, 'EUR', eur), 57_000);
  assert.deepEqual(costOf({ qty: 2, orderCurrency: 'EUR', basePriceCents: 40_000, supplierKind: 'shop', quote: null, quotedLine: false, product: null }), { cents: 80_000, currency: 'EUR', source: 'supplier price' });
  // Own stock: the catalogue price is not a cost; only a recorded purchase cost is.
  assert.equal(costOf({ qty: 1, orderCurrency: 'EUR', basePriceCents: 40_000, supplierKind: 'own', quote: null, quotedLine: false, product: { purchaseCostCents: null, currency: 'EUR' } }), null);
  assert.deepEqual(costOf({ qty: 1, orderCurrency: 'EUR', basePriceCents: 40_000, supplierKind: 'own', quote: null, quotedLine: false, product: { purchaseCostCents: 25_000, currency: 'EUR' } }), { cents: 25_000, currency: 'EUR', source: 'purchase cost' });
});

test('buyer falls back to the account; anonymised accounts show no e-mail', () => {
  assert.deepEqual(buyerOf(null, { name: 'Deleted user', email: 'deleted+abc@lab2date.invalid' }, null), { name: 'Deleted user', company: null, email: null, vatId: null, country: null });
});

test('on terms: sold when invoiced, not paid', () => {
  const r = soldRowOf(
    item({ order: { financialStatus: 'INVOICED_ON_TERMS', paidAt: null, documents: [fdoc('INVOICE', 'inv30', 'INV-2026-00030', '2026-10-05T10:00:00Z', 1_200_000)] } }),
    'Labtodate',
  );
  assert.equal(r.onTerms, true);
  assert.equal(r.saleAt?.toISOString(), '2026-10-05T10:00:00.000Z');
  assert.equal(soldCsvRows([r], 'UTC')[0][SOLD_CSV_HEADER.indexOf('payment')], 'on invoice terms (unpaid)');
});

test('filters, options and totals per currency', () => {
  const a = soldRowOf(item(), 'Labtodate');
  const b = soldRowOf(
    item({
      id: 'it2',
      priceCentsSnapshot: 50_000,
      quantity: 2,
      basePriceCents: 40_000,
      product: { id: 'p2', company: { name: 'LabShop', slug: 'labshop' }, category: { name: 'Pumps', slug: 'pumps' } },
      order: { id: 'o2', orderNumber: 'L2D-2026-USD001', currency: 'USD', sourcingRequest: null, documents: [] },
    }),
    'Labtodate',
  );
  assert.equal(b.cost?.cents, 80_000);
  assert.equal(b.marginCents, 20_000);
  const opts = soldFilterOptions([a, b]);
  assert.deepEqual(opts.categories.map((c) => c.slug), ['chromatography', 'pumps']);
  assert.deepEqual(opts.suppliers.map((s) => s.key), ['shop:labshop', 'seller:u_s1']);
  assert.deepEqual(filterSoldRows([a, b], { supplier: 'shop:labshop' }).map((r) => r.itemId), ['it2']);
  assert.deepEqual(filterSoldRows([a, b], { category: 'chromatography' }).map((r) => r.itemId), ['it1']);
  const totals = soldTotals([a, b]);
  assert.deepEqual(totals.map((t) => [t.currency, t.units, t.netCents, t.marginCents, t.rowsWithoutMargin, t.creditedCents]), [
    ['EUR', 1, 1_200_000, 0, 1, -10_000],
    ['USD', 2, 100_000, 20_000, 0, 0],
  ]);
  assert.equal(soldStatusView('bogus'), 'sold');
  assert.equal(soldStatusView('refunded'), 'refunded');
});

test('a corrected invoice: the replaced invoice and its credit note net out, no credit is counted', () => {
  // L2D-2026-K17OWI: INV-2026-00023 credited in full (incl. €185 freight) by CN-2026-00008, replaced by INV-2026-00024.
  const r = soldRowOf(
    item({
      priceCentsSnapshot: 185_000,
      order: {
        orderNumber: 'L2D-2026-K17OWI',
        paidAt: D('2026-10-18T00:30:00Z'),
        documents: [
          fdoc('INVOICE', 'inv23', 'INV-2026-00023', '2026-10-18T00:20:00Z', 203_500, { freight: 18_500 }),
          fdoc('CREDIT_NOTE', 'cn8', 'CN-2026-00008', '2026-10-18T01:08:13Z', -203_500, { freight: -18_500, original: 'inv23' }),
          fdoc('INVOICE', 'inv24', 'INV-2026-00024', '2026-10-18T01:08:14Z', 203_500, { freight: 18_500, original: 'inv23' }),
        ],
      },
    }),
    'Labtodate',
  );
  assert.equal(r.invoice?.number, 'INV-2026-00024');
  assert.deepEqual(r.replacedInvoices, ['INV-2026-00023']);
  assert.deepEqual(r.replacementCreditNotes, ['CN-2026-00008']);
  assert.deepEqual(r.creditNotes, []);
  assert.equal(soldTotals([r])[0].creditedCents, 0);
  const [csv] = soldCsvRows([r], 'Europe/Amsterdam');
  const col = (k: (typeof SOLD_CSV_HEADER)[number]) => csv[SOLD_CSV_HEADER.indexOf(k)];
  assert.equal(col('replaced_invoice_numbers'), 'INV-2026-00023');
  assert.equal(col('replacement_credit_note_numbers'), 'CN-2026-00008');
  assert.equal(col('credit_note_numbers'), '');
  assert.equal(col('order_credit_notes_goods_excl_vat'), '');

  // A credit of the corrected invoice is a real credit: its goods part (the freight is not a goods line).
  const later = soldRowOf(
    item({
      priceCentsSnapshot: 185_000,
      order: {
        paidAt: D('2026-10-18T00:30:00Z'),
        documents: [
          fdoc('INVOICE', 'inv23', 'INV-2026-00023', '2026-10-18T00:20:00Z', 203_500, { freight: 18_500 }),
          fdoc('CREDIT_NOTE', 'cn8', 'CN-2026-00008', '2026-10-18T01:08:13Z', -203_500, { freight: -18_500, original: 'inv23' }),
          fdoc('INVOICE', 'inv24', 'INV-2026-00024', '2026-10-18T01:08:14Z', 203_500, { freight: 18_500, original: 'inv23' }),
          fdoc('CREDIT_NOTE', 'cn9', 'CN-2026-00009', '2026-10-20T09:00:00Z', -203_500, { freight: -18_500, original: 'inv24' }),
        ],
      },
    }),
    'Labtodate',
  );
  assert.deepEqual(later.creditNotes.map((c) => [c.number, c.goodsCents]), [['CN-2026-00009', -185_000]]);
  assert.deepEqual(later.replacementCreditNotes, ['CN-2026-00008']);
});

test('an order with two lines: its credit notes count once, in the totals and the CSV', () => {
  const docs = [
    fdoc('INVOICE', 'inv5', 'INV-2026-00050', '2026-10-16T12:05:00Z', 315_000, { freight: 15_000 }),
    fdoc('CREDIT_NOTE', 'cn5', 'CN-2026-00050', '2026-10-17T09:00:00Z', -20_000, { original: 'inv5' }),
  ];
  const order = { id: 'o5', orderNumber: 'L2D-2026-TWO002', documents: docs, _count: { items: 2 } };
  const a = soldRowOf(item({ id: 'a', priceCentsSnapshot: 200_000, order }), 'Labtodate');
  const b = soldRowOf(item({ id: 'b', priceCentsSnapshot: 100_000, product: { id: 'p9' }, order }), 'Labtodate');
  const [t] = soldTotals([a, b]);
  assert.deepEqual([t.netCents, t.creditedCents], [300_000, -20_000]);
  const csv = soldCsvRows([a, b], 'UTC').map((r) => r[SOLD_CSV_HEADER.indexOf('order_credit_notes_goods_excl_vat')]);
  assert.deepEqual(csv, ['-200.00', '']);
});

test('margin scheme: the margin VAT inside the price is taken off; unknown without a purchase cost', () => {
  // €6,500 second-hand unit bought for €4,200: margin €2,300 incl. 21% VAT → €399.17 margin VAT.
  const margin = (purchaseCostCents: number | null) =>
    soldRowOf(
      item({
        priceCentsSnapshot: 650_000,
        product: { vatScheme: 'MARGIN', purchaseCostCents, company: null, seller: admin },
        order: {
          vatTreatment: 'MARGIN_SCHEME',
          sourcingRequest: null,
          documents: [fdoc('INVOICE', 'inv60', 'INV-2026-00060', '2026-10-16T12:05:00Z', 665_000, { freight: 15_000, treatment: 'MARGIN_SCHEME' })],
          items: [{ priceCentsSnapshot: 650_000, quantity: 1, product: { vatScheme: 'MARGIN', purchaseCostCents } }],
        },
      }),
      'Labtodate',
      2100,
    );
  const r = margin(420_000);
  assert.deepEqual(r.marginScheme, { vatCents: 39_917 });
  assert.equal(r.invoicedCents, 650_000);
  assert.equal(r.netCents, 610_083);
  assert.deepEqual(r.cost, { cents: 420_000, currency: 'EUR', source: 'purchase cost' });
  assert.equal(r.marginCents, 190_083); // what the unit earned after the margin VAT
  const [t] = soldTotals([r]);
  assert.deepEqual([t.netCents, t.marginVatCents, t.marginVatUnknown], [610_083, 39_917, 0]);
  const [csv] = soldCsvRows([r], 'UTC');
  assert.deepEqual(
    ['vat_scheme', 'line_total_excl_vat', 'invoiced_line_total', 'margin_vat_in_price'].map((k) => csv[SOLD_CSV_HEADER.indexOf(k as (typeof SOLD_CSV_HEADER)[number])]),
    ['margin scheme', '6100.83', '6500.00', '399.17'],
  );

  const unknown = margin(null);
  assert.deepEqual(unknown.marginScheme, { vatCents: null });
  assert.equal(unknown.netCents, 650_000);
  assert.equal(unknown.marginCents, null);
  assert.equal(soldTotals([unknown])[0].marginVatUnknown, 1);
  // The same unit invoiced under the normal rules (scheme off): nothing taken off.
  const std = soldRowOf(item({ priceCentsSnapshot: 650_000, product: { vatScheme: 'MARGIN', purchaseCostCents: 420_000 } }), 'Labtodate', 2100);
  assert.equal(std.marginScheme, null);
  assert.equal(std.netCents, 650_000);
});
