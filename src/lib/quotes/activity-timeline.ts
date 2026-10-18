import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { siteName } from '@/lib/brand/identity';
import { businessTimeZone } from '@/lib/documents/numbering';
import { offerAmounts } from './pricing';

/**
 * The lifecycle of an RFQ as discrete events (admin quote page), from:
 *   - the request itself (submitted, assignee, SLA breach, how it ended)
 *   - its messages: one event per offer revision with the amount the buyer
 *     saw, the acceptance, the decline, replies labelled by who wrote them
 *   - the linked order: created, payment due (until paid), receipt, payment
 *     received, shipped, delivered
 *
 * `timelineEvents` is pure (unit tests: activity-timeline.test.ts);
 * `buildActivityTimeline` loads the rows.
 */
export type TimelineEvent = {
  at: Date;
  kind:
    | 'submitted'
    | 'assigned'
    | 'staff_reply'
    | 'supplier_reply'
    | 'buyer_reply'
    | 'internal_note'
    | 'offer_sent'
    | 'offer_valid_until'
    | 'proforma_sent'
    | 'sla_breached'
    | 'accepted'
    | 'declined'
    | 'closed'
    | 'order_created'
    | 'payment_due'
    | 'payment_submitted'
    | 'order_paid'
    | 'order_shipped'
    | 'order_delivered'
    | 'order_canceled'
    | 'magic_link_reissued';
  title: string;
  detail?: string;
};

export interface TimelineInput {
  brand: string;
  /** Business time zone for the dates written into titles (Europe/Amsterdam). */
  timeZone: string;
  now?: Date;
  sr: {
    createdAt: Date;
    updatedAt: Date;
    buyerName: string;
    status: string;
    quotedAt: Date | null;
    quotedPriceCents: number | null;
    quotedCurrency: string | null;
    offerRevision: number;
    offerSubtotalCents?: number | null;
    offerShippingCents?: number | null;
    offerVatTreatment?: string | null;
    offerVatRateBp?: number | null;
    offerVatCents?: number | null;
    offerTotalCents?: number | null;
    validUntilAt: Date | null;
    proformaNumber: string | null;
    proformaIssuedAt: Date | null;
    slaBreachAt: Date | null;
    lostReason: string | null;
    assignedTo: { name: string | null; email: string } | null;
  };
  messages: Array<{
    createdAt: Date;
    fromStaff: boolean;
    isInternalNote: boolean;
    body: string;
    author: { name: string | null; email: string; role: string } | null;
  }>;
  order: {
    orderNumber: string;
    createdAt: Date;
    status: string;
    dueAt: Date | null;
    paidAt: Date | null;
    paymentSubmittedAt: Date | null;
    paymentVerifiedAt: Date | null;
    shippedAt: Date | null;
    deliveredAt: Date | null;
    trackingCarrier: string | null;
    trackingNumber: string | null;
  } | null;
}

// ── Reading the offer messages ───────────────────────────────────────────────

/** A formatted amount ("€9,000", "CHF 1,250.50") split into its number and the text around it. */
function parseMoneyText(s: string): { prefix: string; cents: number; suffix: string } | null {
  const m = /^(\D*?)(\d[\d,]*)(?:\.(\d{1,2}))?(\D*)$/.exec(s.trim());
  if (!m) return null;
  const whole = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(whole)) return null;
  return { prefix: m[1], cents: whole * 100 + Number((m[3] ?? '0').padEnd(2, '0')), suffix: m[4] };
}

/** The same notation as formatPrice (whole amounts without cents). */
function moneyText(prefix: string, cents: number, suffix: string): string {
  const digits = cents % 100 === 0 ? 0 : 2;
  const n = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
  return `${prefix}${n}${suffix}`;
}

/**
 * The amount the buyer saw in an offer message ("Offer (revision 2) for …"):
 * the total incl. VAT when the VAT was decided at sending, else goods plus
 * freight "excl. VAT". Null when the text is not an offer message; `amount`
 * null when it can not be read.
 */
export function offerMessageAmount(body: string): { revision: number; update: boolean; amount: string | null } | null {
  const first = body.split('\n')[0] ?? '';
  const head = /^(Updated offer|Offer) \(revision (\d+)\)/.exec(first);
  if (!head) return null;
  const out = { revision: Number(head[2]), update: head[1] === 'Updated offer', amount: null as string | null };
  const total = /; total (.+?)\. Valid until\b/.exec(first);
  if (total) return { ...out, amount: total[1] };
  const excl = first.indexOf(' excl. VAT');
  const quoteEnd = excl < 0 ? -1 : first.lastIndexOf('": ', excl);
  if (quoteEnd < 0) return out;
  const [goodsText, freightText] = first.slice(quoteEnd + 3, excl).replace(/^\d+ × .+? = /, '').split(' + freight ');
  const goods = parseMoneyText(goodsText ?? '');
  const freight = freightText ? parseMoneyText(freightText) : null;
  if (!goods || (freightText && !freight)) return out;
  return { ...out, amount: `${moneyText(goods.prefix, goods.cents + (freight?.cents ?? 0), goods.suffix)} excl. VAT` };
}

/** "Offer accepted (revision 2): €11,374 incl. VAT 21% for …" → revision and amount. */
export function acceptedMessageAmount(body: string): { revision: number; amount: string } | null {
  const m = /^Offer accepted \(revision (\d+)\): (.+?) incl\. /.exec(body);
  return m ? { revision: Number(m[1]), amount: m[2] } : null;
}

const ORDER_CANCELED = /^Order (\S+) was canceled\b/;

// ── Events ───────────────────────────────────────────────────────────────────

export function timelineEvents(i: TimelineInput): TimelineEvent[] {
  const { sr, order, brand } = i;
  const now = i.now ?? new Date();
  const day = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: i.timeZone });
  const ev: TimelineEvent[] = [];
  ev.push({ at: sr.createdAt, kind: 'submitted', title: `Request submitted by ${sr.buyerName}` });
  if (sr.assignedTo) {
    // The assignment time is not stored; the current assignee is shown at the start.
    ev.push({ at: sr.createdAt, kind: 'assigned', title: `Assigned to ${sr.assignedTo.name ?? sr.assignedTo.email}` });
  }

  // The current revision's amount comes from its stored snapshot (exact).
  const current = sr.quotedPriceCents != null ? offerAmounts(sr) : null;
  const currentAmount = current ? `${formatPrice(current.totalCents, sr.quotedCurrency || 'EUR')}${current.vatDecided ? '' : ' excl. VAT'}` : null;
  let offersSeen = 0;
  let acceptedSeen = false;
  let declinedSeen = false;

  for (const m of i.messages) {
    const who = m.author?.name ?? m.author?.email ?? null;
    const detail = m.body.slice(0, 140);
    if (m.isInternalNote) {
      ev.push({ at: m.createdAt, kind: 'internal_note', title: `Internal note by ${who ?? 'staff'}`, detail });
      continue;
    }
    const offer = offerMessageAmount(m.body);
    if (offer) {
      offersSeen++;
      const amount = offer.revision === sr.offerRevision && currentAmount ? currentAmount : offer.amount;
      ev.push({
        at: m.createdAt,
        kind: 'offer_sent',
        title: `${offer.update ? 'Offer updated' : 'Offer sent'} · revision ${offer.revision}${amount ? `: ${amount}` : ''}`,
      });
      continue;
    }
    const accepted = acceptedMessageAmount(m.body);
    if (accepted) {
      acceptedSeen = true;
      ev.push({ at: m.createdAt, kind: 'accepted', title: `Buyer accepted revision ${accepted.revision}: ${accepted.amount} incl. VAT`, detail });
      continue;
    }
    if (!m.fromStaff && /^Offer declined\b/.test(m.body)) {
      declinedSeen = true;
      ev.push({ at: m.createdAt, kind: 'declined', title: 'Buyer declined the offer', detail: m.body.replace(/^Offer declined\s*(—\s*)?/, '').slice(0, 140) || undefined });
      continue;
    }
    const canceled = ORDER_CANCELED.exec(m.body);
    if (canceled) {
      ev.push({ at: m.createdAt, kind: 'order_canceled', title: `Order ${canceled[1]} canceled`, detail });
      continue;
    }
    if (m.fromStaff) {
      const supplier = m.author?.role === 'SELLER';
      ev.push({
        at: m.createdAt,
        kind: supplier ? 'supplier_reply' : 'staff_reply',
        title: `${supplier ? 'Supplier' : brand} replied${who ? ` (${who})` : ''}`,
        detail,
      });
    } else {
      ev.push({ at: m.createdAt, kind: 'buyer_reply', title: 'Buyer replied', detail });
    }
  }

  // An offer older than the revision messages (legacy): one event from the snapshot.
  if (!offersSeen && sr.quotedAt && currentAmount) {
    ev.push({ at: sr.quotedAt, kind: 'offer_sent', title: `Offer sent${sr.offerRevision > 0 ? ` · revision ${sr.offerRevision}` : ''}: ${currentAmount}` });
  }
  if (sr.proformaIssuedAt && !acceptedSeen) {
    ev.push({ at: sr.proformaIssuedAt, kind: 'proforma_sent', title: sr.proformaNumber ? `Proforma ${sr.proformaNumber} issued` : 'Proforma issued' });
  }
  // The open offer's validity — never a payment date (that is the order's dueAt).
  if (sr.status === 'RESPONDED' && sr.validUntilAt && sr.quotedPriceCents != null && (!order || order.status === 'CANCELED')) {
    ev.push({ at: sr.validUntilAt, kind: 'offer_valid_until', title: `${sr.validUntilAt < now ? 'Offer expired on' : 'Offer valid until'} ${day(sr.validUntilAt)}` });
  }
  if (sr.slaBreachAt) ev.push({ at: sr.slaBreachAt, kind: 'sla_breached', title: 'Reply time (SLA) exceeded' });
  if (sr.status === 'ACCEPTED' && !acceptedSeen) {
    ev.push({ at: order?.createdAt ?? sr.updatedAt, kind: 'accepted', title: 'Buyer accepted the offer' });
  } else if (sr.status === 'DECLINED' && !declinedSeen) {
    ev.push({ at: sr.updatedAt, kind: 'declined', title: 'Buyer declined the offer', detail: sr.lostReason ?? undefined });
  } else if (sr.status === 'CLOSED') {
    ev.push({ at: sr.updatedAt, kind: 'closed', title: 'Request closed without a deal', detail: sr.lostReason ?? undefined });
  }

  if (order) {
    ev.push({ at: order.createdAt, kind: 'order_created', title: `Order ${order.orderNumber} created` });
    if (order.paymentSubmittedAt) ev.push({ at: order.paymentSubmittedAt, kind: 'payment_submitted', title: 'Payment receipt uploaded' });
    // Dated when it was booked: paidAt is the bank's value date (noon), which can lie before the acceptance.
    const paidEventAt = order.paymentVerifiedAt ?? order.paidAt;
    if (paidEventAt) {
      ev.push({
        at: paidEventAt,
        kind: 'order_paid',
        title: `Payment received · order ${order.orderNumber}`,
        detail: order.paidAt && order.paymentVerifiedAt && day(order.paidAt) !== day(order.paymentVerifiedAt) ? `Value date ${day(order.paidAt)}` : undefined,
      });
    }
    if (order.shippedAt) {
      ev.push({
        at: order.shippedAt,
        kind: 'order_shipped',
        title: 'Shipped',
        detail: [order.trackingCarrier, order.trackingNumber].filter(Boolean).join(' · ') || undefined,
      });
    }
    if (order.deliveredAt) ev.push({ at: order.deliveredAt, kind: 'order_delivered', title: 'Delivered' });
    // What is still due (dropped once paid or canceled).
    if (order.status === 'PENDING_PAYMENT' && order.dueAt && !order.paidAt) {
      ev.push({ at: order.dueAt, kind: 'payment_due', title: `Payment due ${day(order.dueAt)}` });
    }
  }

  // Stable: events at the same moment keep the order they were added in.
  return ev
    .map((e, n) => ({ e, n }))
    .sort((a, b) => a.e.at.getTime() - b.e.at.getTime() || a.n - b.n)
    .map((x) => x.e);
}

export async function buildActivityTimeline(quoteId: string): Promise<TimelineEvent[]> {
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: quoteId },
    select: {
      createdAt: true,
      updatedAt: true,
      buyerName: true,
      status: true,
      proformaNumber: true,
      proformaIssuedAt: true,
      validUntilAt: true,
      quotedAt: true,
      quotedPriceCents: true,
      quotedCurrency: true,
      offerRevision: true,
      offerSubtotalCents: true,
      offerShippingCents: true,
      offerVatTreatment: true,
      offerVatRateBp: true,
      offerVatCents: true,
      offerTotalCents: true,
      slaBreachAt: true,
      lostReason: true,
      assignedTo: { select: { name: true, email: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, fromStaff: true, isInternalNote: true, body: true, author: { select: { name: true, email: true, role: true } } },
      },
      order: {
        select: {
          orderNumber: true, createdAt: true, status: true, dueAt: true, paidAt: true, paymentSubmittedAt: true,
          paymentVerifiedAt: true, shippedAt: true, deliveredAt: true, trackingCarrier: true, trackingNumber: true,
        },
      },
    },
  });
  if (!sr) return [];
  const { messages, order, ...rest } = sr;
  return timelineEvents({ brand: siteName(), timeZone: businessTimeZone(), sr: rest, messages, order });
}
