import { prisma } from '@/lib/db';
import { sendInternalEmail } from '@/lib/email';
import { escapeHtml, escapeHtmlLines, headerText } from '@/lib/email-html';
import { notifyAdmins, notifyUser } from '@/lib/observability';
import { siteName } from '@/lib/brand/identity';
import { withUniqueTicketRef } from '@/lib/support/actions';
import { computeDueAt } from '@/lib/support/statuses';
import { movedToTicketText, planTicketFromThread, PRODUCT_QUESTION_CATEGORY } from './house';

/**
 * Moves a house-stock MessageThread (see ./house.ts) into the support-ticket
 * queue: one ticket with the whole conversation, linked to the product, a
 * closing line in the old thread, and an audit row
 * `message.thread_to_ticket` (target = thread id, meta = {ticketId, ref})
 * that maps the thread to its ticket. Idempotent: a moved thread returns
 * its existing ticket. Used by sendMessage (a buyer writing in an old
 * thread) and by scripts/threads-to-tickets.ts. Call after
 * ensureSettingsLoaded().
 */

const MOVED_ACTION = 'message.thread_to_ticket';

export type MovedTicket = { ticketId: string; ref: string };

type MoveResult =
  | (MovedTicket & { created: false })
  | (MovedTicket & { created: true; buyerId: string; title: string; buyerName: string; buyerEmail: string; message: string | null });

function parseMoved(meta: string | null): MovedTicket | null {
  try {
    const v = JSON.parse(meta ?? '') as Partial<MovedTicket>;
    return typeof v.ticketId === 'string' && typeof v.ref === 'string' ? { ticketId: v.ticketId, ref: v.ref } : null;
  } catch {
    return null;
  }
}

/** The ticket a thread was moved to, or null. */
export async function threadTicket(threadId: string): Promise<MovedTicket | null> {
  const row = await prisma.auditLog.findFirst({
    where: { action: MOVED_ACTION, target: threadId },
    orderBy: { createdAt: 'desc' },
    select: { meta: true },
  });
  const moved = parseMoved(row?.meta ?? null);
  if (!moved) return null;
  const exists = await prisma.supportTicket.findUnique({ where: { id: moved.ticketId }, select: { id: true } });
  return exists ? moved : null;
}

export async function moveThreadToTicket(
  threadId: string,
  opts: {
    /** A buyer message that arrived in the old thread: it becomes the ticket's latest message. */
    buyerMessage?: string | null;
    actor?: { id?: string | null; email?: string | null };
    /** 'all': staff in-app + intake mail + the buyer; 'buyer': only the buyer's bell (one-off script). */
    notify?: 'all' | 'buyer';
  } = {},
): Promise<(MovedTicket & { created: boolean }) | null> {
  const already = await threadTicket(threadId);
  if (already) return { ...already, created: false };
  const site = siteName();
  const now = new Date();

  const result = await withUniqueTicketRef((ref) =>
    prisma.$transaction(async (tx): Promise<MoveResult | null> => {
      // One move per thread even when two messages race in.
      await tx.$queryRaw`SELECT "id" FROM "MessageThread" WHERE "id" = ${threadId} FOR UPDATE`;
      const raced = await tx.auditLog.findFirst({ where: { action: MOVED_ACTION, target: threadId }, select: { meta: true } });
      const racedTicket = parseMoved(raced?.meta ?? null);
      if (racedTicket) return { ...racedTicket, created: false };
      const thread = await tx.messageThread.findUnique({
        where: { id: threadId },
        select: {
          subject: true, buyerId: true, sellerId: true, productId: true,
          buyer: { select: { name: true, email: true } },
          product: { select: { title: true } },
          messages: { orderBy: { createdAt: 'asc' }, select: { authorId: true, body: true, createdAt: true } },
        },
      });
      if (!thread) return null;
      const plan = planTicketFromThread(thread, { now, buyerMessage: opts.buyerMessage });
      const ticket = await tx.supportTicket.create({
        data: {
          ref,
          name: plan.name,
          email: plan.email,
          subject: plan.subject,
          category: plan.category,
          submittedById: thread.buyerId,
          priority: 'NORMAL',
          dueAt: plan.status === 'WAITING_ON_SUPPORT' ? computeDueAt(now, 'NORMAL') : null,
          customerType: 'REGISTERED',
          productId: thread.productId,
          lastReplyAt: plan.lastReplyAt,
          lastReplyByStaff: plan.lastReplyByStaff,
          status: plan.status,
          messages: { create: plan.messages },
        },
        select: { id: true, ref: true },
      });
      await tx.message.create({ data: { threadId, authorId: thread.sellerId, body: movedToTicketText(ticket.ref, site) } });
      await tx.messageThread.update({ where: { id: threadId }, data: { lastMessageAt: now } });
      await tx.auditLog.create({
        data: {
          actorId: opts.actor?.id ?? null,
          actorEmail: opts.actor?.email ?? null,
          action: MOVED_ACTION,
          target: threadId,
          meta: JSON.stringify({ ticketId: ticket.id, ref: ticket.ref, messages: plan.messages.length }),
        },
      });
      const lastBuyer = [...plan.messages].reverse().find((m) => !m.fromStaff);
      return {
        ticketId: ticket.id, ref: ticket.ref, created: true,
        buyerId: thread.buyerId, title: thread.product?.title ?? plan.subject, buyerName: plan.name, buyerEmail: plan.email,
        message: lastBuyer?.body ?? null,
      };
    }),
  );
  if (!result) return null;
  if (result.created) {
    await notifyUser(
      result.buyerId,
      `Question ${result.ref}`,
      `Your conversation about “${result.title.slice(0, 120)}” continues under Support. We reply by email and there.`,
      `/app/support?sent=${encodeURIComponent(result.ref)}`,
    );
    if (opts.notify === 'all') {
      await notifyAdmins(`${PRODUCT_QUESTION_CATEGORY} ${result.ref}`, `${result.buyerName}: ${result.title.slice(0, 120)}`, `/admin/tickets/${result.ticketId}`, 'TICKET_NEW');
      const base = (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
      const ops = process.env.SUPPORT_INTAKE_EMAIL || process.env.SUPPORT_EMAIL || process.env.COMPANY_EMAIL || '';
      await sendInternalEmail({
        to: ops,
        subject: `${PRODUCT_QUESTION_CATEGORY} ${result.ref}: ${headerText(result.title, 140)}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:600px;">
<h2 style="color:#0E4F40;">${escapeHtml(PRODUCT_QUESTION_CATEGORY)}</h2>
<p>From <strong>${escapeHtml(result.buyerName)}</strong> &lt;${escapeHtml(result.buyerEmail)}&gt; about ${escapeHtml(result.title)} — moved from an inbox conversation, the earlier messages are in the ticket.</p>
${result.message ? `<blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${escapeHtmlLines(result.message)}</blockquote>` : ''}
<p><a href="${base}/admin/tickets/${result.ticketId}">Answer it in Admin → Tickets</a> · Ref ${escapeHtml(result.ref)} · ${escapeHtml(site)}</p>
</div>`,
      }, 'thread-to-ticket:intake');
    }
  }
  return { ticketId: result.ticketId, ref: result.ref, created: result.created };
}
