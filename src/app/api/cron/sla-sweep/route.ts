import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { notifyAdmins, notifyUser, audit } from '@/lib/observability';

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
    await prisma.supportTicket.update({ where: { id: t.id }, data: { slaBreachAt: now } });
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
          html: `<p><strong>${t.priority}</strong> ticket <code>${t.ref}</code> has breached its SLA.</p>
                 <p>${t.subject}</p>
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
  const overdueQuotes = await prisma.sourcingRequest.findMany({
    where: {
      archivedAt: null,
      slaBreachAt: null,
      dueAt: { lt: now },
      status: { in: ['PENDING', 'RESPONDED'] },
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
    await prisma.sourcingRequest.update({ where: { id: q.id }, data: { slaBreachAt: now } });
    const overdueMinutes = Math.max(1, Math.round((now.getTime() - (q.dueAt?.getTime() ?? now.getTime())) / 60_000));
    const ref = q.proformaNumber ?? `RFQ-${q.id.slice(-6).toUpperCase()}`;
    const subject = q.product?.title ?? q.productCategory ?? `from ${q.buyerName}`;
    const title = `SLA breached · ${ref}`;
    const body = `${q.priority}: "${subject}" — overdue by ${overdueMinutes}m`;
    const href = `/admin/quotes/${q.id}`;
    if (q.assignedToId) {
      await notifyUser(q.assignedToId, title, body, href);
      if (q.assignedTo?.email) {
        await sendEmail({
          to: q.assignedTo.email,
          subject: `[SLA] Quote ${ref} — overdue ${overdueMinutes}m`,
          html: `<p><strong>${q.priority}</strong> quote <code>${ref}</code> has breached its SLA.</p>
                 <p>${subject}</p>
                 <p><a href="${process.env.BETTER_AUTH_URL ?? ''}${href}">Open in admin</a></p>`,
        }).catch(() => null);
      }
    } else {
      await notifyAdmins(title, body, href, 'SYSTEM');
    }
    await audit('quote.sla.breach', ref, `priority=${q.priority} overdue=${overdueMinutes}m assignee=${q.assignedTo?.email ?? 'unassigned'}`);
    quotesNotified++;
  }

  // ─── Proforma expiry sweep ───────────────────────────────────────────
  // Finds proformas whose validUntilAt has passed while the buyer never
  // moved on the deal. Closes the request (→ Lost) and cancels the linked
  // PENDING_PAYMENT order so the buyer's payment workspace blocks further
  // upload attempts. Idempotent: status=CLOSED falls out of the WHERE.
  const expiredProformas = await prisma.sourcingRequest.findMany({
    where: {
      archivedAt: null,
      proformaNumber: { not: null },
      validUntilAt: { lt: now },
      // Only deals still in negotiation. Accepted/declined/closed are terminal.
      status: 'RESPONDED',
    },
    select: {
      id: true, proformaNumber: true, buyerEmail: true, buyerName: true,
      submittedById: true, validUntilAt: true,
      product: { select: { title: true } },
      productCategory: true,
    },
    take: 100,
  });

  let proformasExpired = 0;
  for (const q of expiredProformas) {
    const ref = q.proformaNumber!;
    const item = q.product?.title ?? q.productCategory ?? 'requested equipment';
    // Close the request and cancel the linked order in one transaction so
    // an admin opening either side sees consistent state.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.sourcingRequest.update({
          where: { id: q.id },
          data: { status: 'CLOSED' },
        });
        await tx.order.updateMany({
          where: {
            sourcingRequestId: q.id,
            status: 'PENDING_PAYMENT',
          },
          data: { status: 'CANCELED' },
        });
      });
    } catch {
      continue;
    }

    if (q.submittedById) {
      await notifyUser(
        q.submittedById,
        `Proforma expired — ${ref}`,
        `Your proforma for "${item}" expired on ${q.validUntilAt?.toISOString().slice(0, 10)}. If you still want this, reply to your quote and we'll re-issue.`,
        `/app/quotes/${q.id}`,
      ).catch(() => null);
    }
    if (q.buyerEmail) {
      await sendEmail({
        to: q.buyerEmail,
        subject: `[${ref}] Your proforma has expired`,
        html: `<p>Hi ${q.buyerName ?? 'there'},</p>
               <p>Your proforma <strong>${ref}</strong> for ${item} expired on ${q.validUntilAt?.toISOString().slice(0, 10)}.</p>
               <p>If you'd still like to proceed, just reply to your quote thread and we'll re-issue with up-to-date pricing.</p>
               <p><a href="${process.env.BETTER_AUTH_URL ?? ''}/app/quotes/${q.id}">Open your quote</a></p>`,
      }).catch(() => null);
    }
    await notifyAdmins(
      `Proforma expired · ${ref}`,
      `${item} — buyer never decided. Moved to Lost.`,
      `/admin/quotes/${q.id}`,
      'SYSTEM',
    ).catch(() => null);
    await audit('quote.proforma.expire', ref, `item="${item}" buyer=${q.buyerEmail}`);
    proformasExpired++;
  }

  // ─── Orphaned PENDING_PAYMENT order sweep (BUG-007) ──────────────────
  // Releases stock reserved by orders that were never paid and show no sign
  // of buyer payment activity. In manual-payment posture an order can
  // legitimately sit in PENDING_PAYMENT for days while the buyer arranges a
  // bank transfer, so the TTL is deliberately generous (default 7 days) and
  // we only touch orders with NO payment proof in flight, NO stripe session,
  // and NOT tied to a sourcing/proforma deal (the proforma sweep owns those).
  // Idempotent + race-safe: the cancel is an atomic updateMany guarded by
  // status=PENDING_PAYMENT AND paymentSubmittedAt=null, so a buyer who submits
  // proof between the select and the update wins and is never cancelled.
  const orphanTtlMin = Number(process.env.ORPHAN_ORDER_TTL_MINUTES ?? 10080); // 7d
  const orphanCutoff = new Date(now.getTime() - orphanTtlMin * 60_000);
  const orphanCandidates = await prisma.order.findMany({
    where: {
      status: 'PENDING_PAYMENT',
      createdAt: { lt: orphanCutoff },
      stripeSessionId: null,
      paymentSubmittedAt: null,
      paymentVerificationStatus: null,
      sourcingRequestId: null,
      archivedAt: null,
    },
    select: {
      id: true, orderNumber: true, buyerId: true,
      items: { select: { productId: true, quantity: true } },
    },
    take: 100,
  });

  let orphansCanceled = 0;
  for (const o of orphanCandidates) {
    let canceled = false;
    try {
      await prisma.$transaction(async (tx) => {
        const res = await tx.order.updateMany({
          where: { id: o.id, status: 'PENDING_PAYMENT', paymentSubmittedAt: null },
          data: { status: 'CANCELED' },
        });
        if (res.count !== 1) return; // lost the race — buyer acted; leave it
        canceled = true;
        // Return each reserved unit to stock exactly once.
        for (const it of o.items) {
          if (!it.productId) continue;
          await tx.product.update({
            where: { id: it.productId },
            data: { quantity: { increment: it.quantity } },
          });
        }
      });
    } catch {
      continue;
    }
    if (!canceled) continue;
    if (o.buyerId) {
      await notifyUser(
        o.buyerId,
        `Order ${o.orderNumber} canceled — no payment received`,
        `We released the items reserved for order ${o.orderNumber} because we didn't receive payment. You're welcome to order again.`,
        `/app/orders/${o.orderNumber}`,
      ).catch(() => null);
    }
    await notifyAdmins(
      `Orphan order canceled · ${o.orderNumber}`,
      `Stale PENDING_PAYMENT (> ${orphanTtlMin}m, no proof, no session). Reserved stock released.`,
      `/admin/orders/${o.id}`,
      'SYSTEM',
    ).catch(() => null);
    await audit('order.orphan.cancel', o.orderNumber, `ttlMin=${orphanTtlMin} items=${o.items.length}`);
    orphansCanceled++;
  }

  const swept = overdueTickets.length + overdueQuotes.length + proformasExpired + orphansCanceled;
  return NextResponse.json({
    swept,
    sweptAt: now.toISOString(),
    tickets: { swept: overdueTickets.length, notified: ticketsNotified },
    quotes: { swept: overdueQuotes.length, notified: quotesNotified },
    proformas: { expired: proformasExpired },
    orphanOrders: { canceled: orphansCanceled },
  });
}

// GET also supported for ease of triggering from a sidecar's wget.
export async function GET(req: NextRequest) {
  return POST(req);
}
