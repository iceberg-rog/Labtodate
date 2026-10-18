import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import { takeQuoteUnit } from './stock';

// A transaction client with just the calls the quote hold makes: the unit is
// taken with a guarded decrement (quantity ≥ qty) and the hold is consumed.
function fakeTx(stock: number) {
  const state = { stock, holds: [] as Array<{ id: string; refId: string; consumed: boolean }>, consumedCalls: 0 };
  const tx = {
    stockReservation: {
      findFirst: async ({ where }: { where: { refId: string } }) => state.holds.find((h) => h.refId === where.refId && !h.consumed) ?? null,
      create: async ({ data }: { data: { refId: string } }) => {
        const h = { id: `h${state.holds.length + 1}`, refId: data.refId, consumed: false };
        state.holds.push(h);
        return { id: h.id };
      },
      update: async () => ({}),
      updateMany: async ({ where }: { where: { refId: string } }) => {
        state.consumedCalls++;
        let count = 0;
        for (const h of state.holds) if (h.refId === where.refId && !h.consumed) { h.consumed = true; count++; }
        return { count };
      },
    },
    product: {
      updateMany: async ({ where }: { where: { quantity: { gte: number } } }) => {
        if (state.stock < where.quantity.gte) return { count: 0 };
        state.stock -= where.quantity.gte;
        return { count: 1 };
      },
    },
  };
  return { state, tx: tx as unknown as Prisma.TransactionClient };
}

const order = { id: 'o1', sourcingRequestId: 'q1', items: [{ productId: 'p1', quantity: 1 }] };

beforeEach(() => {
  delete process.env.STOCK_RESERVE_ON;
});

test('an order without a quote has no quote unit to take', async () => {
  const { state, tx } = fakeTx(0);
  assert.deepEqual(await takeQuoteUnit(tx, { ...order, sourcingRequestId: null }), { ok: true, short: false, warning: '' });
  assert.equal(state.consumedCalls, 0);
});

test('unit held since the offer / acceptance: the hold is consumed (sold)', async () => {
  process.env.STOCK_RESERVE_ON = 'OFFER_ACCEPTED';
  const { state, tx } = fakeTx(0);
  state.holds.push({ id: 'h0', refId: 'q1', consumed: false });
  assert.deepEqual(await takeQuoteUnit(tx, order), { ok: true, short: false, warning: '' });
  assert.equal(state.holds[0].consumed, true);
});

test('PAYMENT_VERIFIED: the unit is taken now; when it is gone the result is short', async () => {
  process.env.STOCK_RESERVE_ON = 'PAYMENT_VERIFIED';
  const inStock = fakeTx(1);
  assert.deepEqual(await takeQuoteUnit(inStock.tx, order), { ok: true, short: false, warning: '' });
  assert.equal(inStock.state.stock, 0);
  assert.equal(inStock.state.holds[0]?.consumed, true);

  const gone = fakeTx(0);
  const r = await takeQuoteUnit(gone.tx, order);
  assert.equal(r.ok, false);
  assert.equal(r.short, true);
  assert.match(r.warning, /could not be taken from stock/);
  assert.equal(gone.state.holds.length, 0);
});
