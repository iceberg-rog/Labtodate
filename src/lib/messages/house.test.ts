import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isHouseSeller, movedToTicketText, planTicketFromThread, PRODUCT_QUESTION_CATEGORY } from './house';
import { HELD_PREFIX, storedBody } from './mediation';

test('house stock: admin-created listings, accounts without a supplier company, importer placeholders', () => {
  assert.equal(isHouseSeller({ role: 'ADMIN', companyId: null, email: 'g7.adma@labtodate.com' }), true);
  assert.equal(isHouseSeller({ role: 'ADMIN', companyId: 'co1', email: 'sales@labtodate.com' }), true);
  assert.equal(isHouseSeller({ role: 'SELLER', companyId: null, email: 'jan@biolab.nl' }), true);
  assert.equal(isHouseSeller({ role: 'SELLER', companyId: 'co1', email: 'sales@biolab.import' }), true);
  assert.equal(isHouseSeller({ role: 'SELLER', companyId: 'co1', email: 'g5.s1@labtodate.com' }), false);
});

const at = (min: number) => new Date(Date.UTC(2026, 9, 18, 10, min));
const thread = {
  subject: 'About: G7- Thermo Sorvall ST16R refrigerated centrifuge',
  buyerId: 'b1',
  buyer: { name: 'G7 Buyer', email: 'g7.b1@labtodate.com' },
  product: { title: 'G7- Thermo Sorvall ST16R refrigerated centrifuge' },
  messages: [
    { authorId: 'b1', body: 'Is the rotor included?', createdAt: at(0) },
    { authorId: 'adm', body: 'Yes, a swing-out rotor.', createdAt: at(5) },
    { authorId: 'adm', body: storedBody('WITHHELD', 'never delivered'), createdAt: at(6) },
  ],
};

test('a house thread becomes one product-question ticket with every delivered message in order', () => {
  const plan = planTicketFromThread(thread, { now: at(10) });
  assert.equal(plan.category, PRODUCT_QUESTION_CATEGORY);
  assert.equal(plan.subject, 'Question: G7- Thermo Sorvall ST16R refrigerated centrifuge');
  assert.equal(plan.email, 'g7.b1@labtodate.com');
  assert.deepEqual(plan.messages.map((m) => [m.fromStaff, m.body]), [[false, 'Is the rotor included?'], [true, 'Yes, a swing-out rotor.']]);
  // Staff answered last: the buyer's move.
  assert.equal(plan.status, 'WAITING_ON_CUSTOMER');
  assert.equal(plan.lastReplyByStaff, true);

  const withNew = planTicketFromThread(thread, { now: at(10), buyerMessage: '  And the lid?  ' });
  assert.equal(withNew.messages.at(-1)?.body, 'And the lid?');
  assert.equal(withNew.status, 'WAITING_ON_SUPPORT');
  assert.equal(withNew.lastReplyAt.getTime(), at(10).getTime());
  assert.match(movedToTicketText('TKT-2026-ABC123', 'Labtodate'), /support ticket TKT-2026-ABC123.*Labtodate team/);
});

test('moveThreadToTicket: one ticket, a closing line in the thread and the mapping, once', async () => {
  // lib/auth-server uses React's server-only `cache`; outside Next give it a pass-through (as scripts/react-cache-shim.cjs).
  const react = createRequire(import.meta.url)('react') as { cache?: unknown };
  if (typeof react.cache !== 'function') react.cache = (fn: unknown) => fn;
  const audit: { action: string; target: string | null; meta: string | null }[] = [];
  const tickets: Record<string, unknown>[] = [];
  const messages: { threadId: string; authorId: string; body: string }[] = [];
  const notifications: { userId: string; title: string }[] = [];
  const db = {
    auditLog: {
      findFirst: async ({ where }: { where: { action: string; target: string } }) =>
        [...audit].reverse().find((a) => a.action === where.action && a.target === where.target) ?? null,
      create: async ({ data }: { data: (typeof audit)[number] }) => {
        audit.push(data);
        return data;
      },
    },
    supportTicket: {
      findUnique: async ({ where }: { where: { id: string } }) => tickets.find((t) => t.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const t = { ...data, id: `t${tickets.length + 1}` };
        tickets.push(t);
        return { id: t.id, ref: data.ref };
      },
    },
    messageThread: {
      findUnique: async () => ({ ...thread, sellerId: 'adm', productId: 'p1', messages: thread.messages }),
      update: async () => ({}),
    },
    message: { create: async ({ data }: { data: (typeof messages)[number] }) => messages.push(data) },
    notification: { create: async ({ data }: { data: (typeof notifications)[number] }) => notifications.push(data) },
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  (globalThis as { __prisma?: unknown }).__prisma = db;
  process.env.SITE_NAME = 'Labtodate';
  const { moveThreadToTicket } = await import('./to-ticket');

  const first = await moveThreadToTicket('th1', { buyerMessage: 'And the lid?', notify: 'buyer' });
  assert.equal(first?.created, true);
  assert.match(first?.ref ?? '', /^TKT-\d{4}-[A-Z0-9]{6}$/);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].category, 'Product question');
  assert.equal(tickets[0].productId, 'p1');
  assert.equal(tickets[0].submittedById, 'b1');
  assert.equal(tickets[0].status, 'WAITING_ON_SUPPORT');
  assert.equal((tickets[0].messages as { create: unknown[] }).create.length, 3);
  assert.equal(messages.length, 1);
  assert.match(messages[0].body, new RegExp(`support ticket ${first?.ref}`));
  assert.equal(messages[0].authorId, 'adm');
  assert.equal(notifications[0]?.userId, 'b1');
  assert.ok(!messages[0].body.startsWith(HELD_PREFIX));

  const again = await moveThreadToTicket('th1', { buyerMessage: 'Hello?', notify: 'buyer' });
  assert.deepEqual(again, { ticketId: first?.ticketId, ref: first?.ref, created: false });
  assert.equal(tickets.length, 1);
  assert.equal(messages.length, 1);
});
