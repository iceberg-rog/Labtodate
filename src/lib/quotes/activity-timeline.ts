import { prisma } from '@/lib/db';

/**
 * Synthesize the lifecycle of an RFQ as discrete events. Pulled from:
 *   - SourcingRequest base fields (created, accessTokenIssuedAt, proformaIssuedAt, validUntilAt, slaBreachAt)
 *   - QuoteMessage rows (each reply is an event)
 *   - linked Order (PENDING_PAYMENT → PAID)
 *
 * Replaces the dead "No replies yet." empty state with something honest +
 * useful: "Submitted by buyer / Assigned to seller / Awaiting first reply".
 */
export type TimelineEvent = {
  at: Date;
  kind:
    | 'submitted'
    | 'assigned'
    | 'staff_reply'
    | 'buyer_reply'
    | 'internal_note'
    | 'proforma_sent'
    | 'proforma_valid_until'
    | 'sla_breached'
    | 'accepted'
    | 'declined'
    | 'closed'
    | 'order_created'
    | 'order_paid'
    | 'magic_link_reissued';
  title: string;
  detail?: string;
};

export async function buildActivityTimeline(quoteId: string): Promise<TimelineEvent[]> {
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: quoteId },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      buyerName: true,
      status: true,
      assignedToId: true,
      proformaNumber: true,
      proformaIssuedAt: true,
      validUntilAt: true,
      slaBreachAt: true,
      accessTokenIssuedAt: true,
      assignedTo: { select: { name: true, email: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, fromStaff: true, isInternalNote: true, body: true, author: { select: { name: true, email: true } } },
      },
    },
  });
  if (!sr) return [];

  const ev: TimelineEvent[] = [];
  ev.push({
    at: sr.createdAt,
    kind: 'submitted',
    title: `Submitted by ${sr.buyerName}`,
  });
  if (sr.assignedToId && sr.assignedTo) {
    // We don't track assignment time separately; assume same as createdAt
    // when assignedToId was set at submission. For later transfers, the
    // audit log would supply a timestamp — best-effort here.
    ev.push({
      at: sr.createdAt,
      kind: 'assigned',
      title: `Assigned to ${sr.assignedTo.name ?? sr.assignedTo.email}`,
    });
  }

  for (const m of sr.messages) {
    if (m.isInternalNote) {
      ev.push({
        at: m.createdAt,
        kind: 'internal_note',
        title: `Internal note by ${m.author?.name ?? m.author?.email ?? 'staff'}`,
        detail: m.body.slice(0, 140),
      });
    } else if (m.fromStaff) {
      ev.push({
        at: m.createdAt,
        kind: 'staff_reply',
        title: `Staff replied (${m.author?.name ?? m.author?.email ?? 'support'})`,
        detail: m.body.slice(0, 140),
      });
    } else {
      ev.push({
        at: m.createdAt,
        kind: 'buyer_reply',
        title: `Buyer replied`,
        detail: m.body.slice(0, 140),
      });
    }
  }

  if (sr.proformaIssuedAt) {
    ev.push({
      at: sr.proformaIssuedAt,
      kind: 'proforma_sent',
      title: `Proforma ${sr.proformaNumber ?? ''} issued`.trim(),
    });
  }
  if (sr.validUntilAt && sr.proformaIssuedAt) {
    ev.push({
      at: sr.validUntilAt,
      kind: 'proforma_valid_until',
      title: `Proforma valid until`,
    });
  }
  if (sr.slaBreachAt) {
    ev.push({ at: sr.slaBreachAt, kind: 'sla_breached', title: 'SLA breached' });
  }
  if (sr.status === 'ACCEPTED') {
    ev.push({ at: sr.updatedAt, kind: 'accepted', title: 'Buyer accepted the quote' });
  } else if (sr.status === 'DECLINED') {
    ev.push({ at: sr.updatedAt, kind: 'declined', title: 'Buyer declined the quote' });
  } else if (sr.status === 'CLOSED') {
    ev.push({ at: sr.updatedAt, kind: 'closed', title: 'Quote closed' });
  }

  // Linked order milestones
  const order = await prisma.order.findUnique({
    where: { sourcingRequestId: quoteId },
    select: { orderNumber: true, createdAt: true, paidAt: true, status: true, totalCents: true, currency: true },
  });
  if (order) {
    ev.push({ at: order.createdAt, kind: 'order_created', title: `Order ${order.orderNumber} created` });
    if (order.paidAt) {
      ev.push({ at: order.paidAt, kind: 'order_paid', title: `Order ${order.orderNumber} paid` });
    }
  }

  // Sort all events by time
  ev.sort((a, b) => a.at.getTime() - b.at.getTime());
  return ev;
}
