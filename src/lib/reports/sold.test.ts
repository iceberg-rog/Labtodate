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
const admin = { id: 'u_a', name: 'Admin', role: 'ADMIN', company: null };

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
        { kind: 'PROFORMA', number: 'PF-2026-00004', issueDate: D('2026-10-12T10:00:00Z'), createdAt: D('2026-10-12T10:00:00Z'), subtotalCents: 1_225_000, voidedAt: null },
        { kind: 'INVOICE', number: 'INV-2026-00002', issueDate: D('2026-10-18T00:10:00Z'), createdAt: D('2026-10-18T00:10:00Z'), subtotalCents: 1_225_000, voidedAt: null },
        { kind: 'CREDIT_NOTE', number: 'CN-2026-00001', issueDate: D('2026-10-18T00:23:00Z'), createdAt: D('2026-10-18T00:23:00Z'), subtotalCents: -10_000, voidedAt: null },
      ],
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
  assert.deepEqual(r.creditNotes.map((c) => [c.number, c.netCents]), [['CN-2026-00001', -10_000]]);
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
  assert.equal(col('order_credit_notes_excl_vat'), '-100.00');
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
    item({ order: { financialStatus: 'INVOICED_ON_TERMS', paidAt: null, documents: [{ kind: 'INVOICE', number: 'INV-2026-00030', issueDate: D('2026-10-05T10:00:00Z'), createdAt: D('2026-10-05T10:00:00Z'), subtotalCents: 1_200_000, voidedAt: null }] } }),
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
