import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import { holdLapseNeedsNotice, holdLapsedNotice, holdUnitForQuote, sellQuoteUnit, takeQuoteUnit } from './stock';
import { reserveStock } from '@/lib/stock/reserve';

// An in-memory transaction client with the StockReservation / Product calls
// the holds make: where clauses with equality, null, { not: null } and
// { gte }, guarded decrements and increments.
type Hold = { id: string; productId: string; qty: number; source: string; refId: string; orderId: string | null; expiresAt: Date | null; releasedAt: Date | null; consumedAt: Date | null };
type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond === null) return v === null;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; gte?: number };
      if ('not' in c) return c.not === null ? v !== null : v !== c.not;
      if ('gte' in c) return typeof v === 'number' && v >= (c.gte as number);
    }
    return v === cond;
  });
}

function fakeDb(stock: Record<string, number>) {
  const state = { stock: { ...stock }, holds: [] as Hold[] };
  const tx = {
    stockReservation: {
      findFirst: async ({ where }: { where: Where }) => state.holds.find((h) => matches(h, where)) ?? null,
      create: async ({ data }: { data: Omit<Hold, 'id' | 'releasedAt' | 'consumedAt'> }) => {
        const h: Hold = { id: `h${state.holds.length + 1}`, releasedAt: null, consumedAt: null, ...data };
        state.holds.push(h);
        return { id: h.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Hold> }) => {
        const h = state.holds.find((x) => x.id === where.id)!;
        Object.assign(h, data);
        return h;
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<Hold> }) => {
        let count = 0;
        for (const h of state.holds) if (matches(h, where)) { Object.assign(h, data); count++; }
        return { count };
      },
    },
    product: {
      updateMany: async ({ where, data }: { where: { id: string; quantity?: { gte: number } }; data: { quantity: { decrement?: number; increment?: number } } }) => {
        const q = state.stock[where.id];
        if (q === undefined) return { count: 0 };
        if (where.quantity && q < where.quantity.gte) return { count: 0 };
        state.stock[where.id] = q - (data.quantity.decrement ?? 0) + (data.quantity.increment ?? 0);
        return { count: 1 };
      },
    },
  };
  return { state, tx: tx as unknown as Prisma.TransactionClient };
}

const order = (id: string, quoteId: string, quantity = 1) => ({ id, sourcingRequestId: quoteId, items: [{ productId: 'p1', quantity }] });

beforeEach(() => {
  delete process.env.STOCK_RESERVE_ON;
});

test('an order without a quote has no quote unit to take', async () => {
  const { state, tx } = fakeDb({ p1: 0 });
  assert.deepEqual(await takeQuoteUnit(tx, { ...order('o1', 'q1'), sourcingRequestId: null }), { ok: true, short: false, warning: '' });
  assert.equal(state.holds.length, 0);
});

test('unit held since the offer / acceptance: the hold is consumed (sold), no second unit is taken', async () => {
  const { state, tx } = fakeDb({ p1: 2 });
  assert.equal((await holdUnitForQuote(tx, { quoteId: 'q1', productId: 'p1', qty: 1, orderId: 'o1' })).ok, true);
  assert.equal(state.stock.p1, 1);
  assert.deepEqual(await takeQuoteUnit(tx, order('o1', 'q1')), { ok: true, short: false, warning: '' });
  assert.equal(state.stock.p1, 1);
  assert.ok(state.holds[0].consumedAt);
});

test('PAYMENT_VERIFIED: two buyers paid for one unit — the first takes it, the second is short and takes nothing', async () => {
  process.env.STOCK_RESERVE_ON = 'PAYMENT_VERIFIED';
  const { state, tx } = fakeDb({ p1: 1 });
  assert.deepEqual(await takeQuoteUnit(tx, order('o1', 'q1')), { ok: true, short: false, warning: '' });
  assert.equal(state.stock.p1, 0);
  const second = await takeQuoteUnit(tx, order('o2', 'q2'));
  assert.equal(second.ok, false);
  assert.equal(second.short, true);
  assert.match(second.warning, /^Unit no longer in stock/);
  assert.match(second.warning, /refund, backorder or another unit/);
  assert.equal(state.stock.p1, 0, 'never negative');
  assert.equal(state.holds.filter((h) => h.refId === 'q2').length, 0, 'no hold for the short order');
});

test('decided by state, not by the setting: orders accepted without a hold take their unit even after the mode changed', async () => {
  // Accepted under PAYMENT_VERIFIED (no hold), verified after switching to OFFER_ACCEPTED.
  process.env.STOCK_RESERVE_ON = 'OFFER_ACCEPTED';
  const { state, tx } = fakeDb({ p1: 2 });
  assert.equal((await takeQuoteUnit(tx, order('o1', 'q1'))).ok, true);
  assert.equal((await takeQuoteUnit(tx, order('o2', 'q2'))).ok, true);
  assert.equal(state.stock.p1, 0, 'each paid order consumed exactly one unit');
  assert.equal(state.holds.filter((h) => h.consumedAt).length, 2);
});

test('idempotent per order: a second "paid" path for the same order takes nothing more', async () => {
  const { state, tx } = fakeDb({ p1: 3 });
  await takeQuoteUnit(tx, order('o1', 'q1'));
  await takeQuoteUnit(tx, order('o1', 'q1'));
  assert.equal(state.stock.p1, 2);
  assert.equal(state.holds.length, 1);
});

test('the hold follows the order quantity before it is consumed', async () => {
  const { state, tx } = fakeDb({ p1: 3 });
  await holdUnitForQuote(tx, { quoteId: 'q1', productId: 'p1', qty: 1, expiresAt: new Date('2030-01-01') });
  await takeQuoteUnit(tx, order('o1', 'q1', 2));
  assert.equal(state.stock.p1, 1);
  assert.equal(state.holds[0].qty, 2);
  assert.ok(state.holds[0].consumedAt);
});

test('sellQuoteUnit: "" when taken, a staff warning sentence when short', async () => {
  const { tx } = fakeDb({ p1: 1 });
  assert.equal(await sellQuoteUnit(tx, 'q1', 'o1', { productId: 'p1', quantity: 1 }), '');
  assert.match(await sellQuoteUnit(tx, 'q2', 'o2', { productId: 'p1', quantity: 1 }), /^ Warning: Unit no longer in stock/);
});

test('OFFER_SENT revision: offer qty 1 → 2 → 1 resizes the hold (3-unit listing)', async () => {
  const { state, tx } = fakeDb({ p1: 3 });
  const until = new Date('2030-01-01');
  assert.equal((await holdUnitForQuote(tx, { quoteId: 'q1', productId: 'p1', qty: 1, expiresAt: until })).ok, true);
  assert.equal(state.stock.p1, 2);
  assert.equal((await holdUnitForQuote(tx, { quoteId: 'q1', productId: 'p1', qty: 2, expiresAt: until })).ok, true);
  assert.equal(state.holds.length, 1);
  assert.equal(state.holds[0].qty, 2);
  assert.equal(state.stock.p1, 1, 'reservation 2, one unit left');
  assert.equal((await holdUnitForQuote(tx, { quoteId: 'q1', productId: 'p1', qty: 1, expiresAt: until })).ok, true);
  assert.equal(state.holds[0].qty, 1);
  assert.equal(state.stock.p1, 2);
});

test('a revision beyond the stock fails with "not enough units" and changes nothing', async () => {
  const { state, tx } = fakeDb({ p1: 2 });
  await holdUnitForQuote(tx, { quoteId: 'q1', productId: 'p1', qty: 1 });
  const r = await holdUnitForQuote(tx, { quoteId: 'q1', productId: 'p1', qty: 3 });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : '', /Not enough units in stock for 3/);
  assert.equal(state.stock.p1, 1);
  assert.equal(state.holds[0].qty, 1);
});

test('reserveStock reports the size change of an existing hold', async () => {
  const { tx } = fakeDb({ p1: 5 });
  const first = await reserveStock({ productId: 'p1', qty: 2, source: 'QUOTE', refId: 'q1' }, tx);
  assert.deepEqual(first.ok && [first.created, first.delta], [true, 2]);
  const same = await reserveStock({ productId: 'p1', qty: 2, source: 'QUOTE', refId: 'q1' }, tx);
  assert.deepEqual(same.ok && [same.created, same.delta], [false, 0]);
  const down = await reserveStock({ productId: 'p1', qty: 1, source: 'QUOTE', refId: 'q1' }, tx);
  assert.deepEqual(down.ok && [down.created, down.delta], [false, -1]);
});

test('lapsed hold notice: the buyer is told the unit is back on sale and the offer is still valid', () => {
  const n = holdLapsedNotice({
    quoteId: 'cm123456abcdef', buyerName: 'Dr <Lab>', item: 'Agilent 1260 HPLC', qty: 1,
    expiredAt: new Date('2026-10-20T10:00:00Z'), validUntilAt: new Date('2026-10-28T23:59:59Z'),
  });
  assert.match(n.subject, /The reservation for your offer has ended/);
  const html = n.html('https://example.test/app/quotes/x');
  assert.match(html, /back on sale/);
  assert.match(html, /stays valid until 28 Oct 2026/);
  assert.match(html, /Dr &lt;Lab&gt;/);
  assert.match(n.buyerNote, /valid until 28 Oct 2026/);
  assert.match(n.staffBody({ ok: true }), /buyer was e-mailed; the offer stays valid/);
  assert.match(n.staffBody({ ok: false, error: '550 rejected' }), /NOT reached by e-mail \(550 rejected\)/);
  const many = holdLapsedNotice({ quoteId: 'cm1', buyerName: 'B', item: 'Centrifuge', qty: 2, expiredAt: new Date('2026-10-20T10:00:00Z'), validUntilAt: null });
  assert.match(many.html('https://example.test/q'), /2 units of/);
  assert.match(many.buyerNote, /Your offer stays open while/);
});

test('a lapsed hold is announced only while its offer is still valid', () => {
  const until = new Date('2026-10-28T23:59:59Z');
  const open = { status: 'RESPONDED', archivedAt: null, validUntilAt: until };
  // RESERVATION_HOLD_DAYS shorter than the validity: the hold ends first → notice.
  assert.equal(holdLapseNeedsNotice(open, new Date('2026-10-20T10:05:00Z')), true);
  // Default (no RESERVATION_HOLD_DAYS): hold expiry = validUntil, so the sweep sees an
  // expired offer — the offer-expiry handling covers it, no second notice.
  assert.equal(holdLapseNeedsNotice(open, new Date(until.getTime() + 60_000)), false);
  assert.equal(holdLapseNeedsNotice(open, until), false, 'expired at the very moment of validUntil');
  // No longer an open offer: its own ending already told everyone.
  assert.equal(holdLapseNeedsNotice({ ...open, status: 'ACCEPTED' }, new Date('2026-10-20T10:05:00Z')), false);
  assert.equal(holdLapseNeedsNotice({ ...open, archivedAt: new Date('2026-10-19T00:00:00Z') }, new Date('2026-10-20T10:05:00Z')), false);
  // An offer without a validity date stays open.
  assert.equal(holdLapseNeedsNotice({ ...open, validUntilAt: null }, new Date('2026-10-20T10:05:00Z')), true);
});
