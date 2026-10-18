import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldUnitsByProduct, syncStockInputs, type HeldUnits } from './woo-sync';
import { targetQuantity, type ShopSyncPolicy } from './woo-sync-plan';

const policy = (syncStockMode: ShopSyncPolicy['syncStockMode']): ShopSyncPolicy => ({
  syncPolicy: 'PRICE_STOCK_ONLY', syncStockMode, autoPublishImports: false, archiveMissingAtSource: false, importDefaultQuantity: 1,
});
type Src = Parameters<typeof targetQuantity>[0];
const src = (sourceQty: number | null): Src => ({ inStock: true, sourceQty } as Src);
const open = (noOrder: number): HeldUnits => ({ noOrder, liveOrder: 0 });

/** The quantity a sync would set for a listing (as runWooSync plans it). */
function planned(mode: ShopSyncPolicy['syncStockMode'], s: Src, sold: number, held: HeldUnits, local: number): number {
  const i = syncStockInputs(mode, sold, held);
  return targetQuantity(s, policy(i.syncStockMode), i.committedUnits, local);
}

test('a unit held by an open offer is not raised again by the supplier sync (both stock modes)', () => {
  // One unit at the source, held for an open offer: our available count is 0.
  assert.equal(planned('SUBTRACT_LOCAL_SALES', src(1), 0, open(1), 0), 0);
  assert.equal(planned('SOURCE_IS_TRUTH', src(1), 0, open(1), 0), 0);
  // "In stock" without a number: the shop default (1) minus the held unit.
  assert.equal(planned('SUBTRACT_LOCAL_SALES', src(null), 0, open(1), 0), 0);
  assert.equal(planned('SOURCE_IS_TRUTH', src(null), 0, open(1), 0), 0);
  // Three at the source, two held: one left to sell.
  assert.equal(planned('SOURCE_IS_TRUTH', src(3), 0, open(2), 1), 1);
});

test('holds are split by whether a live order counts them', () => {
  const m = heldUnitsByProduct([
    { productId: 'p1', qty: 1, orderStatus: null }, // open offer
    { productId: 'p1', qty: 2, orderStatus: 'PENDING_PAYMENT' }, // accepted quote, not paid
    { productId: 'p1', qty: 1, orderStatus: 'CANCELED' }, // left on a canceled order: no order counts it
    { productId: 'p2', qty: 1, orderStatus: 'PENDING_PAYMENT' },
  ]);
  assert.deepEqual(m.get('p1'), { noOrder: 2, liveOrder: 2 });
  assert.deepEqual(m.get('p2'), { noOrder: 0, liveOrder: 1 });
  assert.equal(m.get('p3'), undefined);
});

test('a unit held for an accepted but unpaid quote order is not raised again (SOURCE_IS_TRUTH)', () => {
  // OFFER_ACCEPTED, 1 unit: the buyer accepted → QUOTE hold with an orderId, quantity 0, OrderItem 1.
  const held = heldUnitsByProduct([{ productId: 'p1', qty: 1, orderStatus: 'PENDING_PAYMENT' }]).get('p1')!;
  assert.equal(planned('SOURCE_IS_TRUTH', src(1), 1, held, 0), 0, 'the held unit stays unbuyable');
  assert.equal(planned('SUBTRACT_LOCAL_SALES', src(1), 1, held, 0), 0, 'counted once, through its OrderItem');
  // Three at the source, one held for the unpaid order: two left to sell.
  assert.equal(planned('SOURCE_IS_TRUTH', src(3), 1, held, 2), 2);
  // Once paid the hold is consumed (no longer active): the supplier's count is the truth again.
  assert.equal(planned('SOURCE_IS_TRUTH', src(0), 1, open(0), 0), 0);
  assert.equal(planned('SOURCE_IS_TRUTH', src(2), 1, open(0), 0), 2);
});

test('without holds the stock modes behave as before', () => {
  assert.equal(planned('SUBTRACT_LOCAL_SALES', src(3), 1, open(0), 2), 2, 'source minus local sales');
  assert.equal(planned('SOURCE_IS_TRUTH', src(3), 1, open(0), 2), 3, 'source as-is');
  assert.deepEqual(syncStockInputs('SOURCE_IS_TRUTH', 4, open(0)), { committedUnits: 4, syncStockMode: 'SOURCE_IS_TRUTH' });
  assert.deepEqual(syncStockInputs('SUBTRACT_LOCAL_SALES', 4, open(2)), { committedUnits: 6, syncStockMode: 'SUBTRACT_LOCAL_SALES' });
  // An unpaid order's hold is already in its OrderItem: not subtracted twice.
  assert.deepEqual(syncStockInputs('SUBTRACT_LOCAL_SALES', 4, { noOrder: 0, liveOrder: 3 }), { committedUnits: 4, syncStockMode: 'SUBTRACT_LOCAL_SALES' });
  assert.deepEqual(syncStockInputs('SOURCE_IS_TRUTH', 4, { noOrder: 1, liveOrder: 3 }), { committedUnits: 4, syncStockMode: 'SUBTRACT_LOCAL_SALES' });
});
