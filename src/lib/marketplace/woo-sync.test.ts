import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncStockInputs } from './woo-sync';
import { targetQuantity, type ShopSyncPolicy } from './woo-sync-plan';

const policy = (syncStockMode: ShopSyncPolicy['syncStockMode']): ShopSyncPolicy => ({
  syncPolicy: 'PRICE_STOCK_ONLY', syncStockMode, autoPublishImports: false, archiveMissingAtSource: false, importDefaultQuantity: 1,
});
type Src = Parameters<typeof targetQuantity>[0];
const src = (sourceQty: number | null): Src => ({ inStock: true, sourceQty } as Src);

/** The quantity a sync would set for a listing (as runWooSync plans it). */
function planned(mode: ShopSyncPolicy['syncStockMode'], s: Src, sold: number, held: number, local: number): number {
  const i = syncStockInputs(mode, sold, held);
  return targetQuantity(s, policy(i.syncStockMode), i.committedUnits, local);
}

test('a unit held by an open offer is not raised again by the supplier sync (both stock modes)', () => {
  // One unit at the source, held for an open offer: our available count is 0.
  assert.equal(planned('SUBTRACT_LOCAL_SALES', src(1), 0, 1, 0), 0);
  assert.equal(planned('SOURCE_IS_TRUTH', src(1), 0, 1, 0), 0);
  // "In stock" without a number: the shop default (1) minus the held unit.
  assert.equal(planned('SUBTRACT_LOCAL_SALES', src(null), 0, 1, 0), 0);
  assert.equal(planned('SOURCE_IS_TRUTH', src(null), 0, 1, 0), 0);
  // Three at the source, two held: one left to sell.
  assert.equal(planned('SOURCE_IS_TRUTH', src(3), 0, 2, 1), 1);
});

test('without holds the stock modes behave as before', () => {
  assert.equal(planned('SUBTRACT_LOCAL_SALES', src(3), 1, 0, 2), 2, 'source minus local sales');
  assert.equal(planned('SOURCE_IS_TRUTH', src(3), 1, 0, 2), 3, 'source as-is');
  assert.deepEqual(syncStockInputs('SOURCE_IS_TRUTH', 4, 0), { committedUnits: 4, syncStockMode: 'SOURCE_IS_TRUTH' });
  assert.deepEqual(syncStockInputs('SUBTRACT_LOCAL_SALES', 4, 2), { committedUnits: 6, syncStockMode: 'SUBTRACT_LOCAL_SALES' });
});
