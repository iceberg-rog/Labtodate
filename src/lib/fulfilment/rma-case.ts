import type { Prisma, ReturnStatus, TicketStatus } from '@prisma/client';
import { ACTIVE_TICKET_STATUSES, computeDueAt } from '@/lib/support/statuses';

/**
 * One case per return (RMA): the support ticket that carries its conversation
 * and the one-time resolution.
 *  - The ticket: the buyer's open ticket about the same order when there is one
 *    (the complaint that led to the return), else a new HIGH ticket — with an
 *    SLA due date and the buyer's photos either way. Every RMA step is posted
 *    on it as a message (inspection as an internal note), and it is resolved
 *    when the RMA is resolved or rejected.
 *  - The resolution: claimed exactly once (status → RESOLVED, compare-and-set)
 *    inside the transaction that creates the credit note and the refund, so a
 *    second click / tab rolls back and creates nothing.
 * DB access goes through the client the caller passes (prisma or a
 * transaction). Server-internal.
 */

type Delegates = Prisma.TransactionClient;
export interface RmaTicketDb {
  supportTicket: Pick<Delegates['supportTicket'], 'findFirst' | 'findUnique' | 'update'>;
  supportMessage: Pick<Delegates['supportMessage'], 'create'>;
  returnRequest: Pick<Delegates['returnRequest'], 'findMany' | 'update'>;
}

/** Private return files (photos, labels) as links the ticket shows — the order's buyer and staff with orders:view may open them. */
export const orderFileHref = (key: string) => `/api/order-files/${key}`;

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

/** Whose move it is after each RMA step, and whether the support response clock runs. */
export function rmaTicketTransition(step: RmaStep): TicketTransition {
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
    // The RMA ended: the case is resolved with it (the buyer can still reply and reopen it).
    case 'DENIED':
    case 'RESOLVED':
      return { status: 'RESOLVED', sla: 'clear', internal: false };
  }
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
  p: { fromStaff: boolean; at: Date },
): Prisma.SupportTicketUpdateInput | null {
  const t = rmaTicketTransition(step);
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
  /** The ticket the return was opened from (it must be the buyer's, about this order or not linked yet). */
  ticketId?: string | null;
  at?: Date;
}

export type CreateTicket = (data: Omit<Prisma.SupportTicketUncheckedCreateInput, 'ref'>) => Promise<{ id: string; ref: string }>;

/**
 * Link the new return to its ticket: reuse the buyer's open ticket about this
 * order (not one that already belongs to another return), else create one.
 * Either way the ticket is the support team's move with an SLA due date, at
 * least HIGH priority, tagged “return”, and carries the report and its photos.
 */
export async function openRmaTicket(db: RmaTicketDb, p: RmaTicketInput, createTicket: CreateTicket): Promise<{ id: string; ref: string; reused: boolean }> {
  const at = p.at ?? new Date();
  const taken = (await db.returnRequest.findMany({ where: { orderId: p.order.id, ticketId: { not: null }, id: { not: p.returnId } }, select: { ticketId: true } }))
    .map((r) => r.ticketId)
    .filter((id): id is string => !!id);
  const reuse = await db.supportTicket.findFirst({
    where: {
      AND: [
        p.ticketId ? { id: p.ticketId, OR: [{ orderId: p.order.id }, { orderId: null }] } : { orderId: p.order.id },
        { OR: [{ submittedById: p.order.buyerId }, { email: { equals: p.order.buyer.email, mode: 'insensitive' } }] },
        { status: { in: ACTIVE_TICKET_STATUSES } },
        { archivedAt: null },
        ...(taken.length ? [{ id: { notIn: taken } }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, ref: true, priority: true, tags: true },
  });
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

/** Post one RMA step on the return's ticket and move the ticket on. False when the return has no (existing) ticket. */
export async function postRmaEvent(
  db: RmaTicketDb,
  p: { ticketId: string | null | undefined; step: RmaStep; body: string; fromStaff: boolean; authorId: string | null; attachments?: string[]; attachmentNames?: string[]; at?: Date },
): Promise<boolean> {
  if (!p.ticketId) return false;
  const t = await db.supportTicket.findUnique({ where: { id: p.ticketId }, select: { id: true, status: true, priority: true } });
  if (!t) return false;
  const at = p.at ?? new Date();
  const internal = rmaTicketTransition(p.step).internal;
  await db.supportMessage.create({
    data: { ticketId: t.id, fromStaff: p.fromStaff, authorId: p.authorId, body: p.body.slice(0, 5000), attachments: p.attachments ?? [], attachmentNames: p.attachmentNames ?? [], isInternalNote: internal },
  });
  const data = ticketUpdateForStep(p.step, t, { fromStaff: p.fromStaff, at });
  if (data) await db.supportTicket.update({ where: { id: t.id }, data });
  return true;
}

/**
 * Claim the resolution of a return: only from a resolvable status and only
 * while no refund was booked for it. Run it inside the money transaction
 * (order row locked) BEFORE the credit note and refund are created; false =
 * someone else resolved it a moment ago — create nothing.
 */
export async function claimRmaResolution(
  db: { refund: Pick<Delegates['refund'], 'count'>; returnRequest: Pick<Delegates['returnRequest'], 'updateMany'> },
  p: { returnId: string; from: readonly ReturnStatus[]; outcome: string; note: string; actorId: string | null; at?: Date },
): Promise<boolean> {
  if ((await db.refund.count({ where: { returnId: p.returnId } })) > 0) return false;
  const claim = await db.returnRequest.updateMany({
    where: { id: p.returnId, status: { in: [...p.from] } },
    data: { status: 'RESOLVED', outcome: p.outcome, resolvedAt: p.at ?? new Date(), resolvedById: p.actorId, resolutionNote: p.note },
  });
  return claim.count === 1;
}
