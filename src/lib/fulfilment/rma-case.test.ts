import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimRma,
  finishRmaClaim,
  openRmaTicket,
  postRmaEvent,
  resolveRmaOnce,
  rmaOpenedTicket,
  rmaPriority,
  rmaTicketTransition,
  RMA_CLAIM_LEASE_MS,
  ticketFileHref,
  ticketUpdateForStep,
  type RmaMoney,
  type RmaTicketDb,
} from './rma-case';

// ── an in-memory stand-in for the few Prisma calls the RMA case makes ────────

type Row = Record<string, unknown>;

/** Just enough of Prisma's `where` for these calls: AND / OR, equality (dates by value), null, in / notIn, not, lt, hasSome, insensitive equals. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'AND') return (cond as Row[]).every((c) => matches(row, c));
    if (k === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    const v = row[k] ?? null;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (cond === null || typeof cond !== 'object') return v === cond;
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(v);
    if ('notIn' in c) return !(c.notIn as unknown[]).includes(v);
    if ('equals' in c) return c.mode === 'insensitive' ? String(v).toLowerCase() === String(c.equals).toLowerCase() : v === c.equals;
    if ('not' in c) return v !== c.not;
    if ('lt' in c) return v instanceof Date && v.getTime() < (c.lt as Date).getTime();
    if ('hasSome' in c) return ((v as unknown[] | null) ?? []).some((x) => (c.hasSome as unknown[]).includes(x));
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
  const state = { tickets: init.tickets ?? [], returns: init.returns ?? [], refunds: init.refunds ?? [], creditNotes: [] as string[], messages: [] as Row[], created: [] as Row[] };
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
      findUnique: async ({ where }: { where: { id: string } }) => state.returns.find((r) => r.id === where.id) ?? null,
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
    const t = { id: `t-new-${state.created.length + 1}`, ref: `TKT-2026-NEW00${state.created.length + 1}`, createdAt: (rest.lastReplyAt as Date | undefined) ?? new Date(), archivedAt: null, ...rest };
    state.created.push(t);
    state.tickets.push(t);
    state.messages.push({ ticketId: t.id, ...messages.create });
    return { id: t.id as string, ref: t.ref as string };
  };
  // A transaction: one at a time (the order row lock); a throw rolls the returns / refunds / credit notes back.
  let lock: Promise<unknown> = Promise.resolve();
  const tx = <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => {
    const run = lock.then(async () => {
      const snap = { returns: state.returns.map((r) => ({ ...r })), refunds: state.refunds.map((r) => ({ ...r })), creditNotes: [...state.creditNotes] };
      try {
        return await fn(db);
      } catch (e) {
        state.returns.splice(0, state.returns.length, ...snap.returns);
        state.refunds.splice(0, state.refunds.length, ...snap.refunds);
        state.creditNotes.splice(0, state.creditNotes.length, ...snap.creditNotes);
        throw e;
      }
    });
    lock = run.catch(() => undefined);
    return run;
  };
  return { state, db: db as unknown as RmaTicketDb, createTicket, money: db as unknown as Parameters<typeof resolveRmaOnce>[0], tx };
}

const AT = new Date('2026-10-18T09:00:00Z');
const HOUR = 3600e3;
const MIN = 60e3;
const order = { id: 'o1', buyerId: 'u-buyer', buyer: { name: 'Dr. A. Buyer', email: 'Buyer@Lab.example.org' } };
const ticketKeys = ['support-att/aa.jpg', 'support-att/bb.png'];
const REUSE = { categories: ['Return/refund', 'Order / delivery'], tags: ['complaint', 'return'] };
const input = {
  returnId: 'rma2', order, subject: 'RMA-2026-8ROYA5-2 — Transport damage — order L2D-2026-8ROYA5', body: 'RMA-2026-8ROYA5-2: Damaged in transport — 1 × Centrifuge\n\nThe lid arrived cracked.',
  fromStaff: false, authorId: 'u-buyer', attachments: ticketKeys.map(ticketFileHref), attachmentNames: ['lid.jpg', 'box.png'], reuse: REUSE, at: AT,
};
const day = 86_400_000;
const ticket = (t: Row): Row => ({ submittedById: 'u-buyer', email: 'buyer@lab.example.org', archivedAt: null, priority: 'NORMAL', tags: [], dueAt: null, category: null, ...t });

// ── the ticket ───────────────────────────────────────────────────────────────

test('ticket transitions: the buyer writes → our turn with an SLA; we answer → no reply owed; the RMA ends → resolved (its own ticket only)', () => {
  assert.deepEqual(rmaTicketTransition('OPENED'), { status: 'WAITING_ON_SUPPORT', sla: 'restart', internal: false });
  assert.deepEqual(rmaTicketTransition('FILES_ADDED'), { status: 'WAITING_ON_SUPPORT', sla: 'restart', internal: false });
  assert.equal(rmaTicketTransition('APPROVED').status, 'WAITING_ON_CUSTOMER', 'the buyer ships the goods back');
  assert.equal(rmaTicketTransition('SENT_BACK').sla, 'clear', 'nothing to answer while the parcel travels');
  assert.equal(rmaTicketTransition('INSPECTED').internal, true, 'grade + restock stay internal');
  assert.equal(rmaTicketTransition('DENIED').status, 'RESOLVED');
  assert.equal(rmaTicketTransition('RESOLVED').status, 'RESOLVED');
  // A ticket the return continued is not closed by it: only the message.
  assert.deepEqual(rmaTicketTransition('RESOLVED', false), { status: null, sla: 'keep', internal: false });
  assert.deepEqual(rmaTicketTransition('DENIED', false), { status: null, sla: 'keep', internal: false });
  assert.equal(rmaOpenedTicket(new Date(AT.getTime() + 5), AT), true, 'created right after the return');
  assert.equal(rmaOpenedTicket(new Date(AT.getTime() - day), AT), false, 'older than the return: continued');
  assert.equal(rmaOpenedTicket(AT, null), false, 'unknown: treated as continued (never closed)');
  assert.equal(rmaPriority('NORMAL'), 'HIGH');
  assert.equal(rmaPriority('LOW'), 'HIGH');
  assert.equal(rmaPriority('VIP'), 'VIP');
  assert.equal(rmaPriority('URGENT'), 'URGENT');
  const restart = ticketUpdateForStep('FILES_ADDED', { status: 'WAITING_ON_CUSTOMER', priority: 'HIGH' }, { fromStaff: false, at: AT });
  assert.equal((restart?.dueAt as Date).getTime(), AT.getTime() + 8 * HOUR, 'HIGH = 8 h response');
  assert.equal(restart?.slaBreachAt, null);
  assert.equal(restart?.lastReplyByStaff, false);
  assert.deepEqual(ticketUpdateForStep('RESOLVED', { status: 'CLOSED', priority: 'HIGH' }, { fromStaff: true, at: AT }), { lastReplyAt: AT, lastReplyByStaff: true, dueAt: null }, 'a closed ticket stays closed');
  assert.deepEqual(ticketUpdateForStep('RESOLVED', { status: 'WAITING_ON_SUPPORT', priority: 'HIGH' }, { fromStaff: true, at: AT, ownTicket: false }), { lastReplyAt: AT, lastReplyByStaff: true });
  assert.equal(ticketUpdateForStep('INSPECTED', { status: 'WAITING_ON_SUPPORT', priority: 'HIGH' }, { fromStaff: true, at: AT }), null);
});

test('no open complaint ticket about the order: one new HIGH ticket with the SLA due date and the photos, linked to the return', async () => {
  const { state, db, createTicket } = fakeDb({ returns: [{ id: 'rma2', orderId: 'o1', ticketId: null }] });
  const t = await openRmaTicket(db, input, createTicket);
  assert.equal(t.reused, false);
  assert.equal(state.created.length, 1);
  const created = state.created[0];
  assert.equal(created.priority, 'HIGH');
  assert.equal(created.status, 'WAITING_ON_SUPPORT');
  assert.equal(created.category, 'Return/refund');
  assert.equal((created.dueAt as Date).getTime(), AT.getTime() + 8 * HOUR);
  assert.deepEqual(created.lastReplyAt, AT);
  assert.equal(created.orderId, 'o1');
  assert.equal(created.submittedById, 'u-buyer');
  assert.deepEqual(created.tags, ['return']);
  // The ticket shows its own copies (support-att/): staff with tickets:view and a guest link can open them.
  assert.deepEqual(state.messages[0].attachments, ['/api/support-attachment/support-att/aa.jpg', '/api/support-attachment/support-att/bb.png']);
  assert.deepEqual(state.messages[0].attachmentNames, ['lid.jpg', 'box.png']);
  assert.equal(state.returns[0].ticketId, t.id);
});

test('the buyer’s open complaint ticket about the order is reused (one case), never another return’s ticket', async () => {
  const { state, db, createTicket } = fakeDb({
    tickets: [
      // The complaint the buyer opened about this order (D53: TKT-2026-N17GUF).
      ticket({ id: 'tc', ref: 'TKT-2026-N17GUF', orderId: 'o1', category: 'Order / delivery', status: 'WAITING_ON_SUPPORT', createdAt: new Date(AT.getTime() - 3 * day) }),
      // Newer, but it belongs to the first return of this order.
      ticket({ id: 't1', ref: 'TKT-2026-MTZ8OG', orderId: 'o1', category: 'Return/refund', status: 'OPEN', priority: 'HIGH', createdAt: new Date(AT.getTime() - day) }),
      // Same buyer, another order; and another customer's ticket on this order.
      ticket({ id: 'tx', ref: 'TKT-2026-OTHER1', orderId: 'o9', category: 'Order / delivery', status: 'OPEN', createdAt: AT }),
      ticket({ id: 'ty', ref: 'TKT-2026-OTHER2', orderId: 'o1', category: 'Order / delivery', submittedById: 'u-else', email: 'else@lab.example.org', status: 'OPEN', createdAt: AT }),
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

  // A “General” question the buyer tagged / staff tagged as a complaint counts too.
  const tagged = fakeDb({ tickets: [ticket({ id: 'tg', ref: 'TKT-2026-TAGGED', orderId: 'o1', category: 'General', tags: ['complaint'], status: 'OPEN', createdAt: AT })], returns: [{ id: 'rma2', orderId: 'o1', ticketId: null }] });
  assert.equal((await openRmaTicket(tagged.db, input, tagged.createTicket)).id, 'tg');
  // Archived, closed or spam tickets start a new case instead.
  const closed = fakeDb({ tickets: [ticket({ id: 'tz', ref: 'TKT-2026-CLOSED', orderId: 'o1', category: 'Return/refund', status: 'CLOSED', archivedAt: AT, createdAt: AT })], returns: [{ id: 'rma2', orderId: 'o1', ticketId: null }] });
  assert.equal((await openRmaTicket(closed.db, input, closed.createTicket)).reused, false);
});

test('a billing ticket on the same order is not reused and not closed by the return', async () => {
  const billingDue = new Date(AT.getTime() + 20 * HOUR);
  const opened = new Date(AT.getTime() - 1000);
  const { state, db, createTicket } = fakeDb({
    tickets: [
      // “Please change the invoice address” — waiting for the buyer's answer, about the same order.
      ticket({ id: 'tb', ref: 'TKT-2026-BILL01', orderId: 'o1', category: 'Billing', status: 'WAITING_ON_CUSTOMER', dueAt: billingDue, createdAt: new Date(AT.getTime() - day) }),
      ticket({ id: 'tq', ref: 'TKT-2026-GEN001', orderId: 'o1', category: 'General', status: 'WAITING_ON_SUPPORT', createdAt: new Date(AT.getTime() - 2 * day) }),
    ],
    returns: [{ id: 'rma2', orderId: 'o1', ticketId: null, createdAt: opened }],
  });
  const t = await openRmaTicket(db, input, createTicket);
  assert.equal(t.reused, false, 'the return gets its own ticket');
  const before = (id: string) => state.tickets.find((x) => x.id === id)!;
  assert.equal(before('tb').status, 'WAITING_ON_CUSTOMER');
  assert.equal(before('tb').priority, 'NORMAL');
  assert.deepEqual(before('tb').tags, []);
  assert.equal(before('tb').dueAt, billingDue);
  assert.equal(before('tq').status, 'WAITING_ON_SUPPORT');
  assert.ok(!state.messages.some((m) => m.ticketId === 'tb' || m.ticketId === 'tq'), 'nothing posted on them');
  // The RMA is rejected / resolved: its own ticket is resolved, the billing question stays in the queue.
  await postRmaEvent(db, { ticketId: t.id, returnOpenedAt: opened, step: 'RESOLVED', body: 'resolved', fromStaff: true, authorId: 'staff', at: AT });
  assert.equal(before(t.id).status, 'RESOLVED');
  assert.equal(before('tb').status, 'WAITING_ON_CUSTOMER');
  assert.equal(before('tb').dueAt, billingDue);

  // Nothing configured: never continued automatically.
  const none = fakeDb({ tickets: [ticket({ id: 'tc', ref: 'TKT-2026-N17GUF', orderId: 'o1', category: 'Return/refund', status: 'OPEN', createdAt: AT })], returns: [{ id: 'rma2', orderId: 'o1', ticketId: null }] });
  assert.equal((await openRmaTicket(none.db, { ...input, reuse: { categories: [], tags: [] } }, none.createTicket)).reused, false);
});

test('every RMA step is posted on the ticket; the ticket the return opened is resolved with it (G6/J11, D53)', async () => {
  const opened = new Date(AT.getTime() - 1000);
  const { state, db } = fakeDb({ tickets: [{ id: 't', ref: 'TKT-2026-MTZ8OG', status: 'WAITING_ON_SUPPORT', priority: 'HIGH', dueAt: new Date(AT.getTime() + 8 * HOUR), createdAt: AT }] });
  const post = (step: Parameters<typeof postRmaEvent>[1]['step'], fromStaff = true, at = AT) => postRmaEvent(db, { ticketId: 't', returnOpenedAt: opened, step, body: `${step} text`, fromStaff, authorId: fromStaff ? 'staff' : 'u-buyer', at });
  const tk = () => state.tickets[0];

  assert.equal(await post('APPROVED'), true);
  assert.equal(tk().status, 'WAITING_ON_CUSTOMER');
  assert.equal(tk().dueAt, null);
  await post('SENT_BACK', false);
  assert.equal(tk().status, 'WAITING_ON_SUPPORT');
  assert.equal(tk().lastReplyByStaff, false);
  await post('GOODS_RECEIVED');
  await post('INSPECTED');
  assert.equal(state.messages[3].isInternalNote, true, 'the inspection is an internal note');
  assert.equal(tk().status, 'WAITING_ON_SUPPORT', 'an internal note changes nothing');
  await post('RESOLVED');
  assert.equal(tk().status, 'RESOLVED');
  assert.equal(tk().dueAt, null);
  assert.deepEqual(state.messages.map((m) => m.body), ['APPROVED text', 'SENT_BACK text', 'GOODS_RECEIVED text', 'INSPECTED text', 'RESOLVED text']);
  assert.deepEqual(state.messages.map((m) => m.isInternalNote), [false, false, false, true, false]);

  // A return without (an existing) ticket: nothing posted, nothing thrown.
  assert.equal(await postRmaEvent(db, { ticketId: null, step: 'RESOLVED', body: 'x', fromStaff: true, authorId: null }), false);
  assert.equal(await postRmaEvent(db, { ticketId: 'gone', step: 'RESOLVED', body: 'x', fromStaff: true, authorId: null }), false);
  assert.equal(state.messages.length, 5);
});

test('a continued complaint ticket gets the outcome as a message but stays open for staff', async () => {
  const due = new Date(AT.getTime() + 2 * HOUR);
  const { state, db } = fakeDb({ tickets: [ticket({ id: 'tc', ref: 'TKT-2026-N17GUF', orderId: 'o1', category: 'Order / delivery', status: 'WAITING_ON_SUPPORT', priority: 'HIGH', dueAt: due, createdAt: new Date(AT.getTime() - 3 * day) })] });
  for (const step of ['DENIED', 'RESOLVED'] as const) {
    assert.equal(await postRmaEvent(db, { ticketId: 'tc', returnOpenedAt: new Date(AT.getTime() - day), step, body: `${step} text`, fromStaff: true, authorId: 'staff', at: AT }), true);
    assert.equal(state.tickets[0].status, 'WAITING_ON_SUPPORT', `${step}: not resolved`);
    assert.equal(state.tickets[0].dueAt, due, `${step}: its SLA is untouched`);
  }
  assert.deepEqual(state.messages.map((m) => m.body), ['DENIED text', 'RESOLVED text']);
  // Without the return's date the ticket is never closed either.
  await postRmaEvent(db, { ticketId: 'tc', step: 'RESOLVED', body: 'x', fromStaff: true, authorId: 'staff', at: AT });
  assert.equal(state.tickets[0].status, 'WAITING_ON_SUPPORT');
});

// ── the one-time resolution ──────────────────────────────────────────────────

/** Stripe as the refund core sees it: one call per request; the same idempotency key returns the stored result. */
function fakeStripe() {
  const calls: Array<{ key: string; amountCents: number }> = [];
  const stored = new Map<string, { ok: true; id: string } | { ok: false }>();
  let open: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const s = {
    calls,
    stored,
    fail: false,
    /** Keep the next card refunds in flight until go(). */
    hold() { gate = new Promise((r) => { open = r; }); },
    go() { open?.(); gate = null; },
    async refund(key: string, amountCents: number) {
      calls.push({ key, amountCents });
      if (gate) await gate;
      const prev = stored.get(key);
      if (prev) return prev;
      const res = s.fail ? { ok: false as const } : { ok: true as const, id: `re_${stored.size + 1}` };
      stored.set(key, res);
      return res;
    },
  };
  return s;
}

/**
 * createRefund as resolveReturn calls it: the card refund goes to Stripe BEFORE
 * the transaction (key rma-<id>-<amount>), then the locked transaction runs the
 * RMA's finish and books the credit note and the refund (or rolls back).
 */
function moneyFor(f: ReturnType<typeof fakeDb>, stripe: ReturnType<typeof fakeStripe>) {
  return (tab: { method: 'STRIPE' | 'BANK_TRANSFER'; amountCents: number; bookingFails?: boolean }): RmaMoney<{ refundId: string }> => async (finish) => {
    let stripeId: string | null = null;
    if (tab.method === 'STRIPE') {
      const s = await stripe.refund(`rma-rma1-${tab.amountCents}`, tab.amountCents);
      if (!s.ok) return { ok: false, message: 'Stripe refused the card refund (balance_insufficient). Nothing was changed here.', moneyMoved: false };
      stripeId = s.id;
    }
    try {
      return await f.tx(async (tx) => {
        if (!(await finish(tx as unknown as Parameters<typeof finish>[0]))) throw new Error('RMA-2026-8ROYA5-1 was resolved meanwhile (another tab or a colleague).');
        if (tab.bookingFails) throw new Error('the credit note could not be numbered');
        const already = f.state.refunds.find((r) => stripeId && r.stripeRefundId === stripeId);
        if (already) throw new Error('that card refund is booked already');
        f.state.creditNotes.push(`CN-2026-0000${f.state.creditNotes.length + 4}`);
        const id = `rf${f.state.refunds.length + 1}`;
        f.state.refunds.push({ id, returnId: 'rma1', amountCents: tab.amountCents, method: tab.method, stripeRefundId: stripeId });
        return { ok: true as const, value: { refundId: id } };
      });
    } catch (e) {
      const m = (e as Error).message;
      return { ok: false, message: stripeId ? `The card refund WAS issued in Stripe (${stripeId}) but could not be recorded: ${m} Do not refund again — record it by hand.` : m, moneyMoved: !!stripeId };
    }
  };
}

const RMA = { returnId: 'rma1', rmaNumber: 'RMA-2026-8ROYA5-1', from: ['INSPECTED'] as const, note: 'Refund after inspection' };
const at = (ms: number) => new Date(AT.getTime() + ms);
async function until(cond: () => boolean) {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), 'condition never became true');
}

test('two tabs resolve one return with different methods / outcomes: one claim, one Stripe call, one refund (G6/J11, D38)', async () => {
  const f = fakeDb({ returns: [{ id: 'rma1', orderId: 'o1', status: 'INSPECTED', resolvedAt: null, resolvedById: null, outcome: null }] });
  const stripe = fakeStripe();
  const money = moneyFor(f, stripe);
  stripe.hold();
  // Tab A: full refund to the card — its Stripe call is in flight …
  const tabA = resolveRmaOnce(f.money, { ...RMA, outcome: 'FULL_REFUND', actorId: 'staff-a', at: AT }, money({ method: 'STRIPE', amountCents: 121000 }));
  await until(() => stripe.calls.length === 1);
  // … while tab B books a bank transfer and tab C closes it as “No action”.
  const tabB = await resolveRmaOnce(f.money, { ...RMA, outcome: 'PARTIAL_REFUND', actorId: 'staff-b', at: at(2000) }, money({ method: 'BANK_TRANSFER', amountCents: 30000 }));
  const tabC = await resolveRmaOnce(f.money, { ...RMA, outcome: 'NONE', actorId: 'staff-b', at: at(3000) }, null);
  for (const r of [tabB, tabC]) {
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /^RMA-2026-8ROYA5-1 is being resolved right now .* nothing was done here/);
  }
  assert.equal(f.state.returns[0].status, 'INSPECTED', 'B and C changed nothing');
  stripe.go();
  const a = await tabA;
  assert.equal(a.ok, true);
  assert.equal(stripe.calls.length, 1, 'one Stripe call');
  assert.equal(f.state.refunds.length, 1, 'one refund');
  assert.equal(f.state.creditNotes.length, 1, 'one credit note');
  assert.equal(f.state.refunds[0].method, 'STRIPE');
  assert.equal(f.state.returns[0].status, 'RESOLVED');
  assert.equal(f.state.returns[0].outcome, 'FULL_REFUND');
  assert.equal(f.state.returns[0].resolvedById, 'staff-a');
  // Later clicks: already resolved, nothing moves.
  const late = await resolveRmaOnce(f.money, { ...RMA, outcome: 'FULL_REFUND', actorId: 'staff-a', at: at(MIN) }, money({ method: 'STRIPE', amountCents: 121000 }));
  assert.match((late as { message: string }).message, /already resolved .* nothing was credited or refunded twice/);
  assert.equal(stripe.calls.length, 1);
  assert.equal(f.state.refunds.length, 1);
});

test('the tab without money wins: the card tab never reaches Stripe', async () => {
  const f = fakeDb({ returns: [{ id: 'rma1', orderId: 'o1', status: 'INSPECTED', resolvedAt: null, resolvedById: null, outcome: null }] });
  const stripe = fakeStripe();
  const money = moneyFor(f, stripe);
  // At the same moment: the card tab finds the return taken (being / already resolved).
  const [none, card] = await Promise.all([
    resolveRmaOnce(f.money, { ...RMA, outcome: 'NONE', actorId: 'staff-b', at: AT }, null),
    resolveRmaOnce(f.money, { ...RMA, outcome: 'FULL_REFUND', actorId: 'staff-a', at: AT }, money({ method: 'STRIPE', amountCents: 121000 })),
  ]);
  assert.equal(none.ok, true);
  assert.equal(card.ok, false);
  assert.match((card as { message: string }).message, /being resolved right now|already resolved/);
  // A moment later: already resolved.
  const again = await resolveRmaOnce(f.money, { ...RMA, outcome: 'FULL_REFUND', actorId: 'staff-a', at: at(MIN) }, money({ method: 'STRIPE', amountCents: 121000 }));
  assert.match((again as { message: string }).message, /already resolved/);
  assert.equal(stripe.calls.length, 0, 'no card refund for a return closed as “No action”');
  assert.equal(f.state.refunds.length, 0);
  assert.equal(f.state.returns[0].outcome, 'NONE');
});

test('Stripe refuses: the claim is given back and a corrected amount is a new card refund request', async () => {
  const f = fakeDb({ returns: [{ id: 'rma1', orderId: 'o1', status: 'INSPECTED', resolvedAt: null, resolvedById: null, outcome: null }] });
  const stripe = fakeStripe();
  const money = moneyFor(f, stripe);
  stripe.fail = true;
  const first = await resolveRmaOnce(f.money, { ...RMA, outcome: 'FULL_REFUND', actorId: 'staff-a', at: AT }, money({ method: 'STRIPE', amountCents: 121000 }));
  assert.match((first as { message: string }).message, /^RMA-2026-8ROYA5-1 not resolved — Stripe refused/);
  assert.equal(f.state.returns[0].resolvedAt, null, 'the return is free again');
  assert.equal(f.state.returns[0].resolvedById, null);
  stripe.fail = false;
  // The same amount would get the stored Stripe error back; staff correct the amount.
  const retry = await resolveRmaOnce(f.money, { ...RMA, outcome: 'PARTIAL_REFUND', actorId: 'staff-a', at: at(MIN) }, money({ method: 'STRIPE', amountCents: 120000 }));
  assert.equal(retry.ok, true);
  assert.deepEqual(stripe.calls.map((c) => c.key), ['rma-rma1-121000', 'rma-rma1-120000']);
  assert.equal(f.state.refunds.length, 1);
  // A bank transfer after a refused card refund works as well (nothing went out).
  const g = fakeDb({ returns: [{ id: 'rma1', orderId: 'o1', status: 'INSPECTED', resolvedAt: null, resolvedById: null, outcome: null }] });
  const s2 = fakeStripe();
  s2.fail = true;
  await resolveRmaOnce(g.money, { ...RMA, outcome: 'FULL_REFUND', actorId: 'staff-a', at: AT }, moneyFor(g, s2)({ method: 'STRIPE', amountCents: 121000 }));
  assert.equal((await resolveRmaOnce(g.money, { ...RMA, outcome: 'FULL_REFUND', actorId: 'staff-a', at: at(MIN) }, moneyFor(g, s2)({ method: 'BANK_TRANSFER', amountCents: 121000 }))).ok, true);
});

test('a card refund issued but not booked keeps the claim: no other method on top of it; after the lease the same card refund is booked once', async () => {
  const f = fakeDb({ returns: [{ id: 'rma1', orderId: 'o1', status: 'INSPECTED', resolvedAt: null, resolvedById: null, outcome: null }] });
  const stripe = fakeStripe();
  const money = moneyFor(f, stripe);
  const first = await resolveRmaOnce(f.money, { ...RMA, outcome: 'FULL_REFUND', actorId: 'staff-a', at: AT }, money({ method: 'STRIPE', amountCents: 121000, bookingFails: true }));
  assert.match((first as { message: string }).message, /WAS issued in Stripe \(re_1\) .* Do not refund again/);
  assert.equal(f.state.returns[0].status, 'INSPECTED', 'the transaction rolled back');
  assert.deepEqual(f.state.returns[0].resolvedAt, AT, 'the claim is kept');
  const bank = await resolveRmaOnce(f.money, { ...RMA, outcome: 'FULL_REFUND', actorId: 'staff-b', at: at(2 * MIN) }, money({ method: 'BANK_TRANSFER', amountCents: 121000 }));
  assert.match((bank as { message: string }).message, /being resolved right now/);
  assert.equal(f.state.refunds.length, 0, 'no bank refund on top of the card refund');
  // After the lease: the same card refund (same key) — Stripe returns re_1, it is booked once.
  const later = await resolveRmaOnce(f.money, { ...RMA, outcome: 'FULL_REFUND', actorId: 'staff-a', at: at(RMA_CLAIM_LEASE_MS + MIN) }, money({ method: 'STRIPE', amountCents: 121000 }));
  assert.equal(later.ok, true);
  assert.equal(stripe.stored.size, 1, 'one card refund in Stripe');
  assert.deepEqual(f.state.refunds.map((r) => r.stripeRefundId), ['re_1']);
});

test('claims: an abandoned claim expires after the lease; its late finish creates nothing; a booked refund blocks; not resolvable yet', async () => {
  const dead = { returnId: 'rma1', from: ['INSPECTED'] as const, actorId: 'staff-dead', at: new Date(AT.getTime() - RMA_CLAIM_LEASE_MS - MIN) };
  const f = fakeDb({ returns: [{ id: 'rma1', orderId: 'o1', status: 'INSPECTED', resolvedAt: dead.at, resolvedById: 'staff-dead', outcome: null }] });
  assert.equal(await claimRma(f.money, { returnId: 'rma1', from: ['INSPECTED'], actorId: 'staff-b', at: new Date(dead.at.getTime() + MIN) }), null, 'a live claim is respected');
  const mine = await claimRma(f.money, { returnId: 'rma1', from: ['INSPECTED'], actorId: 'staff-b', at: AT });
  assert.ok(mine, 'an abandoned claim is free');
  assert.equal(await finishRmaClaim(f.money, dead, { outcome: 'FULL_REFUND', note: 'late' }), false, 'the dead request books nothing');
  assert.equal(await finishRmaClaim(f.money, mine!, { outcome: 'REPAIR', note: 'Repaired under warranty', at: AT }), true);
  assert.equal(f.state.returns[0].outcome, 'REPAIR');

  // A refund already booked for the return (data from before the fix) blocks a new resolution.
  const legacy = fakeDb({ returns: [{ id: 'rma1', orderId: 'o1', status: 'INSPECTED', resolvedAt: null }], refunds: [{ returnId: 'rma1' }] });
  const r = await resolveRmaOnce(legacy.money, { ...RMA, outcome: 'FULL_REFUND', actorId: null }, null);
  assert.match((r as { message: string }).message, /A refund is already booked for RMA-2026-8ROYA5-1/);
  assert.equal(legacy.state.returns[0].status, 'INSPECTED');
  // Not resolvable yet (goods not inspected): no claim.
  const early = fakeDb({ returns: [{ id: 'rma1', orderId: 'o1', status: 'RECEIVED', resolvedAt: null }] });
  assert.equal(await claimRma(early.money, { returnId: 'rma1', from: ['INSPECTED'], actorId: null }), null);
  assert.match(((await resolveRmaOnce(early.money, { ...RMA, outcome: 'NONE', actorId: null }, null)) as { message: string }).message, /changed meanwhile/);
});
