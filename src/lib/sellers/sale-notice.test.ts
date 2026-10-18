import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// lib/auth-server (imported by lib/observability) uses React's server-only
// `cache`; outside Next give it a pass-through, as scripts/react-cache-shim.cjs does.
const react = createRequire(import.meta.url)('react') as { cache?: unknown };
if (typeof react.cache !== 'function') react.cache = <F>(fn: F) => fn;

// notifySupplierOfSale against an in-memory stand-in for the tables it reads
// and writes (lib/db.ts re-uses globalThis.__prisma outside production), with
// the mail going to a stubbed Resend endpoint — so the notices are checked as
// the supplier receives them, without a database or a mail server.
type Row = Record<string, unknown>;
const state = {
  order: null as Row | null,
  suppliers: [] as Array<{ id: string; email: string; name: string }>,
  admins: [{ id: 'a1', adminCaps: ['*'] }],
  notifications: [] as Row[],
  reminders: new Map<string, { emailOk: boolean }>(),
  mails: [] as Array<{ to: string; subject: string; html: string; text: string }>,
  errors: [] as Row[],
};
const rk = (w: Row) => `${w.subjectType}|${w.subjectId}|${w.kind}|${w.step}`;
const known: Record<string, Record<string, (args: Row) => Promise<unknown>>> = {
  order: { findUnique: async () => state.order },
  user: {
    findMany: async ({ where }) =>
      (where as Row).role === 'SELLER'
        ? state.suppliers.filter((u) => ((where as { id: { in: string[] } }).id.in).includes(u.id))
        : state.admins,
  },
  notification: {
    create: async ({ data }) => (state.notifications.push(data as Row), {}),
    createMany: async ({ data }) => (state.notifications.push(...(data as Row[])), { count: (data as Row[]).length }),
  },
  reminderLog: {
    createMany: async ({ data }) => {
      const k = rk((data as Row[])[0]);
      if (state.reminders.has(k)) return { count: 0 };
      state.reminders.set(k, { emailOk: false });
      return { count: 1 };
    },
    count: async ({ where }) => (state.reminders.has(rk(where as Row)) ? 1 : 0),
    updateMany: async ({ where, data }) => {
      const r = state.reminders.get(rk(where as Row));
      if (r) r.emailOk = (data as { emailOk: boolean }).emailOk;
      return { count: r ? 1 : 0 };
    },
  },
  errorLog: { create: async ({ data }) => (state.errors.push(data as Row), {}) },
};
// Everything else (settings, e-mail log, suppressions, webhooks): empty tables.
const empty = (method: string) => async () =>
  method.startsWith('findMany') ? [] : method.startsWith('find') ? null : method === 'count' ? 0 : /Many$/.test(method) ? { count: 0 } : {};
const fakeDb = new Proxy({}, {
  get: (_t, model: string) => new Proxy({}, { get: (_m, method: string) => known[model]?.[method] ?? empty(method) }),
});
(globalThis as { __prisma?: unknown }).__prisma = fakeDb;
const env: Record<string, string> = {
  SITE_NAME: 'Labtodate',
  EMAIL_FROM: 'orders@labtodate.com',
  RESEND_API_KEY: 're_test_key',
  SUPPORT_EMAIL: 'support@labtodate.com',
  BETTER_AUTH_URL: 'https://labtodate.com',
  SELLER_DISPATCH_TEXT: 'Keep the unit reserved. We collect it within five working days.',
};
(globalThis as { __settingEnvDefaults?: unknown }).__settingEnvDefaults = env;
Object.assign(process.env, env);
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  state.mails.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ id: `m${state.mails.length}` }), { status: 200 });
}) as unknown as typeof fetch;

const load = () => import('./sale-notice');
const S1 = { id: 's1', email: 'jan@biolab-direct.nl', name: 'Jan' };

// RFQ-QQ83M2 (G5): supplier price €10,000, buyer price €11,500.
function quoteOrder(p: Row = {}): Row {
  return {
    id: 'o1',
    orderNumber: 'L2D-2026-QQ83M2',
    status: 'PAID',
    currency: 'EUR',
    subtotalCents: 1_150_000,
    paidAt: new Date('2026-10-10T10:00:00Z'),
    createdAt: new Date('2026-10-09T10:00:00Z'),
    shippedAt: null,
    deliveredAt: null,
    openHolds: [],
    sourcingRequest: {
      id: 'q1',
      assignedTo: { id: 's1', role: 'SELLER' },
      product: null,
      offerSupplierCostCents: 1_000_000,
      offerSupplierCostCurrency: 'EUR',
      sellerProposalCurrency: 'EUR',
      quotedCurrency: 'EUR',
    },
    items: [{ id: 'i1', titleSnapshot: 'Thermo Orbitrap Exploris 480', quantity: 1, lineType: 'GOODS', priceCentsSnapshot: 1_150_000, basePriceCents: null, product: null }],
    shipments: [],
    ...p,
  };
}

beforeEach(() => {
  state.order = quoteOrder();
  state.suppliers = [S1];
  state.notifications.length = 0;
  state.reminders.clear();
  state.mails.length = 0;
  state.errors.length = 0;
});

test('paid: the supplier is told to prepare the unit, at its own price, once', async () => {
  const { notifySupplierOfSale } = await load();
  await notifySupplierOfSale('o1', 'PAID');
  assert.deepEqual(state.errors, []);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].userId, 's1');
  assert.equal(state.notifications[0].title, 'Unit sold — prepare it for dispatch');
  assert.equal(state.notifications[0].href, '/app/seller/inbox/q1');
  assert.equal(state.mails.length, 1);
  const m = state.mails[0];
  assert.equal(m.to, S1.email);
  assert.match(m.subject, /Unit sold — prepare it for dispatch: Thermo Orbitrap Exploris 480 \(order L2D-2026-QQ83M2\)/);
  for (const part of [m.html, m.text]) {
    assert.match(part, /€10,000 excl\. VAT/);
    assert.match(part, /We collect it within five working days\./);
    assert.doesNotMatch(part, /11,500/);
  }
  assert.deepEqual([...state.reminders.values()], [{ emailOk: true }]);

  // A repeated call (retry, second verification path) sends nothing new.
  await notifySupplierOfSale('o1', 'PAID');
  assert.equal(state.notifications.length, 1);
  assert.equal(state.mails.length, 1);
});

test('shipped and delivered follow; delivered says how the supplier is paid', async () => {
  const { notifySupplierOfSale } = await load();
  state.order = quoteOrder({ status: 'SHIPPED', shippedAt: new Date('2026-10-12T09:00:00Z') });
  await notifySupplierOfSale('o1', 'SHIPPED');
  state.order = quoteOrder({ status: 'DELIVERED', shippedAt: new Date('2026-10-12T09:00:00Z'), deliveredAt: new Date('2026-10-14T09:00:00Z') });
  await notifySupplierOfSale('o1', 'DELIVERED');
  assert.deepEqual(state.mails.map((m) => m.subject.split(':')[0]), ['Shipped to the buyer', 'Delivered']);
  assert.match(state.mails[0].text, /left for the buyer on 12 October 2026/);
  assert.match(state.mails[1].text, /delivered to the buyer on 14 October 2026/);
  assert.match(state.mails[1].html, /How you are paid/);
  assert.match(state.mails[1].text, /supplier agreement/);
});

test('nothing is sent while the unit is short or before the order is shipped', async () => {
  const { notifySupplierOfSale } = await load();
  state.order = quoteOrder({ openHolds: ['STOCK_SHORTAGE'] });
  await notifySupplierOfSale('o1', 'PAID');
  await notifySupplierOfSale('o1', 'SHIPPED');
  assert.equal(state.notifications.length, 0);
  assert.equal(state.reminders.size, 0);
  // Once the unit is secured the PAID call goes through.
  state.order = quoteOrder();
  await notifySupplierOfSale('o1', 'PAID');
  assert.equal(state.mails.length, 1);
});

test('a cancellation reaches only a supplier that was told to prepare the unit', async () => {
  const { notifySupplierOfSale } = await load();
  state.order = quoteOrder({ status: 'CANCELED' });
  await notifySupplierOfSale('o1', 'CANCELED');
  assert.equal(state.mails.length, 0);
  state.order = quoteOrder();
  await notifySupplierOfSale('o1', 'PAID');
  state.order = quoteOrder({ status: 'CANCELED' });
  await notifySupplierOfSale('o1', 'CANCELED');
  assert.equal(state.mails.length, 2);
  assert.match(state.mails[1].subject, /^Sale canceled — do not dispatch/);
});

test('a supplier without a deliverable address gets the in-app notice and staff are asked to tell it', async () => {
  const { notifySupplierOfSale } = await load();
  state.suppliers = [{ id: 's1', email: 'sales@biolab-refurb.import', name: 'BioLab Refurb Sales' }];
  await notifySupplierOfSale('o1', 'PAID');
  assert.equal(state.mails.length, 0);
  assert.deepEqual(state.notifications.map((n) => n.userId), ['s1', 'a1']);
  assert.match(String(state.notifications[1].title), /^Tell the supplier: unit sold — order L2D-2026-QQ83M2/);
  assert.equal(state.notifications[1].href, '/admin/orders/o1');
});

test('listing sales: each supplier hears about its own lines only; staff listings are our stock', async () => {
  const { notifySupplierOfSale } = await load();
  state.suppliers = [S1, { id: 's2', email: 'eva@optiscope.nl', name: 'Eva' }];
  state.order = quoteOrder({
    sourcingRequest: null,
    items: [
      { id: 'i1', titleSnapshot: 'Mettler XPR205', quantity: 1, lineType: 'GOODS', priceCentsSnapshot: 575_000, basePriceCents: 500_000, product: { seller: { id: 's1', role: 'SELLER' } } },
      { id: 'i2', titleSnapshot: 'Zeiss Axio', quantity: 2, lineType: 'GOODS', priceCentsSnapshot: 230_000, basePriceCents: 200_000, product: { seller: { id: 's2', role: 'SELLER' } } },
      { id: 'i3', titleSnapshot: 'Own stock centrifuge', quantity: 1, lineType: 'GOODS', priceCentsSnapshot: 90_000, basePriceCents: 90_000, product: { seller: { id: 'a1', role: 'ADMIN' } } },
    ],
  });
  await notifySupplierOfSale('o1', 'PAID');
  assert.deepEqual(state.mails.map((m) => m.to).sort(), ['eva@optiscope.nl', S1.email]);
  const toS1 = state.mails.find((m) => m.to === S1.email)!;
  const toS2 = state.mails.find((m) => m.to === 'eva@optiscope.nl')!;
  assert.match(toS1.text, /€5,000 excl\. VAT/);
  assert.doesNotMatch(toS1.text, /Zeiss|Own stock|5,750/);
  assert.match(toS2.text, /Zeiss Axio × 2: €4,000 excl\. VAT/);
  assert.equal(state.notifications.find((n) => n.userId === 's1')?.href, '/app/seller/payouts');
});
