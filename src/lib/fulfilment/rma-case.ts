import type { Prisma, ReturnStatus, TicketStatus } from '@prisma/client';
import { ACTIVE_TICKET_STATUSES, computeDueAt } from '@/lib/support/statuses';

/**
 * One case per return (RMA): the support ticket that carries its conversation
 * and the one-time resolution.
 *  - The ticket: the buyer's open ticket about a problem with the goods of the
 *    same order (Settings → Returns & refunds: ticket categories / tags) when
 *    there is one, else a new HIGH ticket — with an SLA due date and the
 *    buyer's photos either way. Every RMA step is posted on it (inspection as
 *    an internal note). A ticket the return opened is resolved when the RMA is
 *    resolved or rejected; a ticket it continued only gets the message (it may
 *    hold more than the return — staff close it).
 *  - The resolution: claimed BEFORE any money moves (compare-and-set on
 *    resolvedAt / resolvedById, which only resolving writes), then turned
 *    RESOLVED inside the transaction that books the credit note and the refund,
 *    and only while the claim is still ours. A second tab — whatever outcome or
 *    refund method it chose — is told the return is being / already resolved
 *    and moves no money.
 * DB access goes through the client the caller passes (prisma or a
 * transaction). Server-internal.
 */

type Delegates = Prisma.TransactionClient;
export interface RmaTicketDb {
  supportTicket: Pick<Delegates['supportTicket'], 'findFirst' | 'findUnique' | 'update'>;
  supportMessage: Pick<Delegates['supportMessage'], 'create'>;
  returnRequest: Pick<Delegates['returnRequest'], 'findMany' | 'update'>;
}

/**
 * Return photos / labels as the ticket shows them: a copy stored under
 * support-att/ (lib/storage/s3 supportAttachmentKey), served by
 * /api/support-attachment to the people who work or own the ticket — staff
 * with tickets:view, the buyer, a guest ticket's magic link.
 */
export const ticketFileHref = (key: string) => `/api/support-attachment/${key}`;

export type RmaStep =
  | 'OPENED' | 'FILES_ADDED' | 'SENT_BACK'
  | 'APPROVED' | 'APPROVED_NO_RETURN' | 'GOODS_RECEIVED' | 'INSPECTED'
  | 'DENIED' | 'RESOLVED';

export interface TicketTransition {
  /** Ticket status after the step (null = unchanged). A CLOSED or SPAM ticket keeps its status. */
  status: TicketStatus | null;
  /** restart = a reply is owed (due = now + SLA of the priority); clear = we answered, no reply owed. */
  sla: 'restart' | 'clear' | 'keep';
  /** Staff-only note (never shown to the buyer, no status change). */
  internal: boolean;
}

/**
 * Whose move it is after each RMA step, and whether the support response clock
 * runs. `ownTicket` = the return opened the ticket (false: it continued the
 * buyer's earlier ticket, which the end of the RMA does not close).
 */
export function rmaTicketTransition(step: RmaStep, ownTicket = true): TicketTransition {
  switch (step) {
    // The buyer wrote (the report, more photos): our turn, the response clock runs.
    case 'OPENED':
    case 'FILES_ADDED':
      return { status: 'WAITING_ON_SUPPORT', sla: 'restart', internal: false };
    // Goods on their way back: our move once they arrive — nothing to answer until then.
    case 'SENT_BACK':
      return { status: 'WAITING_ON_SUPPORT', sla: 'clear', internal: false };
    // Approved with return instructions: the buyer sends the goods.
    case 'APPROVED':
      return { status: 'WAITING_ON_CUSTOMER', sla: 'clear', internal: false };
    // We answered; settling / inspecting is ours (Orders → Returns tracks it).
    case 'APPROVED_NO_RETURN':
    case 'GOODS_RECEIVED':
      return { status: 'WAITING_ON_SUPPORT', sla: 'clear', internal: false };
    case 'INSPECTED':
      return { status: null, sla: 'keep', internal: true };
    // The RMA ended: a ticket the return opened is resolved with it (the buyer can still reply and
    // reopen it). A continued ticket only gets the message — status and SLA stay as they are.
    case 'DENIED':
    case 'RESOLVED':
      return ownTicket ? { status: 'RESOLVED', sla: 'clear', internal: false } : { status: null, sla: 'keep', internal: false };
  }
}

/** The return opened this ticket (it is not older than the return); an older ticket was continued by it. */
export function rmaOpenedTicket(ticketCreatedAt: Date, returnCreatedAt: Date | null | undefined): boolean {
  return !!returnCreatedAt && ticketCreatedAt.getTime() >= returnCreatedAt.getTime();
}

const PRIORITY_RANK: Record<string, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3, VIP: 4 };
/** A return is at least HIGH; a ticket that is already more urgent (or VIP) keeps its priority. */
export function rmaPriority(current: string | null | undefined): string {
  const c = current ?? 'NORMAL';
  return (PRIORITY_RANK[c] ?? 1) >= PRIORITY_RANK.HIGH ? c : 'HIGH';
}

/** The ticket fields a step changes (null = none, e.g. an internal note). */
export function ticketUpdateForStep(
  step: RmaStep,
  ticket: { status: TicketStatus; priority: string },
  p: { fromStaff: boolean; at: Date; ownTicket?: boolean },
): Prisma.SupportTicketUpdateInput | null {
  const t = rmaTicketTransition(step, p.ownTicket ?? true);
  if (t.internal) return null;
  return {
    lastReplyAt: p.at,
    lastReplyByStaff: p.fromStaff,
    ...(t.status && ticket.status !== 'CLOSED' && ticket.status !== 'SPAM' ? { status: t.status } : {}),
    ...(t.sla === 'restart' ? { dueAt: computeDueAt(p.at, ticket.priority), slaBreachAt: null } : t.sla === 'clear' ? { dueAt: null } : {}),
  };
}

export interface RmaTicketInput {
  returnId: string;
  order: { id: string; buyerId: string; buyer: { name: string; email: string } };
  /** Subject of a new ticket. */
  subject: string;
  /** The report as the first message (or the message on the reused ticket). */
  body: string;
  fromStaff: boolean;
  authorId: string | null;
  attachments: string[];
  attachmentNames: string[];
  /**
   * Which open tickets are about a problem with the goods and may carry the
   * return (Settings → Returns & refunds): ticket categories (any case) and tags.
   */
  reuse: { categories: string[]; tags: string[] };
  /** The ticket the return was opened from (it must be the buyer's, about this order or not linked yet). */
  ticketId?: string | null;
  at?: Date;
}

export type CreateTicket = (data: Omit<Prisma.SupportTicketUncheckedCreateInput, 'ref'>) => Promise<{ id: string; ref: string }>;

/**
 * Link the new return to its ticket: reuse the buyer's open complaint ticket
 * about this order — a category / tag from `reuse`, never a billing or general
 * question, never one that already belongs to another return — else create
 * one. A ticket the return was explicitly opened from is used as it is.
 * Either way the ticket is the support team's move with an SLA due date, at
 * least HIGH priority, tagged “return”, and carries the report and its photos.
 */
export async function openRmaTicket(db: RmaTicketDb, p: RmaTicketInput, createTicket: CreateTicket): Promise<{ id: string; ref: string; reused: boolean }> {
  const at = p.at ?? new Date();
  const taken = (await db.returnRequest.findMany({ where: { orderId: p.order.id, ticketId: { not: null }, id: { not: p.returnId } }, select: { ticketId: true } }))
    .map((r) => r.ticketId)
    .filter((id): id is string => !!id);
  const aboutGoods: Prisma.SupportTicketWhereInput[] = [
    ...p.reuse.categories.map((c): Prisma.SupportTicketWhereInput => ({ category: { equals: c, mode: 'insensitive' } })),
    ...(p.reuse.tags.length ? [{ tags: { hasSome: p.reuse.tags } }] : []),
  ];
  const reuse = p.ticketId || aboutGoods.length
    ? await db.supportTicket.findFirst({
        where: {
          AND: [
            p.ticketId ? { id: p.ticketId, OR: [{ orderId: p.order.id }, { orderId: null }] } : { orderId: p.order.id, OR: aboutGoods },
            { OR: [{ submittedById: p.order.buyerId }, { email: { equals: p.order.buyer.email, mode: 'insensitive' } }] },
            { status: { in: ACTIVE_TICKET_STATUSES } },
            { archivedAt: null },
            ...(taken.length ? [{ id: { notIn: taken } }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, ref: true, priority: true, tags: true },
      })
    : null;
  const message = { fromStaff: p.fromStaff, authorId: p.authorId, body: p.body.slice(0, 5000), attachments: p.attachments, attachmentNames: p.attachmentNames };
  let ticket: { id: string; ref: string; reused: boolean };
  if (reuse) {
    const priority = rmaPriority(reuse.priority);
    await db.supportMessage.create({ data: { ticketId: reuse.id, ...message } });
    await db.supportTicket.update({
      where: { id: reuse.id },
      data: {
        status: 'WAITING_ON_SUPPORT', priority, dueAt: computeDueAt(at, priority), slaBreachAt: null,
        lastReplyAt: at, lastReplyByStaff: p.fromStaff, orderId: p.order.id,
        ...(reuse.tags.includes('return') ? {} : { tags: { push: 'return' } }),
      },
    });
    ticket = { id: reuse.id, ref: reuse.ref, reused: true };
  } else {
    const t = await createTicket({
      name: p.order.buyer.name, email: p.order.buyer.email, subject: p.subject.slice(0, 160),
      category: 'Return/refund', priority: 'HIGH', orderId: p.order.id, submittedById: p.order.buyerId,
      status: 'WAITING_ON_SUPPORT', dueAt: computeDueAt(at, 'HIGH'), lastReplyAt: at, lastReplyByStaff: p.fromStaff, tags: ['return'],
      messages: { create: message },
    });
    ticket = { id: t.id, ref: t.ref, reused: false };
  }
  await db.returnRequest.update({ where: { id: p.returnId }, data: { ticketId: ticket.id } });
  return ticket;
}

/**
 * Post one RMA step on the return's ticket and move the ticket on. False when
 * the return has no (existing) ticket. `returnOpenedAt` (the return's
 * createdAt) tells a ticket the return opened from one it continued; without
 * it the ticket is treated as continued (never closed by the RMA).
 */
export async function postRmaEvent(
  db: RmaTicketDb,
  p: { ticketId: string | null | undefined; returnOpenedAt?: Date | null; step: RmaStep; body: string; fromStaff: boolean; authorId: string | null; attachments?: string[]; attachmentNames?: string[]; at?: Date },
): Promise<boolean> {
  if (!p.ticketId) return false;
  const t = await db.supportTicket.findUnique({ where: { id: p.ticketId }, select: { id: true, status: true, priority: true, createdAt: true } });
  if (!t) return false;
  const at = p.at ?? new Date();
  const internal = rmaTicketTransition(p.step).internal;
  await db.supportMessage.create({
    data: { ticketId: t.id, fromStaff: p.fromStaff, authorId: p.authorId, body: p.body.slice(0, 5000), attachments: p.attachments ?? [], attachmentNames: p.attachmentNames ?? [], isInternalNote: internal },
  });
  const data = ticketUpdateForStep(p.step, t, { fromStaff: p.fromStaff, at, ownTicket: rmaOpenedTicket(t.createdAt, p.returnOpenedAt) });
  if (data) await db.supportTicket.update({ where: { id: t.id }, data });
  return true;
}

// ── the one-time resolution ──────────────────────────────────────────────────

/**
 * A claim older than this is abandoned (the request died between claiming and
 * booking): the return can be resolved again. Well above the longest a card
 * refund request can take (the Stripe SDK: 80 s timeout, 2 retries), so a live
 * claim is not taken over while its money is moving.
 */
export const RMA_CLAIM_LEASE_MS = 10 * 60_000;

export interface RmaClaimDb {
  refund: Pick<Delegates['refund'], 'count'>;
  returnRequest: Pick<Delegates['returnRequest'], 'updateMany'>;
}

/** Who holds the return while it is being resolved: resolvedAt = the claim time, resolvedById = the actor. */
export interface RmaClaim {
  returnId: string;
  from: readonly ReturnStatus[];
  actorId: string | null;
  at: Date;
}

/** The return still carries exactly this claim (not taken over after the lease, not resolved). */
const heldBy = (c: RmaClaim) => ({ id: c.returnId, status: { in: [...c.from] }, resolvedAt: c.at, resolvedById: c.actorId });

/**
 * Step 1 — before ANY money moves (credit note, refund, card refund): take the
 * return. Only from a resolvable status, only while nobody holds a live claim,
 * only while no refund is booked for it. Null = someone else is resolving it
 * (or did) — do nothing.
 */
export async function claimRma(db: RmaClaimDb, p: { returnId: string; from: readonly ReturnStatus[]; actorId: string | null; at?: Date }): Promise<RmaClaim | null> {
  const at = p.at ?? new Date();
  if ((await db.refund.count({ where: { returnId: p.returnId } })) > 0) return null;
  const c = await db.returnRequest.updateMany({
    where: { id: p.returnId, status: { in: [...p.from] }, OR: [{ resolvedAt: null }, { resolvedAt: { lt: new Date(at.getTime() - RMA_CLAIM_LEASE_MS) } }] },
    data: { resolvedAt: at, resolvedById: p.actorId },
  });
  return c.count === 1 ? { returnId: p.returnId, from: p.from, actorId: p.actorId, at } : null;
}

/**
 * Step 2 — inside the money transaction (order row locked), before the credit
 * note and the refund are created: RESOLVED with its outcome, only while the
 * claim is still ours and no refund is booked. False = create nothing.
 */
export async function finishRmaClaim(db: RmaClaimDb, claim: RmaClaim, p: { outcome: string; note: string; at?: Date }): Promise<boolean> {
  if ((await db.refund.count({ where: { returnId: claim.returnId } })) > 0) return false;
  const c = await db.returnRequest.updateMany({
    where: heldBy(claim),
    data: { status: 'RESOLVED', outcome: p.outcome, resolvedAt: p.at ?? new Date(), resolutionNote: p.note },
  });
  return c.count === 1;
}

/** Give the return back unresolved (nothing moved). A claim that is no longer ours is left alone. */
export async function releaseRmaClaim(db: Pick<RmaClaimDb, 'returnRequest'>, claim: RmaClaim): Promise<void> {
  await db.returnRequest.updateMany({ where: heldBy(claim), data: { resolvedAt: null, resolvedById: null } });
}

/**
 * The money part of a resolution (lib/finance/refunds createRefund): it calls
 * `finish` inside its transaction and rolls back when that returns false.
 * moneyMoved = a card refund was issued although nothing was booked.
 */
export type RmaMoney<T> = (finish: (tx: RmaClaimDb) => Promise<boolean>) => Promise<{ ok: true; value: T } | { ok: false; message: string; moneyMoved: boolean }>;

type ResolveDb = RmaClaimDb & { returnRequest: Pick<Delegates['returnRequest'], 'updateMany' | 'findUnique'> };

async function notClaimedMessage(db: ResolveDb, p: { returnId: string; rmaNumber: string; from: readonly ReturnStatus[] }): Promise<string> {
  const r = await db.returnRequest.findUnique({ where: { id: p.returnId }, select: { status: true, resolvedAt: true } });
  if (r?.status === 'RESOLVED') return `${p.rmaNumber} is already resolved (another tab or a colleague) — nothing was credited or refunded twice. Reload to see the outcome.`;
  if (r && (p.from as string[]).includes(r.status)) {
    if ((await db.refund.count({ where: { returnId: p.returnId } })) > 0) return `A refund is already booked for ${p.rmaNumber} — nothing was done here. Check the refunds of the order.`;
    if (r.resolvedAt) return `${p.rmaNumber} is being resolved right now (started less than ${Math.round(RMA_CLAIM_LEASE_MS / 60_000)} minutes ago, in another tab or by a colleague) — nothing was done here. Reload in a minute to see the outcome.`;
  }
  return `${p.rmaNumber} changed meanwhile — reload.`;
}

/**
 * Resolve a return exactly once: claim → (money, which turns the claim into
 * RESOLVED inside its transaction) → or RESOLVED directly without money. A
 * failure before any money moved gives the claim back; a card refund that was
 * issued but not booked keeps it for the lease time, so no other outcome or
 * method is booked on top of it meanwhile (staff are told to record it).
 */
export async function resolveRmaOnce<T>(
  db: ResolveDb,
  p: { returnId: string; rmaNumber: string; from: readonly ReturnStatus[]; outcome: string; note: string; actorId: string | null; at?: Date },
  money: RmaMoney<T> | null,
): Promise<{ ok: true; value: T | null } | { ok: false; message: string }> {
  const claim = await claimRma(db, p);
  if (!claim) return { ok: false, message: await notClaimedMessage(db, p) };
  if (!money) {
    if (await finishRmaClaim(db, claim, p)) return { ok: true, value: null };
    await releaseRmaClaim(db, claim);
    return { ok: false, message: await notClaimedMessage(db, p) };
  }
  const race = { lost: false };
  let r: Awaited<ReturnType<RmaMoney<T>>>;
  try {
    r = await money(async (tx) => {
      const won = await finishRmaClaim(tx, claim, p);
      race.lost = !won;
      return won;
    });
  } catch (e) {
    // The money step returns (never throws) once a card refund is issued: nothing moved here.
    await releaseRmaClaim(db, claim);
    throw e;
  }
  if (r.ok) return { ok: true, value: r.value };
  if (!r.moneyMoved) await releaseRmaClaim(db, claim);
  if (race.lost && !r.moneyMoved) return { ok: false, message: await notClaimedMessage(db, p) };
  return { ok: false, message: race.lost ? r.message : `${p.rmaNumber} not resolved — ${r.message}` };
}
