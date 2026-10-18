import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  averageSale,
  docNetSplit,
  formatByCurrency,
  invoiceChain,
  revenueByCurrency,
  revenueEvents,
  revenueSeries,
  saleDateOf,
  type RevenueDocInput,
  type RevenueOrderInput,
} from './revenue';

const D = (s: string) => new Date(s);

let seq = 0;
function doc(kind: RevenueDocInput['kind'], issued: string, goods: number, freight: number, vatBp = 2100, over: Partial<RevenueDocInput> = {}): RevenueDocInput {
  const net = goods + freight;
  const tax = Math.round((net * vatBp) / 10000);
  return {
    id: `d${++seq}`,
    kind,
    vatTreatment: 'DOMESTIC_STANDARD',
    originalDocumentId: null,
    issueDate: D(issued),
    createdAt: D(issued),
    subtotalCents: net,
    totalCents: net + tax,
    snapshot: { totals: { goodsCents: goods, shippingCents: freight, netCents: net, taxCents: tax, totalCents: net + tax } },
    ...over,
  };
}

function order(p: Partial<RevenueOrderInput> & Pick<RevenueOrderInput, 'id'>): RevenueOrderInput {
  return {
    currency: 'EUR',
    status: 'PAID',
    vatTreatment: 'DOMESTIC_STANDARD',
    subtotalCents: 0,
    shippingCents: 0,
    totalCents: 0,
    amountPaidCents: 0,
    paidAt: null,
    createdAt: D('2026-10-01T09:00:00Z'),
    documents: [],
    refunds: [],
    items: [],
    ...p,
  };
}

// The J1 deal: goods 11,800 + freight 450, 21% VAT, paid 16 Oct, credit note of €100 net.
const j1 = order({
  id: 'j1',
  status: 'DELIVERED',
  subtotalCents: 1_180_000,
  shippingCents: 45_000,
  totalCents: 1_482_250,
  amountPaidCents: 1_482_250,
  paidAt: D('2026-10-16T12:00:00Z'),
  createdAt: D('2026-10-10T09:00:00Z'),
  documents: [doc('INVOICE', '2026-10-18T00:10:00Z', 1_180_000, 45_000), doc('CREDIT_NOTE', '2026-10-18T00:23:00Z', -10_000, 0)],
  refunds: [{ amountCents: 12_100, status: 'REQUESTED', creditNoteId: 'cn1', createdAt: D('2026-10-18T00:23:00Z') }],
});

test('revenue is excl. VAT, net of credit notes, dated by the payment', () => {
  const ev = revenueEvents(j1);
  assert.deepEqual(ev.map((e) => [e.kind, e.at.toISOString(), e.goodsCents, e.freightCents]), [
    ['SALE', '2026-10-16T12:00:00.000Z', 1_180_000, 45_000],
    ['CREDIT_NOTE', '2026-10-18T00:23:00.000Z', -10_000, 0],
  ]);
  const [eur] = revenueByCurrency(ev);
  assert.equal(eur.cents, 1_170_000); // goods only by default
  assert.equal(eur.creditedCents, -10_000);
  assert.equal(revenueByCurrency(ev, { freight: true })[0].cents, 1_215_000);
});

test('an overpayment sent back without a credit note is not revenue', () => {
  // L2D-2026-YUFT4C: due €1,875.50, received €1,925.50, €50 returned.
  const o = order({
    id: 'over',
    subtotalCents: 150_000,
    shippingCents: 5_000,
    totalCents: 187_550,
    amountPaidCents: 192_550,
    paidAt: D('2026-10-17T12:00:00Z'),
    documents: [doc('INVOICE', '2026-10-17T22:39:00Z', 150_000, 5_000)],
    refunds: [{ amountCents: 5_000, status: 'CONFIRMED', creditNoteId: null, createdAt: D('2026-10-17T22:40:00Z') }],
  });
  const ev = revenueEvents(o);
  assert.deepEqual(ev.map((e) => e.kind), ['SALE']);
  assert.equal(revenueByCurrency(ev)[0].cents, 150_000);
});

test('a refund without a credit note beyond the overpayment takes part of the sale back', () => {
  // Credit notes switched off: €121 refunded on an invoiced €1,210 sale (no overpayment).
  const o = order({
    id: 'nocn',
    subtotalCents: 100_000,
    totalCents: 121_000,
    amountPaidCents: 121_000,
    paidAt: D('2026-10-02T12:00:00Z'),
    documents: [doc('INVOICE', '2026-10-02T12:05:00Z', 100_000, 0)],
    refunds: [
      { amountCents: 12_100, status: 'SENT', creditNoteId: null, createdAt: D('2026-10-05T10:00:00Z') },
      { amountCents: 50_000, status: 'CANCELED', creditNoteId: null, createdAt: D('2026-10-06T10:00:00Z') },
    ],
  });
  const ev = revenueEvents(o);
  assert.deepEqual(ev.map((e) => [e.kind, e.goodsCents]), [['SALE', 100_000], ['REFUND', -10_000]]);
});

test('credit & re-issue of a corrected invoice nets out', () => {
  const o = order({
    id: 'fix',
    subtotalCents: 185_000,
    shippingCents: 18_500,
    totalCents: 246_235,
    amountPaidCents: 246_235,
    paidAt: D('2026-10-18T12:00:00Z'),
    documents: [
      doc('INVOICE', '2026-10-18T01:00:00Z', 185_000, 18_500),
      doc('CREDIT_NOTE', '2026-10-18T01:08:13Z', -185_000, -18_500),
      doc('INVOICE', '2026-10-18T01:08:14Z', 185_000, 18_500),
    ],
  });
  const ev = revenueEvents(o);
  assert.deepEqual(ev.map((e) => e.kind), ['SALE', 'REINVOICE', 'CREDIT_NOTE']);
  // Invoiced before the payment was recorded: the sale is dated by the invoice.
  assert.equal(ev[0].at.toISOString(), '2026-10-18T01:00:00.000Z');
  assert.equal(revenueByCurrency(ev, { freight: true })[0].cents, 203_500);
});

test('canceled after invoicing on terms: invoice and full credit note cancel out; never paid nor invoiced: nothing', () => {
  const terms = order({
    id: 'terms',
    status: 'CANCELED',
    subtotalCents: 200_000,
    shippingCents: 7_500,
    totalCents: 251_075,
    documents: [doc('INVOICE', '2026-10-03T10:00:00Z', 200_000, 7_500), doc('CREDIT_NOTE', '2026-10-04T10:00:00Z', -200_000, -7_500)],
  });
  const ev = revenueEvents(terms);
  assert.equal(ev[0].at.toISOString(), '2026-10-03T10:00:00.000Z');
  assert.equal(revenueByCurrency(ev, { freight: true })[0].cents, 0);
  assert.deepEqual(revenueEvents(order({ id: 'x', status: 'CANCELED', subtotalCents: 5000, totalCents: 6050 })), []);
  assert.deepEqual(revenueEvents(order({ id: 'p', status: 'PENDING_PAYMENT', subtotalCents: 5000, totalCents: 6050 })), []);
});

test('paid order whose invoice is still held counts its order totals on the payment date', () => {
  const o = order({ id: 'held', subtotalCents: 50_000, shippingCents: 2_000, totalCents: 62_920, paidAt: D('2026-10-09T08:00:00Z') });
  assert.equal(saleDateOf(o)?.toISOString(), '2026-10-09T08:00:00.000Z');
  assert.deepEqual(revenueEvents(o).map((e) => [e.kind, e.goodsCents, e.freightCents]), [['SALE', 50_000, 2_000]]);
  // Legacy paid order without a payment date: its creation date.
  assert.equal(saleDateOf(order({ id: 'legacy', status: 'SHIPPED' }))?.toISOString(), '2026-10-01T09:00:00.000Z');
});

test('currencies are never added up', () => {
  const usd = order({
    id: 'usd',
    currency: 'USD',
    subtotalCents: 1_328_000,
    totalCents: 1_606_880,
    paidAt: D('2026-10-12T12:00:00Z'),
    documents: [doc('INVOICE', '2026-10-12T12:00:00Z', 1_328_000, 0)],
  });
  const rows = revenueByCurrency([...revenueEvents(j1), ...revenueEvents(usd)]);
  assert.deepEqual(rows.map((r) => [r.currency, r.cents]), [['USD', 1_328_000], ['EUR', 1_170_000]]);
  assert.equal(formatByCurrency(rows), '$13,280 · €11,700');
  assert.equal(formatByCurrency([]), '€0');
  assert.deepEqual(averageSale(rows), [{ currency: 'USD', cents: 1_328_000 }, { currency: 'EUR', cents: 1_180_000 }]);
});

test('window and series', () => {
  const ev = revenueEvents(j1);
  // From 17 Oct: only the credit note is in the window.
  assert.equal(revenueByCurrency(ev, { from: D('2026-10-17T00:00:00Z') })[0].cents, -10_000);
  const now = D('2026-10-18T12:00:00Z').getTime();
  const s = revenueSeries(ev, { currency: 'EUR', now, buckets: 7, bucketMs: 864e5 });
  assert.equal(s.length, 7);
  assert.equal(s[4], 1_180_000); // 2 days ago
  assert.equal(s[6], -10_000); // today
  assert.equal(revenueSeries(ev, { currency: 'USD', now, buckets: 7, bucketMs: 864e5 }).reduce((a, b) => a + b, 0), 0);
});

test('document split: frozen totals, else SHIPPING lines, else all goods', () => {
  assert.deepEqual(docNetSplit({ subtotalCents: 1000, snapshot: { totals: { shippingCents: 200 } } }), { goodsCents: 800, freightCents: 200 });
  assert.deepEqual(
    docNetSplit({ subtotalCents: 1000, snapshot: { lines: [{ lineType: 'GOODS', netCents: 900 }, { lineType: 'SHIPPING', netCents: 100 }] } }),
    { goodsCents: 900, freightCents: 100 },
  );
  assert.deepEqual(docNetSplit({ subtotalCents: 1000, snapshot: null }), { goodsCents: 1000, freightCents: 0 });
});

test('invoice chain: the replaced invoice and its credit note apart from the real credits', () => {
  const inv23 = doc('INVOICE', '2026-10-18T00:20:00Z', 185_000, 18_500, 2100, { id: 'inv23' });
  const cn8 = doc('CREDIT_NOTE', '2026-10-18T01:08:13Z', -185_000, -18_500, 2100, { id: 'cn8', originalDocumentId: 'inv23' });
  const inv24 = doc('INVOICE', '2026-10-18T01:08:14Z', 185_000, 18_500, 2100, { id: 'inv24', originalDocumentId: 'inv23' });
  const cn9 = doc('CREDIT_NOTE', '2026-10-20T09:00:00Z', -10_000, 0, 2100, { id: 'cn9', originalDocumentId: 'inv24' });
  const legacy = doc('CREDIT_NOTE', '2026-10-21T09:00:00Z', -5_000, 0, 2100, { id: 'old' });
  const c = invoiceChain([cn9, inv24, cn8, inv23, legacy]);
  assert.equal(c.current?.id, 'inv24');
  assert.deepEqual(c.replaced.map((d) => d.id), ['inv23']);
  assert.deepEqual(c.replacementCredits.map((d) => d.id), ['cn8']);
  // A credit note that names no invoice counts as a credit of the current one.
  assert.deepEqual(c.credits.map((d) => d.id), ['cn9', 'old']);
  assert.deepEqual(invoiceChain([]), { current: null, replaced: [], replacementCredits: [], credits: [] });
});

test('margin scheme: revenue excl. VAT leaves out the margin VAT inside the price', () => {
  // €6,500 second-hand unit bought for €4,200 (margin VAT €399.17) + €150 freight.
  const items = [{ priceCentsSnapshot: 650_000, quantity: 1, product: { vatScheme: 'MARGIN', purchaseCostCents: 420_000 } }];
  const o = order({
    id: 'margin',
    vatTreatment: 'MARGIN_SCHEME',
    subtotalCents: 650_000,
    shippingCents: 15_000,
    totalCents: 668_150,
    paidAt: D('2026-10-20T09:00:00Z'),
    items,
    documents: [doc('INVOICE', '2026-10-20T10:00:00Z', 650_000, 15_000, 0, { id: 'mi', vatTreatment: 'MARGIN_SCHEME' })],
  });
  const ev = revenueEvents(o, { marginRateBp: 2100 });
  assert.deepEqual(ev.map((e) => [e.kind, e.goodsCents, e.freightCents]), [['SALE', 610_083, 15_000]]);
  // Credited in full: back to zero.
  const credited = { ...o, documents: [...o.documents, doc('CREDIT_NOTE', '2026-10-21T10:00:00Z', -650_000, -15_000, 0, { id: 'mc', vatTreatment: 'MARGIN_SCHEME', originalDocumentId: 'mi' })] };
  assert.equal(revenueByCurrency(revenueEvents(credited, { marginRateBp: 2100 }), { freight: true })[0].cents, 0);
  // Paid, invoice still held: the order's own margin.
  assert.equal(revenueEvents({ ...o, documents: [] }, { marginRateBp: 2100 })[0].goodsCents, 610_083);
  // Without a rate nothing is taken off.
  assert.equal(revenueEvents(o)[0].goodsCents, 650_000);
});
