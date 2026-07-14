/**
 * Disposable-DB integration test — order/checkout atomicity (production helpers).
 * ----------------------------------------------------------------------------
 * Drives the REAL exported helpers against a real Postgres and asserts the
 * DB-transaction guarantees that cannot be shown offline:
 *   reserveAndCreateOrder    — forced create-failure rollback (single + multi,
 *                              incl. cart rows intact), partial-reservation rollback,
 *                              REAL orderNumber P2002 (seeded duplicate) whole-tx retry,
 *                              concurrent last-unit race, buyability/financial guard
 *                              (status/mode + price/currency), exact cart-snapshot clear
 *                              (concurrent add survives, concurrent qty change rolls back)
 *   cancelAndRestockOrder    — cancel+restock once, noop on CANCELED and on PAID,
 *                              forced restock-failure rollback + safe retry
 *   stripeCheckoutHandoff    — no-Stripe, create failure, cleanup failure, missing URL,
 *                              persist failure, expire failure; proves no active session
 *                              points at canceled stock and no confirmed failure strands stock
 *   expireProformaTransition — expired / proof-in-flight / no-order / overlapping / interleave
 *
 * Requires env SCRATCH_DATABASE_URL (a migrated, empty DB).
 * Run: SCRATCH_DATABASE_URL=... npx tsx scripts/it-order-atomicity.ts
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { reserveAndCreateOrder, cancelAndRestockOrder, generateOrderNumber, type Reservation } from '../src/lib/orders/checkout-tx';
import { stripeCheckoutHandoff, cancelOrderSaga, cancelOrdersBatch, type StripeSessionApi } from '../src/lib/orders/stripe-handoff';
import { safeExpire } from '../src/lib/stripe/session-api';
import { expireProformaTransition } from '../src/lib/quotes/proforma-expiry';

const URL = process.env.SCRATCH_DATABASE_URL;
if (!URL) { console.error('SCRATCH_DATABASE_URL required'); process.exit(2); }
const db = new PrismaClient({ datasources: { db: { url: URL } } });

let pass = 0; let fail = 0; const rows: string[] = [];
function chk(name: string, ok: boolean, detail = '') { rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); ok ? pass++ : fail++; }

// ── fault injection: wrap $transaction so the tx client throws on a chosen op ──
type Fault = { key: string; error: () => unknown; times?: number };
function withFault(real: PrismaClient, fault: Fault): PrismaClient {
  let fired = 0;
  const wrapTx = (tx: unknown) => new Proxy(tx as object, {
    get(t, model) {
      const m = Reflect.get(t, model);
      if (m && typeof m === 'object' && ['order', 'product', 'cartItem', 'orderItem', 'sourcingRequest'].includes(String(model))) {
        return new Proxy(m, {
          get(mm, op) {
            const fn = Reflect.get(mm, op);
            if (typeof fn !== 'function') return fn;
            return async (...args: unknown[]) => {
              if (`${String(model)}.${String(op)}` === fault.key && fired < (fault.times ?? 1)) { fired++; throw fault.error(); }
              return (fn as (...a: unknown[]) => unknown).apply(mm, args);
            };
          },
        });
      }
      return m;
    },
  });
  return new Proxy(real, {
    get(target, prop, recv) {
      if (prop === '$transaction') {
        return (arg: unknown, opts?: unknown) =>
          typeof arg === 'function'
            ? (real.$transaction as (f: (tx: unknown) => unknown, o?: unknown) => unknown)((tx) => (arg as (t: unknown) => unknown)(wrapTx(tx)), opts)
            : (real.$transaction as (a: unknown, o?: unknown) => unknown)(arg, opts);
      }
      return Reflect.get(target, prop, recv);
    },
  }) as PrismaClient;
}
const boom = () => new Error('injected failure');

// ── seeding helpers ──────────────────────────────────────────────────────────
let seq = 0;
const uid = () => `it_${Date.now().toString(36)}_${seq++}`;
async function seedUser() { const id = uid(); await db.user.create({ data: { id, email: `${id}@it.local`, name: id } }); return id; }
async function seedProduct(qty: number, sellerId: string, categoryId: string, priceCents = 1000, currency = 'EUR') {
  const id = uid();
  await db.product.create({ data: { id, slug: id, title: id, categoryId, sellerId, quantity: qty, priceCents, currency, images: [], status: 'PUBLISHED', mode: 'BUY_NOW' } });
  return id;
}
async function qtyOf(id: string) { return (await db.product.findUnique({ where: { id }, select: { quantity: true } }))!.quantity; }
async function statusOf(id: string) { return (await db.order.findUnique({ where: { id }, select: { status: true } }))!.status; }
function orderData(buyerId: string, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return { buyerId, status: 'PENDING_PAYMENT' as const, subtotalCents: 1000, shippingCents: 0, taxCents: 0, totalCents: 1000, currency: 'EUR', paidAt: null, ...extra };
}
const res = (productId: string, quantity = 1, expectedPriceCents = 1000, expectedCurrency = 'EUR'): Reservation => ({ productId, quantity, expectedPriceCents, expectedCurrency });
const itemFor = (productId: string, quantity = 1) => ({ productId, titleSnapshot: 't', brandSnapshot: null, priceCentsSnapshot: 1000, quantity });

async function main() {
  const seller = await seedUser();
  const cat = uid(); await db.category.create({ data: { id: cat, slug: cat, name: cat } });
  const buyer = await seedUser();

  // 1) happy path
  {
    const p = await seedProduct(3, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    chk('reserve · success decrements once + creates order', r.ok === true && (await qtyOf(p)) === 2);
  }
  // 2) forced create failure (single) rolls back decrement
  {
    const p = await seedProduct(2, seller, cat);
    const r = await reserveAndCreateOrder(withFault(db, { key: 'order.create', error: boom, times: 99 }), { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    chk('reserve · forced create failure rolls back decrement', r.ok === false && (await qtyOf(p)) === 2);
  }
  // 3) forced create failure (multi) rolls back BOTH + leaves cart rows intact
  {
    const a = await seedProduct(2, seller, cat); const b = await seedProduct(2, seller, cat);
    const ca = await db.cartItem.create({ data: { userId: buyer, productId: a, quantity: 1 } });
    const cb = await db.cartItem.create({ data: { userId: buyer, productId: b, quantity: 1 } });
    const r = await reserveAndCreateOrder(withFault(db, { key: 'order.create', error: boom, times: 99 }), {
      reservations: [res(a), res(b)], orderData: orderData(buyer), items: [itemFor(a), itemFor(b)],
      cartClear: { userId: buyer, items: [{ id: ca.id, quantity: 1 }, { id: cb.id, quantity: 1 }] },
    });
    const cartIntact = (await db.cartItem.count({ where: { id: { in: [ca.id, cb.id] } } })) === 2;
    chk('reserve · multi create failure rolls back BOTH + cart intact', r.ok === false && (await qtyOf(a)) === 2 && (await qtyOf(b)) === 2 && cartIntact);
    await db.cartItem.deleteMany({ where: { userId: buyer } });
  }
  // 4) partial reservation rolls back the 1st + leaves cart intact
  {
    const a = await seedProduct(2, seller, cat); const b = await seedProduct(0, seller, cat);
    const ca = await db.cartItem.create({ data: { userId: buyer, productId: a, quantity: 1 } });
    const r = await reserveAndCreateOrder(db, {
      reservations: [res(a), res(b)], orderData: orderData(buyer), items: [itemFor(a), itemFor(b)],
      cartClear: { userId: buyer, items: [{ id: ca.id, quantity: 1 }] },
    });
    const cartIntact = (await db.cartItem.count({ where: { id: ca.id } })) === 1;
    chk('reserve · partial reservation → unavailable, rolls back + cart intact', r.ok === false && r.reason === 'unavailable' && (await qtyOf(a)) === 2 && cartIntact);
    await db.cartItem.deleteMany({ where: { userId: buyer } });
  }
  // 5) REAL orderNumber P2002 — seed a duplicate number, stub first random, retry whole tx
  {
    const origRandom = Math.random;
    const V = 0.123456789;
    try {
      Math.random = () => V;
      const collideNum = generateOrderNumber(); // exact number the first attempt will generate
      let first = true;
      Math.random = () => { if (first) { first = false; return V; } return origRandom(); }; // 1st gen collides, rest real (unique cuids)
      await db.order.create({ data: { ...orderData(buyer), orderNumber: collideNum } }); // pre-seed the collision
      const p = await seedProduct(2, seller, cat);
      const before = await db.orderItem.count({ where: { productId: p } });
      const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
      const newNum = r.ok ? (await db.order.findUnique({ where: { id: r.order.id }, select: { orderNumber: true } }))!.orderNumber : '';
      const after = await db.orderItem.count({ where: { productId: p } });
      chk('reserve · REAL P2002 retries WHOLE tx (decrement once, one order, new number)',
        r.ok === true && (await qtyOf(p)) === 1 && newNum !== collideNum && after - before === 1, `num=${newNum} collide=${collideNum} qty=${await qtyOf(p)}`);
    } finally { Math.random = origRandom; }
  }
  // 6) concurrent last-unit race → exactly one order
  {
    const p = await seedProduct(1, seller, cat);
    const [x, y] = await Promise.all([
      reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] }),
      reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] }),
    ]);
    chk('reserve · concurrent last unit → exactly one order', [x, y].filter((r) => r.ok).length === 1 && (await qtyOf(p)) === 0);
  }
  // 7) buyability guard — product changed under the buyer since the snapshot
  {
    const p = await seedProduct(2, seller, cat);
    await db.product.update({ where: { id: p }, data: { status: 'ARCHIVED' } }); // admin archives
    const r1 = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const q = await seedProduct(2, seller, cat);
    await db.product.update({ where: { id: q }, data: { mode: 'QUOTE_ONLY' } });
    const r2 = await reserveAndCreateOrder(db, { reservations: [res(q)], orderData: orderData(buyer), items: [itemFor(q)] });
    chk('reserve · status/mode change → unavailable, no decrement', r1.ok === false && (await qtyOf(p)) === 2 && r2.ok === false && (await qtyOf(q)) === 2);
  }
  // 8) financial guard — price/currency changed since the snapshot
  {
    const p = await seedProduct(2, seller, cat, 1000, 'EUR');
    await db.product.update({ where: { id: p }, data: { priceCents: 1500 } });        // price changed
    const r1 = await reserveAndCreateOrder(db, { reservations: [res(p, 1, 1000, 'EUR')], orderData: orderData(buyer), items: [itemFor(p)] });
    const q = await seedProduct(2, seller, cat, 1000, 'EUR');
    await db.product.update({ where: { id: q }, data: { currency: 'USD' } });          // currency changed
    const r2 = await reserveAndCreateOrder(db, { reservations: [res(q, 1, 1000, 'EUR')], orderData: orderData(buyer), items: [itemFor(q)] });
    chk('reserve · price/currency change → unavailable, no decrement', r1.ok === false && (await qtyOf(p)) === 2 && r2.ok === false && (await qtyOf(q)) === 2);
  }
  // 9) exact cart snapshot: concurrent ADD survives; concurrent QTY CHANGE rolls back
  {
    const p = await seedProduct(3, seller, cat);
    const c1 = await db.cartItem.create({ data: { userId: buyer, productId: p, quantity: 1 } });
    const other = await seedProduct(3, seller, cat);
    const c2added = await db.cartItem.create({ data: { userId: buyer, productId: other, quantity: 1 } }); // added after snapshot
    const rOk = await reserveAndCreateOrder(db, {
      reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)],
      cartClear: { userId: buyer, items: [{ id: c1.id, quantity: 1 }] }, // snapshot = only c1
    });
    const c1gone = (await db.cartItem.count({ where: { id: c1.id } })) === 0;
    const c2survives = (await db.cartItem.count({ where: { id: c2added.id } })) === 1;
    chk('cart · success clears exact snapshot; concurrently-added row survives', rOk.ok === true && c1gone && c2survives);

    const p2 = await seedProduct(3, seller, cat);
    const c3 = await db.cartItem.create({ data: { userId: buyer, productId: p2, quantity: 1 } });
    const rChanged = await reserveAndCreateOrder(db, {
      reservations: [res(p2)], orderData: orderData(buyer), items: [itemFor(p2)],
      cartClear: { userId: buyer, items: [{ id: c3.id, quantity: 2 }] }, // snapshot qty 2 ≠ actual 1 → mismatch
    });
    const c3intact = (await db.cartItem.count({ where: { id: c3.id } })) === 1;
    chk('cart · concurrent qty change → cart-changed rollback (row + stock intact)', rChanged.ok === false && (rChanged as { reason: string }).reason === 'cart-changed' && c3intact && (await qtyOf(p2)) === 3);
    await db.cartItem.deleteMany({ where: { userId: buyer } });
  }
  // 10) cancelAndRestockOrder — cancel + restock once, then noop; and PAID noop
  {
    const p = await seedProduct(1, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const oid = r.ok ? r.order.id : '';
    const a = await cancelAndRestockOrder(db, oid);
    const restocked = (await qtyOf(p)) === 1;
    const b = await cancelAndRestockOrder(db, oid);
    // PAID no-op: a paid order must never restock
    const p2 = await seedProduct(1, seller, cat);
    const r2 = await reserveAndCreateOrder(db, { reservations: [res(p2)], orderData: orderData(buyer), items: [itemFor(p2)] });
    const oid2 = r2.ok ? r2.order.id : '';
    await db.order.update({ where: { id: oid2 }, data: { status: 'PAID' } });
    const c = await cancelAndRestockOrder(db, oid2);
    chk('cancel · restock once + noop on CANCELED + noop on PAID (no restock)',
      a === 'canceled' && restocked && b === 'noop' && c === 'noop' && (await qtyOf(p2)) === 0 && (await statusOf(oid2)) === 'PAID');
  }
  // 11) cancelAndRestockOrder — forced restock failure rolls back, retry ok
  {
    const p = await seedProduct(1, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const oid = r.ok ? r.order.id : '';
    let threw = false;
    try { await cancelAndRestockOrder(withFault(db, { key: 'product.updateMany', error: boom, times: 99 }), oid); } catch { threw = true; }
    const stillPending = (await statusOf(oid)) === 'PENDING_PAYMENT';
    const notRestocked = (await qtyOf(p)) === 0;
    const retry = await cancelAndRestockOrder(db, oid);
    chk('cancel · forced restock failure rolls back, retry cancels+restocks once', threw && stillPending && notRestocked && retry === 'canceled' && (await qtyOf(p)) === 1);
  }

  // ── Stripe handoff saga ──
  async function makePendingOrder() {
    const p = await seedProduct(2, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    return { oid: r.ok ? r.order.id : '', p }; // stock now 1 (reserved)
  }
  // CAS persist: single-winner — attach the session only while still pending/unclaimed.
  const persistTo = (oid: string) => async (sid: string) => {
    const r = await db.order.updateMany({ where: { id: oid, status: 'PENDING_PAYMENT', OR: [{ stripeSessionId: null }, { stripeSessionId: sid }] }, data: { stripeSessionId: sid } });
    return r.count;
  };
  // Order.stripeSessionId is @unique — every fake session must use a distinct id.
  type FakeApi = StripeSessionApi & { sessionId: string; expired: number };
  const okApi = (): FakeApi => { const sid = uid(); const o = { sessionId: sid, expired: 0, create: async () => ({ id: sid, url: 'https://pay/x' }), expire: async () => { o.expired++; } }; return o; };
  const noUrlApi = (): FakeApi => { const sid = uid(); const o = { sessionId: sid, expired: 0, create: async () => ({ id: sid, url: null }), expire: async () => { o.expired++; } }; return o; };
  const createFailApi = (): FakeApi => { const sid = uid(); const o = { sessionId: sid, expired: 0, create: async () => { throw boom(); }, expire: async () => { o.expired++; } }; return o; };
  const expireFailApi = (): FakeApi => { const sid = uid(); const o = { sessionId: sid, expired: 0, create: async () => ({ id: sid, url: null }), expire: async () => { o.expired++; throw boom(); } }; return o; };

  // 12) no Stripe → cancel+restock, no session
  {
    const { oid, p } = await makePendingOrder();
    const h = await stripeCheckoutHandoff(db, null, oid, persistTo(oid));
    chk('handoff · no-Stripe → cancel+restock, no active session', h.ok === false && h.reason === 'no-session' && (await statusOf(oid)) === 'CANCELED' && (await qtyOf(p)) === 2);
  }
  // 13) create failure → cancel+restock, no session
  {
    const { oid, p } = await makePendingOrder();
    const h = await stripeCheckoutHandoff(db, createFailApi(), oid, persistTo(oid));
    chk('handoff · create failure → cancel+restock, no active session', h.ok === false && h.reason === 'no-session' && (await statusOf(oid)) === 'CANCELED' && (await qtyOf(p)) === 2);
  }
  // 14) cleanup failure → surfaced, stock NOT restocked (still reserved), order NOT canceled
  {
    const { oid, p } = await makePendingOrder();
    const h = await stripeCheckoutHandoff(withFault(db, { key: 'order.updateMany', error: boom, times: 99 }), createFailApi(), oid, persistTo(oid));
    chk('handoff · cleanup failure surfaced, no silent strand recovery', h.ok === false && h.reason === 'cleanup-failed' && (await statusOf(oid)) === 'PENDING_PAYMENT' && (await qtyOf(p)) === 1);
  }
  // 15) missing URL → expire session FIRST, then cancel+restock
  {
    const { oid, p } = await makePendingOrder();
    const api = noUrlApi();
    const h = await stripeCheckoutHandoff(db, api, oid, persistTo(oid));
    chk('handoff · missing URL → session expired then cancel+restock', h.ok === false && h.reason === 'no-session' && api.expired === 1 && (await statusOf(oid)) === 'CANCELED' && (await qtyOf(p)) === 2);
  }
  // 16) persist failure → expire session FIRST, then cancel+restock
  {
    const { oid, p } = await makePendingOrder();
    const api = okApi();
    const h = await stripeCheckoutHandoff(db, api, oid, async () => { throw boom(); });
    chk('handoff · persist failure → session expired then cancel+restock', h.ok === false && h.reason === 'no-session' && api.expired === 1 && (await statusOf(oid)) === 'CANCELED' && (await qtyOf(p)) === 2);
  }
  // 17) expire failure → session-orphaned; NEVER cancel/restock an active payable session
  {
    const { oid, p } = await makePendingOrder();
    const api = expireFailApi();
    const h = await stripeCheckoutHandoff(db, api, oid, async () => { throw boom(); });
    chk('handoff · expire failure → session-orphaned, order left RESERVED (not canceled)', h.ok === false && h.reason === 'session-orphaned' && (await statusOf(oid)) === 'PENDING_PAYMENT' && (await qtyOf(p)) === 1);
  }
  // 18) success → persisted + url, ok
  {
    const { oid } = await makePendingOrder();
    const api = okApi();
    const h = await stripeCheckoutHandoff(db, api, oid, persistTo(oid));
    const sid = (await db.order.findUnique({ where: { id: oid }, select: { stripeSessionId: true } }))!.stripeSessionId;
    chk('handoff · success → persisted stripeSessionId + url, order still PENDING', h.ok === true && h.url === 'https://pay/x' && sid === api.sessionId && (await statusOf(oid)) === 'PENDING_PAYMENT');
  }

  // 19) CAS-lost: order canceled between create() and persist → session expired, not our order, no restock
  {
    const p = await seedProduct(2, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const oid = r.ok ? r.order.id : '';
    const sid = uid(); let ex = 0;
    const racingApi: StripeSessionApi = { create: async () => { await db.order.update({ where: { id: oid }, data: { status: 'CANCELED' } }); return { id: sid, url: 'https://pay/x' }; }, expire: async () => { ex++; } };
    const h = await stripeCheckoutHandoff(db, racingApi, oid, persistTo(oid));
    chk('handoff · CAS lost (canceled mid-create) → session expired, not touched', h.ok === false && (h as { reason: string }).reason === 'cas-lost' && ex === 1 && (await statusOf(oid)) === 'CANCELED' && (await qtyOf(p)) === 1);
  }
  // 20) cancelOrderSaga · active session → expire first then cancel+restock
  {
    const p = await seedProduct(2, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const oid = r.ok ? r.order.id : ''; const api = okApi();
    await db.order.update({ where: { id: oid }, data: { stripeSessionId: api.sessionId } });
    const out = await cancelOrderSaga(db, api, oid);
    chk('cancelSaga · active session expired then cancel+restock', out === 'canceled' && api.expired === 1 && (await statusOf(oid)) === 'CANCELED' && (await qtyOf(p)) === 2);
  }
  // 21) cancelOrderSaga · expire failure → order left reserved (never cancel an active session)
  {
    const p = await seedProduct(2, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const oid = r.ok ? r.order.id : ''; const api = expireFailApi();
    await db.order.update({ where: { id: oid }, data: { stripeSessionId: api.sessionId } });
    const out = await cancelOrderSaga(db, api, oid);
    chk('cancelSaga · expire failure → NOT canceled, stock left reserved', out === 'expire-failed' && (await statusOf(oid)) === 'PENDING_PAYMENT' && (await qtyOf(p)) === 1);
  }
  // 22) cancelOrderSaga · onlyIfSessionIs mismatch (stale expired event) → noop
  {
    const p = await seedProduct(2, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const oid = r.ok ? r.order.id : ''; const api = okApi();
    await db.order.update({ where: { id: oid }, data: { stripeSessionId: 'current_session' } });
    const out = await cancelOrderSaga(db, api, oid, { onlyIfSessionIs: 'OLD_session' });
    chk('cancelSaga · stale-event session mismatch → noop, untouched', out === 'noop' && api.expired === 0 && (await statusOf(oid)) === 'PENDING_PAYMENT' && (await qtyOf(p)) === 1);
  }
  // 23) cancelOrderSaga · proof in flight → noop, not restocked
  {
    const p = await seedProduct(2, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const oid = r.ok ? r.order.id : '';
    await db.order.update({ where: { id: oid }, data: { paymentSubmittedAt: new Date() } });
    const out = await cancelOrderSaga(db, null, oid, { requireNoProof: true });
    chk('cancelSaga · proof in flight → noop, stock not restocked', out === 'noop' && (await statusOf(oid)) === 'PENDING_PAYMENT' && (await qtyOf(p)) === 1);
  }

  // 24) safeExpire — never classify by message; confirm via retrieve(status==='expired')
  {
    type StripeLike = Parameters<typeof safeExpire>[0];
    const mk = (expireErr: unknown, retStatus: string | 'THROW') => ({ checkout: { sessions: {
      expire: async () => { if (expireErr) throw expireErr; },
      retrieve: async () => { if (retStatus === 'THROW') throw boom(); return { status: retStatus }; },
    } } } as unknown as StripeLike);
    let okExpire = false, alreadyOk = false, completeClosed = false, retrievalClosed = false;
    try { await safeExpire(mk(null, 'open'), 's'); okExpire = true; } catch { /* */ }
    try { await safeExpire(mk(new Error('cannot expire a Checkout Session that is complete'), 'expired'), 's'); alreadyOk = true; } catch { /* */ }
    try { await safeExpire(mk(new Error('cannot expire a Checkout Session that is complete'), 'complete'), 's'); } catch { completeClosed = true; }
    try { await safeExpire(mk(new Error('network'), 'THROW'), 's'); } catch { retrievalClosed = true; }
    chk('safeExpire · expire-ok + already-expired succeed; complete + retrieval-fail FAIL CLOSED', okExpire && alreadyOk && completeClosed && retrievalClosed);
  }
  // 25) handoff CAS-lost + expire failure → session-orphaned (not falsely 'safe')
  {
    const p = await seedProduct(2, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const oid = r.ok ? r.order.id : ''; const sid = uid();
    const api: StripeSessionApi = { create: async () => { await db.order.update({ where: { id: oid }, data: { status: 'CANCELED' } }); return { id: sid, url: 'https://pay/x' }; }, expire: async () => { throw boom(); } };
    const h = await stripeCheckoutHandoff(db, api, oid, persistTo(oid));
    chk('handoff · CAS-lost + expire failure → session-orphaned (loud, not safe)', h.ok === false && (h as { reason: string }).reason === 'session-orphaned');
  }
  // 26) handoff unknown-persist + FOREIGN session B attached → leave order reserved with B
  {
    const p = await seedProduct(2, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const oid = r.ok ? r.order.id : ''; const A = uid();
    let aExpired = 0;
    const api: StripeSessionApi = { create: async () => ({ id: A, url: null }), expire: async (id) => { if (id === A) aExpired++; } };
    // persist throws AFTER a concurrent writer attaches session B
    const h = await stripeCheckoutHandoff(db, api, oid, async () => { await db.order.update({ where: { id: oid }, data: { stripeSessionId: 'session_B' } }); throw boom(); });
    const sess = (await db.order.findUnique({ where: { id: oid }, select: { stripeSessionId: true } }))!.stripeSessionId;
    chk('handoff · unknown persist + foreign session B → NOT canceled, B untouched', h.ok === false && aExpired === 1 && (await statusOf(oid)) === 'PENDING_PAYMENT' && (await qtyOf(p)) === 1 && sess === 'session_B');
  }
  // 27) PAID CAS on session id — a completed for a FOREIGN session must not flip PAID
  {
    const p = await seedProduct(2, seller, cat);
    const r = await reserveAndCreateOrder(db, { reservations: [res(p)], orderData: orderData(buyer), items: [itemFor(p)] });
    const oid = r.ok ? r.order.id : '';
    await db.order.update({ where: { id: oid }, data: { stripeSessionId: 'session_A' } });
    const foreign = await db.order.updateMany({ where: { id: oid, status: 'PENDING_PAYMENT', stripeSessionId: 'session_B' }, data: { status: 'PAID' } });
    const own = await db.order.updateMany({ where: { id: oid, status: 'PENDING_PAYMENT', stripeSessionId: 'session_A' }, data: { status: 'PAID' } });
    chk('PAID CAS · foreign session no-ops, own session flips once', foreign.count === 0 && own.count === 1 && (await statusOf(oid)) === 'PAID');
  }
  // 28) event ledger — single-winner claim (concurrent/replay → exactly one)
  {
    const eid = 'evt_' + uid();
    const claim = async () => { try { await db.webhookEvent.create({ data: { id: eid, type: 'checkout.session.completed', orderId: null } }); return true; } catch { return false; } };
    const [a, b] = await Promise.all([claim(), claim()]);
    const replay = await claim();
    chk('ledger · concurrent + replay claims → exactly one winner', [a, b].filter(Boolean).length === 1 && replay === false);
  }
  // 29) cancelOrdersBatch — mixed winners/losers; only winners restock, failures surfaced
  {
    const win = await seedProduct(1, seller, cat);
    const rw = await reserveAndCreateOrder(db, { reservations: [res(win)], orderData: orderData(buyer), items: [itemFor(win)] });
    const oWin = rw.ok ? rw.order.id : '';
    const proofP = await seedProduct(1, seller, cat);
    const rp = await reserveAndCreateOrder(db, { reservations: [res(proofP)], orderData: orderData(buyer), items: [itemFor(proofP)] });
    const oProof = rp.ok ? rp.order.id : ''; await db.order.update({ where: { id: oProof }, data: { paymentSubmittedAt: new Date() } });
    const paidP = await seedProduct(1, seller, cat);
    const rpd = await reserveAndCreateOrder(db, { reservations: [res(paidP)], orderData: orderData(buyer), items: [itemFor(paidP)] });
    const oPaid = rpd.ok ? rpd.order.id : ''; await db.order.update({ where: { id: oPaid }, data: { status: 'PAID' } });
    const exP = await seedProduct(1, seller, cat);
    const rex = await reserveAndCreateOrder(db, { reservations: [res(exP)], orderData: orderData(buyer), items: [itemFor(exP)] });
    const oExpFail = rex.ok ? rex.order.id : ''; const exApi = expireFailApi(); await db.order.update({ where: { id: oExpFail }, data: { stripeSessionId: exApi.sessionId } });
    const batch = await cancelOrdersBatch(db, exApi, [oWin, oProof, oPaid, oExpFail], { requireNoProof: true });
    chk('batch · only winner cancels/restocks; proof+paid noop; active-session expire-failed surfaced',
      batch.canceled.length === 1 && batch.canceled[0] === oWin && batch.expireFailed.length === 1 && batch.expireFailed[0] === oExpFail && batch.errored.length === 0 &&
      (await qtyOf(win)) === 1 && (await qtyOf(proofP)) === 0 && (await qtyOf(paidP)) === 0 && (await qtyOf(exP)) === 0 &&
      (await statusOf(oProof)) === 'PENDING_PAYMENT' && (await statusOf(oPaid)) === 'PAID' && (await statusOf(oExpFail)) === 'PENDING_PAYMENT');
  }

  // ── proforma expiry transition ──
  async function seedQuoteWithOrder(withProof: boolean, linkOrder = true) {
    const srId = uid();
    await db.sourcingRequest.create({ data: { id: srId, buyerEmail: 'b@it.local', buyerName: 'b', description: 'd', proformaNumber: uid(), status: 'RESPONDED', validUntilAt: new Date(0) } });
    let oid = '';
    if (linkOrder) { const o = await db.order.create({ data: { ...orderData(buyer, { sourcingRequestId: srId }), orderNumber: uid(), ...(withProof ? { paymentSubmittedAt: new Date() } : {}) } }); oid = o.id; }
    return { srId, oid };
  }
  { const { srId, oid } = await seedQuoteWithOrder(false); const out = await expireProformaTransition(db, srId);
    chk('proforma · expired closes quote + cancels order', out === 'expired' && (await db.sourcingRequest.findUnique({ where: { id: srId }, select: { status: true } }))!.status === 'CLOSED' && (await statusOf(oid)) === 'CANCELED'); }
  { const { srId, oid } = await seedQuoteWithOrder(true); const out = await expireProformaTransition(db, srId);
    chk('proforma · proof-in-flight leaves both unexpired', out === 'proof-in-flight' && (await db.sourcingRequest.findUnique({ where: { id: srId }, select: { status: true } }))!.status === 'RESPONDED' && (await statusOf(oid)) === 'PENDING_PAYMENT'); }
  { const { srId } = await seedQuoteWithOrder(false, false); const out = await expireProformaTransition(db, srId);
    chk('proforma · no-linked-order still closes', out === 'expired' && (await db.sourcingRequest.findUnique({ where: { id: srId }, select: { status: true } }))!.status === 'CLOSED'); }
  { const { srId } = await seedQuoteWithOrder(false); const [x, y] = await Promise.all([expireProformaTransition(db, srId), expireProformaTransition(db, srId)]);
    chk('proforma · overlapping sweeps fire exactly once', [x, y].filter((o) => o === 'expired').length === 1, `${x},${y}`); }
  { const { srId, oid } = await seedQuoteWithOrder(false);
    // inject: first tx order.updateMany triggers a concurrent proof-submission (committed on a separate connection)
    let injected = false;
    const raced = new Proxy(db, { get(t, prop, recv) {
      if (prop === '$transaction') return (arg: unknown, opts?: unknown) => (db.$transaction as (f: (tx: unknown) => unknown, o?: unknown) => unknown)(async (tx) => {
        const txp = new Proxy(tx as object, { get(tt, model) { const m = Reflect.get(tt, model);
          if (String(model) === 'order') return new Proxy(m as object, { get(mm, op) { const fn = Reflect.get(mm, op);
            if (String(op) === 'updateMany' && typeof fn === 'function') return async (...a: unknown[]) => { if (!injected) { injected = true; await db.order.update({ where: { id: oid }, data: { paymentSubmittedAt: new Date() } }); } return (fn as (...x: unknown[]) => unknown).apply(mm, a); };
            return fn; } });
          return m; } });
        return (arg as (t: unknown) => unknown)(txp); }, opts);
      return Reflect.get(t, prop, recv); } }) as PrismaClient;
    const out = await expireProformaTransition(raced, srId);
    chk('proforma · forced proof interleaving → proof-in-flight', out === 'proof-in-flight' && (await db.sourcingRequest.findUnique({ where: { id: srId }, select: { status: true } }))!.status === 'RESPONDED' && (await statusOf(oid)) === 'PENDING_PAYMENT'); }

  console.log('order/checkout atomicity — integration (real helpers, real DB)');
  console.log('----------------------------------------------------------------');
  console.log(rows.join('\n'));
  console.log('----------------------------------------------------------------');
  console.log(`RESULT: pass=${pass} fail=${fail}`);
}

main()
  .then(async () => { await db.$disconnect(); process.exit(fail === 0 ? 0 : 1); })
  .catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(2); });
