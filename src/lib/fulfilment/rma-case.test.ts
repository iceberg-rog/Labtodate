import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimRmaResolution, openRmaTicket, orderFileHref, postRmaEvent, rmaPriority, rmaTicketTransition, ticketUpdateForStep, type RmaTicketDb } from './rma-case';

// ── an in-memory stand-in for the few Prisma calls the RMA case makes ────────

type Row = Record<string, unknown>;

/** Just enough of Prisma's `where` for these calls: AND / OR, equality, null, in / notIn, not, insensitive equals. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'AND') return (cond as Row[]).every((c) => matches(row, c));
    if (k === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    const v = row[k] ?? null;
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return v === cond;
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(v);
    if ('notIn' in c) return !(c.notIn as unknown[]).includes(v);
    if ('equals' in c) return c.mode === 'insensitive' ? String(v).toLowerCase() === String(c.equals).toLowerCase() : v === c.equals;
    if ('not' in c) return v !== c.not;
    return false;
  });
}

function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'push' in (v as Row)) row[k] = [...((row[k] as unknown[]) ?? []), (v as Row).push];
    else row[k] = v;
  }
}

function fakeDb(init: { tickets?: Row[]; returns?: Row[]; refunds?: Row[] }) {
  const state = { tickets: init.tickets ?? [], returns: init.returns ?? [], refunds: init.refunds ?? [], messages: [] as Row[], created: [] as Row[] };
  const db = {
    supportTicket: {
      findFirst: async ({ where }: { where: Row }) => [...state.tickets].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()).find((t) => matches(t, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => state.tickets.find((t) => t.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const t = state.tickets.find((x) => x.id === where.id);
        if (!t) throw new Error('no ticket');
        apply(t, data);
        return t;
      },
    },
    supportMessage: {
      create: async ({ data }: { data: Row }) => {
        state.messages.push(data);
        return { id: `m${state.messages.length}` };
      },
    },
    returnRequest: {
      findMany: async ({ where }: { where: Row }) => state.returns.filter((r) => matches(r, where)).map((r) => ({ ticketId: r.ticketId })),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const r = state.returns.find((x) => x.id === where.id);
        if (!r) throw new Error('no return');
        apply(r, data);
        return r;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hits = state.returns.filter((r) => matches(r, where));
        for (const r of hits) apply(r, data);
        return { count: hits.length };
      },
    },
    refund: { count: async ({ where }: { where: Row }) => state.refunds.filter((r) => matches(r, where)).length },
  };
  const createTicket = async (data: Row) => {
    const { messages, ...rest } = data as Row & { messages: { create: Row } };
    const t = { id: `t-new-${state.created.length + 1}`, ref: `TKT-2026-NEW00${state.created.length + 1}`, createdAt: new Date(), archivedAt: null, ...rest };
    state.created.push(t);
    state.tickets.push(t);
    state.messages.push({ ticketId: t.id, ...messages.create });
    return { id: t.id as string, ref: t.ref as string };
  };
  return { state, db: db as unknown as RmaTicketDb, createTicket, money: db as unknown as Parameters<typeof claimRmaResolution>[0] };
}

const AT = new Date('2026-10-18T09:00:00Z');
const HOUR = 3600e3;
const order = { id: 'o1', buyerId: 'u-buyer', buyer: { name: 'Dr. A. Buyer', email: 'Buyer@Lab.example.org' } };
const photos = ['return-files/aa.jpg', 'return-files/bb.png'];
const input = {
  returnId: 'rma2', order, subject: 'RMA-2026-8ROYA5-2 — Transport damage — order L2D-2026-8ROYA5', body: 'RMA-2026-8ROYA5-2: Damaged in transport — 1 × Centrifuge\n\nThe lid arrived cracked.',
  fromStaff: false, authorId: 'u-buyer', attachments: photos.map(orderFileHref), attachmentNames: ['lid.jpg', 'box.png'], at: AT,
};

// ── tests ────────────────────────────────────────────────────────────────────

test('ticket transitions: the buyer writes → our turn with an SLA; we answer → no reply owed; the RMA ends → resolved', () => {
  assert.deepEqual(rmaTicketTransition('OPENED'), { status: 'WAITING_ON_SUPPORT', sla: 'restart', internal: false });
  assert.deepEqual(rmaTicketTransition('FILES_ADDED'), { status: 'WAITING_ON_SUPPORT', sla: 'restart', internal: false });
  assert.equal(rmaTicketTransition('APPROVED').status, 'WAITING_ON_CUSTOMER', 'the buyer ships the goods back');
  assert.equal(rmaTicketTransition('SENT_BACK').sla, 'clear', 'nothing to answer while the parcel travels');
  assert.equal(rmaTicketTransition('INSPECTED').internal, true, 'grade + restock stay internal');
  assert.equal(rmaTicketTransition('DENIED').status, 'RESOLVED');
  assert.equal(rmaTicketTransition('RESOLVED').status, 'RESOLVED');
  assert.equal(rmaPriority('NORMAL'), 'HIGH');
  assert.equal(rmaPriority('LOW'), 'HIGH');
  assert.equal(rmaPriority('VIP'), 'VIP');
  assert.equal(rmaPriority('URGENT'), 'URGENT');
  const restart = ticketUpdateForStep('FILES_ADDED', { status: 'WAITING_ON_CUSTOMER', priority: 'HIGH' }, { fromStaff: false, at: AT });
  assert.equal((restart?.dueAt as Date).getTime(), AT.getTime() + 8 * HOUR, 'HIGH = 8 h response');
  assert.equal(restart?.slaBreachAt, null);
  assert.equal(restart?.lastReplyByStaff, false);
  assert.deepEqual(ticketUpdateForStep('RESOLVED', { status: 'CLOSED', priority: 'HIGH' }, { fromStaff: true, at: AT }), { lastReplyAt: AT, lastReplyByStaff: true, dueAt: null }, 'a closed ticket stays closed');
  assert.equal(ticketUpdateForStep('INSPECTED', { status: 'WAITING_ON_SUPPORT', priority: 'HIGH' }, { fromStaff: true, at: AT }), null);
});

test('no open ticket about the order: one new HIGH ticket with the SLA due date and the photos, linked to the return', async () => {
  const { state, db, createTicket } = fakeDb({ returns: [{ id: 'rma2', orderId: 'o1', ticketId: null }] });
  const t = await openRmaTicket(db, input, createTicket);
  assert.equal(t.reused, false);
  assert.equal(state.created.length, 1);
  const created = state.created[0];
  assert.equal(created.priority, 'HIGH');
  assert.equal(created.status, 'WAITING_ON_SUPPORT');
  assert.equal((created.dueAt as Date).getTime(), AT.getTime() + 8 * HOUR);
  assert.deepEqual(created.lastReplyAt, AT);
  assert.equal(created.orderId, 'o1');
  assert.equal(created.submittedById, 'u-buyer');
  assert.deepEqual(created.tags, ['return']);
  assert.deepEqual(state.messages[0].attachments, ['/api/order-files/return-files/aa.jpg', '/api/order-files/return-files/bb.png']);
  assert.deepEqual(state.messages[0].attachmentNames, ['lid.jpg', 'box.png']);
  assert.equal(state.returns[0].ticketId, t.id);
});

test('the buyer’s open complaint ticket about the order is reused (one case), never another return’s ticket', async () => {
  const day = 86_400_000;
  const { state, db, createTicket } = fakeDb({
    tickets: [
      // The complaint the buyer opened about this order (D53: TKT-2026-N17GUF).
      { id: 'tc', ref: 'TKT-2026-N17GUF', orderId: 'o1', submittedById: 'u-buyer', email: 'buyer@lab.example.org', status: 'WAITING_ON_SUPPORT', archivedAt: null, priority: 'NORMAL', tags: [], dueAt: null, createdAt: new Date(AT.getTime() - 3 * day) },
      // Newer, but it belongs to the first return of this order.
      { id: 't1', ref: 'TKT-2026-MTZ8OG', orderId: 'o1', submittedById: 'u-buyer', email: 'buyer@lab.example.org', status: 'OPEN', archivedAt: null, priority: 'HIGH', tags: [], dueAt: null, createdAt: new Date(AT.getTime() - day) },
      // Same buyer, another order; and another customer's ticket on this order.
      { id: 'tx', ref: 'TKT-2026-OTHER1', orderId: 'o9', submittedById: 'u-buyer', email: 'buyer@lab.example.org', status: 'OPEN', archivedAt: null, priority: 'NORMAL', tags: [], createdAt: AT },
      { id: 'ty', ref: 'TKT-2026-OTHER2', orderId: 'o1', submittedById: 'u-else', email: 'else@lab.example.org', status: 'OPEN', archivedAt: null, priority: 'NORMAL', tags: [], createdAt: AT },
    ],
    returns: [{ id: 'rma1', orderId: 'o1', ticketId: 't1' }, { id: 'rma2', orderId: 'o1', ticketId: null }],
  });
  const t = await openRmaTicket(db, input, createTicket);
  assert.deepEqual(t, { id: 'tc', ref: 'TKT-2026-N17GUF', reused: true });
  assert.equal(state.created.length, 0, 'no second ticket');
  const tc = state.tickets.find((x) => x.id === 'tc')!;
  assert.equal(tc.status, 'WAITING_ON_SUPPORT');
  assert.equal(tc.priority, 'HIGH');
  assert.equal((tc.dueAt as Date).getTime(), AT.getTime() + 8 * HOUR, 'it gets an SLA');
  assert.deepEqual(tc.tags, ['return']);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].ticketId, 'tc');
  assert.equal((state.messages[0].attachments as string[]).length, 2, 'the photos are on the ticket');
  assert.equal(state.returns.find((r) => r.id === 'rma2')!.ticketId, 'tc');

  // Archived, closed or spam tickets start a new case instead.
  const closed = fakeDb({ tickets: [{ id: 'tz', ref: 'TKT-2026-CLOSED', orderId: 'o1', submittedById: 'u-buyer', email: 'b@x.org', status: 'CLOSED', archivedAt: AT, priority: 'NORMAL', tags: [], createdAt: AT }], returns: [{ id: 'rma2', orderId: 'o1', ticketId: null }] });
  assert.equal((await openRmaTicket(closed.db, input, closed.createTicket)).reused, false);
});

test('every RMA step is posted on the ticket; the ticket is resolved with the RMA (G6/J11, D53)', async () => {
  const { state, db } = fakeDb({ tickets: [{ id: 't', ref: 'TKT-2026-MTZ8OG', status: 'WAITING_ON_SUPPORT', priority: 'HIGH', dueAt: new Date(AT.getTime() + 8 * HOUR), createdAt: AT }] });
  const post = (step: Parameters<typeof postRmaEvent>[1]['step'], fromStaff = true, at = AT) => postRmaEvent(db, { ticketId: 't', step, body: `${step} text`, fromStaff, authorId: fromStaff ? 'staff' : 'u-buyer', at });
  const ticket = () => state.tickets[0];

  assert.equal(await post('APPROVED'), true);
  assert.equal(ticket().status, 'WAITING_ON_CUSTOMER');
  assert.equal(ticket().dueAt, null);
  await post('SENT_BACK', false);
  assert.equal(ticket().status, 'WAITING_ON_SUPPORT');
  assert.equal(ticket().lastReplyByStaff, false);
  await post('GOODS_RECEIVED');
  await post('INSPECTED');
  assert.equal(state.messages[3].isInternalNote, true, 'the inspection is an internal note');
  assert.equal(ticket().status, 'WAITING_ON_SUPPORT', 'an internal note changes nothing');
  await post('RESOLVED');
  assert.equal(ticket().status, 'RESOLVED');
  assert.equal(ticket().dueAt, null);
  assert.deepEqual(state.messages.map((m) => m.body), ['APPROVED text', 'SENT_BACK text', 'GOODS_RECEIVED text', 'INSPECTED text', 'RESOLVED text']);
  assert.deepEqual(state.messages.map((m) => m.isInternalNote), [false, false, false, true, false]);

  // A return without (an existing) ticket: nothing posted, nothing thrown.
  assert.equal(await postRmaEvent(db, { ticketId: null, step: 'RESOLVED', body: 'x', fromStaff: true, authorId: null }), false);
  assert.equal(await postRmaEvent(db, { ticketId: 'gone', step: 'RESOLVED', body: 'x', fromStaff: true, authorId: null }), false);
  assert.equal(state.messages.length, 5);
});

test('resolving one return from two tabs at once: one claim wins, the other creates nothing (G6/J11, D38)', async () => {
  const { state, money } = fakeDb({ returns: [{ id: 'rma1', orderId: 'o1', status: 'INSPECTED' }] });
  const creditNotes: string[] = [];
  // The money transaction as createRefund runs it: the order row is locked (one at a time), the
  // return claims RESOLVED, and only then are the credit note and the refund created.
  let lock: Promise<unknown> = Promise.resolve();
  const moneyTx = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };
  const resolve = (tab: string) => moneyTx(async () => {
    const won = await claimRmaResolution(money, { returnId: 'rma1', from: ['INSPECTED'], outcome: 'PARTIAL_REFUND', note: `tab ${tab}`, actorId: 'staff', at: AT });
    if (!won) throw new Error('RMA-2026-8ROYA5-1 is already resolved');
    creditNotes.push(`CN for tab ${tab}`);
    state.refunds.push({ returnId: 'rma1', amountCents: 30000 });
    return tab;
  });
  const results = await Promise.allSettled([resolve('1'), resolve('2')]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.match(String((results[1] as PromiseRejectedResult).reason), /already resolved/);
  assert.equal(creditNotes.length, 1, 'one credit note');
  assert.equal(state.refunds.length, 1, 'one refund');
  assert.equal(state.returns[0].status, 'RESOLVED');
  assert.equal(state.returns[0].resolutionNote, 'tab 1');

  // A refund already booked for the return (data from before the fix) also blocks a new one.
  const legacy = fakeDb({ returns: [{ id: 'rma3', orderId: 'o1', status: 'INSPECTED' }], refunds: [{ returnId: 'rma3' }] });
  assert.equal(await claimRmaResolution(legacy.money, { returnId: 'rma3', from: ['INSPECTED'], outcome: 'FULL_REFUND', note: 'x', actorId: null }), false);
  assert.equal(legacy.state.returns[0].status, 'INSPECTED');
  // Not resolvable yet (goods not inspected): no claim.
  const early = fakeDb({ returns: [{ id: 'rma4', orderId: 'o1', status: 'RECEIVED' }] });
  assert.equal(await claimRmaResolution(early.money, { returnId: 'rma4', from: ['INSPECTED'], outcome: 'NONE', note: 'x', actorId: null }), false);
});
