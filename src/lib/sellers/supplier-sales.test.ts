import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteDealSupplierId,
  saleNoticeApplies,
  saleNoticeContent,
  saleStage,
  stageDates,
  supplierLinesOf,
  totalsByCurrency,
  type SaleOrderInput,
} from './supplier-sales';
import { settingDef } from '../settings/defs';

const S1 = { id: 's1', role: 'SELLER' };
const S2 = { id: 's2', role: 'SELLER' };
const STAFF = { id: 'a1', role: 'ADMIN' };
const d = (s: string) => new Date(`${s}T10:00:00Z`);

function order(p: Partial<SaleOrderInput> = {}): SaleOrderInput {
  return {
    id: 'o1',
    orderNumber: 'L2D-2026-ABC123',
    status: 'PAID',
    currency: 'EUR',
    subtotalCents: 1_150_000,
    paidAt: d('2026-10-10'),
    createdAt: d('2026-10-09'),
    shippedAt: null,
    deliveredAt: null,
    sourcingRequest: null,
    items: [],
    shipments: [],
    ...p,
  };
}

// RFQ-QQ83M2: supplier price €10,000, buyer price €11,500 (G5).
const quoteDeal = order({
  sourcingRequest: {
    id: 'q1',
    assignedTo: S1,
    product: null,
    offerSupplierCostCents: 1_000_000,
    offerSupplierCostCurrency: null,
    sellerProposalCurrency: 'EUR',
    quotedCurrency: 'EUR',
  },
  items: [{ id: 'i1', titleSnapshot: 'Thermo Orbitrap', quantity: 1, lineType: 'GOODS', priceCentsSnapshot: 1_150_000, basePriceCents: null, product: null }],
});

test('a paid quote deal is owed at the supplier price, never the buyer price (D15)', () => {
  const lines = supplierLinesOf(quoteDeal).get('s1') ?? [];
  assert.equal(lines.length, 1);
  assert.equal(lines[0].supplierCents, 1_000_000);
  assert.equal(lines[0].supplierCurrency, 'EUR');
  assert.equal(lines[0].quoteId, 'q1');
  assert.deepEqual(totalsByCurrency(lines), [{ currency: 'EUR', cents: 1_000_000 }]);
});

test('the supplier cost keeps its own currency', () => {
  const gbp = order({ ...quoteDeal, sourcingRequest: { ...quoteDeal.sourcingRequest!, offerSupplierCostCents: 380_000, offerSupplierCostCurrency: 'GBP' } });
  assert.equal(supplierLinesOf(gbp).get('s1')?.[0].supplierCurrency, 'GBP');
});

test('a quote handled by staff belongs to the supplier who owns the anchored listing (no inbox link)', () => {
  const sr = { assignedTo: STAFF, product: { seller: S2 } };
  assert.equal(quoteDealSupplierId(sr), 's2');
  assert.equal(quoteDealSupplierId({ assignedTo: S1, product: { seller: S2 } }), 's1');
  assert.equal(quoteDealSupplierId({ assignedTo: null, product: { seller: STAFF } }), null);
  const staffDeal = order({ ...quoteDeal, sourcingRequest: { ...quoteDeal.sourcingRequest!, assignedTo: STAFF, product: { seller: S2 } } });
  assert.equal(supplierLinesOf(staffDeal).get('s2')?.[0].quoteId, null);
});

test('listing sales are owed the listing price before our margin, per supplier', () => {
  const o = order({
    items: [
      { id: 'i1', titleSnapshot: 'Balance', quantity: 2, lineType: 'GOODS', priceCentsSnapshot: 115_000, basePriceCents: 100_000, product: { seller: S1 } },
      { id: 'i2', titleSnapshot: 'Centrifuge', quantity: 1, lineType: 'GOODS', priceCentsSnapshot: 500_000, basePriceCents: 500_000, product: { seller: STAFF } },
      { id: 'i3', titleSnapshot: 'Freight', quantity: 1, lineType: 'SHIPPING', priceCentsSnapshot: 18_500, basePriceCents: null, product: null },
      { id: 'i4', titleSnapshot: 'Pipette', quantity: 1, lineType: 'GOODS', priceCentsSnapshot: 9_900, basePriceCents: null, product: { seller: S2 } },
    ],
  });
  const m = supplierLinesOf(o);
  assert.deepEqual([...m.keys()].sort(), ['s1', 's2']);
  assert.equal(m.get('s1')?.[0].supplierCents, 200_000);
  // Legacy line without the pre-margin price: no amount rather than a guess.
  assert.equal(m.get('s2')?.[0].supplierCents, null);
  assert.deepEqual(totalsByCurrency(m.get('s2') ?? []), []);
});

test('totals never add different currencies', () => {
  assert.deepEqual(
    totalsByCurrency([
      { supplierCents: 100, supplierCurrency: 'EUR' },
      { supplierCents: 50, supplierCurrency: 'GBP' },
      { supplierCents: 25, supplierCurrency: 'EUR' },
      { supplierCents: null, supplierCurrency: 'USD' },
    ]),
    [{ currency: 'EUR', cents: 125 }, { currency: 'GBP', cents: 50 }],
  );
});

test('shipped / delivered per supplier follow its own shipments (partial shipments)', () => {
  const items = [{ id: 'i1', quantity: 2 }];
  const partial = { status: 'SHIPPED', shippedAt: d('2026-10-11'), deliveredAt: null, shipments: [{ shippedAt: d('2026-10-11'), deliveredAt: null, items: [{ orderItemId: 'i1', qty: 1 }] }] };
  assert.deepEqual(stageDates(partial, items), { shippedAt: null, deliveredAt: null });
  const both = { ...partial, shipments: [...partial.shipments, { shippedAt: d('2026-10-12'), deliveredAt: d('2026-10-14'), items: [{ orderItemId: 'i1', qty: 1 }] }] };
  assert.deepEqual(stageDates(both, items), { shippedAt: d('2026-10-12'), deliveredAt: null });
  // Orders shipped before shipment rows existed: the order's own dates.
  assert.deepEqual(stageDates({ status: 'DELIVERED', shippedAt: d('2026-10-11'), deliveredAt: d('2026-10-13'), shipments: [] }, items), {
    shippedAt: d('2026-10-11'),
    deliveredAt: d('2026-10-13'),
  });
  assert.equal(saleStage({ orderStatus: 'PAID', shippedAt: null, deliveredAt: null }), 'paid');
  assert.equal(saleStage({ orderStatus: 'DELIVERED', shippedAt: d('2026-10-11'), deliveredAt: d('2026-10-13') }), 'delivered');
  assert.equal(saleStage({ orderStatus: 'REFUNDED', shippedAt: null, deliveredAt: null }), 'canceled');
});

test('which notice is due: paid unless the unit is short, shipped / delivered when all of it moved, cancel before dispatch only', () => {
  const open = [{ shippedAt: null, deliveredAt: null }];
  const moved = [{ shippedAt: d('2026-10-11'), deliveredAt: d('2026-10-13') }];
  assert.equal(saleNoticeApplies('PAID', { status: 'PAID', openHolds: [] }, open), true);
  assert.equal(saleNoticeApplies('PAID', { status: 'PAID', openHolds: ['STOCK_SHORTAGE'] }, open), false);
  assert.equal(saleNoticeApplies('PAID', { status: 'PENDING_PAYMENT', openHolds: [] }, open), false);
  assert.equal(saleNoticeApplies('SHIPPED', { status: 'SHIPPED', openHolds: [] }, open), false);
  assert.equal(saleNoticeApplies('SHIPPED', { status: 'SHIPPED', openHolds: [] }, moved), true);
  assert.equal(saleNoticeApplies('DELIVERED', { status: 'DELIVERED', openHolds: [] }, moved), true);
  assert.equal(saleNoticeApplies('CANCELED', { status: 'CANCELED', openHolds: [] }, open), true);
  assert.equal(saleNoticeApplies('CANCELED', { status: 'REFUNDED', openHolds: [] }, moved), false);
  assert.equal(saleNoticeApplies('PAID', { status: 'PAID', openHolds: [] }, []), false);
});

test('the sold notice names the unit and the supplier price only — no buyer price, no buyer', () => {
  const lines = supplierLinesOf(quoteDeal).get('s1') ?? [];
  const c = saleNoticeContent('PAID', quoteDeal.orderNumber, lines, { dispatchText: 'Keep it reserved.' });
  const all = [c.title, c.body, c.subject, c.heading, c.lead, c.next ?? '', ...c.rows.flat().map(String)].join(' | ');
  assert.match(c.title, /Unit sold — prepare it for dispatch/);
  assert.match(all, /€10,000 excl\. VAT/);
  assert.match(all, /Keep it reserved\./);
  assert.match(all, /L2D-2026-ABC123/);
  assert.doesNotMatch(all, /11,500/);
  assert.ok(c.body.length <= 500 && c.title.length <= 140);
  for (const ev of ['SHIPPED', 'DELIVERED', 'CANCELED'] as const) {
    const n = saleNoticeContent(ev, quoteDeal.orderNumber, lines, { dispatchText: '' });
    assert.doesNotMatch([n.title, n.body, n.subject, n.lead].join(' '), /11,500/, ev);
  }
  assert.match(saleNoticeContent('CANCELED', 'X', lines, { dispatchText: '' }).next ?? '', /Do not dispatch/);
});

test('the next-step text of the sold notice is an admin setting without a brand', () => {
  const def = settingDef('SELLER_DISPATCH_TEXT');
  assert.equal(def?.group, 'Suppliers');
  assert.ok((def?.default ?? '').length > 20);
  assert.doesNotMatch(def?.default ?? '', /lab2date|Labtodate/i);
  for (const k of ['SELLER_PROGRAMME_PUBLIC', 'SELLER_TERMS_TEXT', 'SELLER_PAYOUT_TERMS_TEXT']) assert.equal(settingDef(k)?.pending, undefined, k);
  assert.equal(settingDef('SELLER_PROGRAMME_PUBLIC')?.default, 'false');
});
