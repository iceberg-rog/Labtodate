import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { isDeliverableEmail, sendEmail, sendInternalEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { notifyAdmins, notifyUser, audit } from '@/lib/observability';
import { runPaymentDueSweep } from '@/lib/orders/due-sweep';
import { QUOTE_REF } from '@/lib/quotes/offer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SLA sweep — finds tickets that have crossed their `dueAt` and haven't yet
 * been flagged (`slaBreachAt` is null). For each: stamps `slaBreachAt`,
 * notifies the assignee (or all admins if unassigned), and audits.
 *
 * Idempotent: setting `slaBreachAt` makes the row no longer match the WHERE
 * clause on subsequent sweeps, so each ticket only fires once per breach
 * cycle. If priority/dueAt is later changed by an operator, `slaBreachAt` is
 * reset by setTicketPriority — that's the only way to retrigger.
 *
 * Auth: header `X-Cron-Secret` must match env CRON_SECRET. Without this
 * the route is unreachable.
 */
export async function POST(req: NextRequest) {
  const headerSecret = req.headers.get('x-cron-secret');
  const envSecret = process.env.CRON_SECRET;
  if (!envSecret || headerSecret !== envSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const now = new Date();

  // ─── Support tickets sweep ────────────────────────────────────────────
  const overdueTickets = await prisma.supportTicket.findMany({
    where: {
      archivedAt: null,
      slaBreachAt: null,
      dueAt: { lt: now },
      status: { in: ['OPEN', 'WAITING_ON_SUPPORT'] },
    },
    select: {
      id: true, ref: true, subject: true, email: true, priority: true, dueAt: true,
      assignedToId: true, assignedTo: { select: { id: true, email: true } },
    },
    take: 100,
  });

  let ticketsNotified = 0;
  for (const t of overdueTickets) {
    // BUG-042 - atomic breach claim. This route runs on both POST and GET
    // (a sidecar wget triggers GET -> POST), and a slow sweep can still be
    // running when the next scheduled tick fires. Two overlapping invocations
    // both findMany the same slaBreachAt=null ticket, so a plain
    // update({where:{id}}) + unconditional notify would double-notify,
    // double-email and double-audit a single breach. Mirror the proforma/orphan
    // sweeps below: claim the breach atomically (updateMany guarded on
    // slaBreachAt=null) and only fire side effects when this invocation won.
    const claim = await prisma.supportTicket.updateMany({
      where: { id: t.id, slaBreachAt: null },
      data: { slaBreachAt: now },
    });
    if (claim.count !== 1) continue; // another sweep already flagged this one
    const overdueMinutes = Math.max(1, Math.round((now.getTime() - (t.dueAt?.getTime() ?? now.getTime())) / 60_000));
    const title = `SLA breached · ${t.ref}`;
    const body = `${t.priority}: "${t.subject}" — overdue by ${overdueMinutes}m`;
    const href = `/admin/tickets/${t.id}`;
    if (t.assignedToId) {
      await notifyUser(t.assignedToId, title, body, href);
      if (t.assignedTo?.email) {
        await sendEmail({
          to: t.assignedTo.email,
          subject: `[SLA] ${t.ref} — overdue ${overdueMinutes}m`,
          html: `<p><strong>${escapeHtml(t.priority)}</strong> ticket <code>${t.ref}</code> has breached its SLA.</p>
                 <p>${escapeHtml(t.subject)}</p>
                 <p><a href="${process.env.BETTER_AUTH_URL ?? ''}${href}">Open in admin</a></p>`,
        }).catch(() => null);
      }
    } else {
      await notifyAdmins(title, body, href, 'SYSTEM');
    }
    await audit('ticket.sla.breach', t.ref, `priority=${t.priority} overdue=${overdueMinutes}m assignee=${t.assignedTo?.email ?? 'unassigned'}`);
    ticketsNotified++;
  }

  // ─── Quote requests sweep (mirror of the ticket flow) ────────────────
  // Only requests waiting on lab2date: a new request, or one the buyer wrote
  // last, with no order behind it (an open offer / accepted deal waits on the buyer).
  const overdueQuotes = await prisma.sourcingRequest.findMany({
    where: {
      archivedAt: null,
      slaBreachAt: null,
      dueAt: { lt: now },
      status: { in: ['PENDING', 'RESPONDED'] },
      OR: [{ status: 'PENDING' }, { lastReplyByStaff: false }],
      order: { is: null },
    },
    select: {
      id: true, proformaNumber: true, buyerName: true, buyerEmail: true,
      productCategory: true, priority: true, dueAt: true,
      assignedToId: true, assignedTo: { select: { id: true, email: true } },
      product: { select: { title: true } },
    },
    take: 100,
  });

  let quotesNotified = 0;
  for (const q of overdueQuotes) {
    // BUG-042 - atomic breach claim (see ticket sweep above). Guards against
    // overlapping sweeps double-notifying/double-emailing a single quote breach.
    const claim = await prisma.sourcingRequest.updateMany({
      where: { id: q.id, slaBreachAt: null },
      data: { slaBreachAt: now },
    });
    if (claim.count !== 1) continue; // another sweep already flagged this one
    const overdueMinutes = Math.max(1, Math.round((now.getTime() - (q.dueAt?.getTime() ?? now.getTime())) / 60_000));
    const ref = q.proformaNumber ?? QUOTE_REF(q.id);
    const subject = q.product?.title ?? q.productCategory ?? `from ${q.buyerName}`;
    const title = `SLA breached · ${ref}`;
    const body = `${q.priority}: "${subject}" — overdue by ${overdueMinutes}m`;
    const href = `/admin/quotes/${q.id}`;
    if (q.assignedToId) {
      await notifyUser(q.assignedToId, title, body, href);
      // Imported sellers have placeholder addresses; send those to the intake inbox.
      const slaTo = isDeliverableEmail(q.assignedTo?.email) ? q.assignedTo?.email : process.env.QUOTE_INTAKE_EMAIL;
      if (slaTo) {
        await sendInternalEmail({
          to: slaTo,
          subject: `[SLA] Quote ${ref} — overdue ${overdueMinutes}m`,
          html: `<p><strong>${escapeHtml(q.priority)}</strong> quote <code>${ref}</code> has breached its SLA.</p>
                 <p>${escapeHtml(subject)}</p>
                 <p><a href="${process.env.BETTER_AUTH_URL ?? ''}${href}">Open in admin</a></p>`,
        }, 'sla:quote');
      }
    } else {
      await notifyAdmins(title, body, href, 'SYSTEM');
    }
    await audit('quote.sla.breach', ref, `priority=${q.priority} overdue=${overdueMinutes}m assignee=${q.assignedTo?.email ?? 'unassigned'}`);
    quotesNotified++;
  }

  // ─── Payment due dates, reminders, auto-cancel, offer expiry (A25) ────
  // One rule for quote and checkout orders (lib/orders/due-sweep.ts): the
  // due date printed on the proforma; reminders before it; cancellation only
  // after due date + grace (AUTO_CANCEL_UNPAID), always emailed; a receipt in
  // review, an invoice-terms request or ANY hold stops it (pre-payment holds —
  // shipping / VAT / compliance / address — are staff's turn, not the buyer's,
  // and a payment review means money arrived). An order that was on hold
  // counts its payment term from when it became payable (Order.payableSince).
  const due = await runPaymentDueSweep(now);

  const swept = overdueTickets.length + overdueQuotes.length + due.canceled + due.paymentReminders + due.overdueNotices + due.offerReminders;
  return NextResponse.json({
    swept,
    sweptAt: now.toISOString(),
    tickets: { swept: overdueTickets.length, notified: ticketsNotified },
    quotes: { swept: overdueQuotes.length, notified: quotesNotified },
    payments: due,
  });
}

// GET also supported for ease of triggering from a sidecar's wget.
export async function GET(req: NextRequest) {
  return POST(req);
}
