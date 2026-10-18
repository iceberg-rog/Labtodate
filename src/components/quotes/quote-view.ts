import { formatPrice } from '@/lib/utils';
import { heldMoneyCents } from '@/lib/finance/held';

/**
 * Pure view helpers shared by the quote screens (buyer, supplier and admin
 * pages): who wrote a message as each side may see it, what a supplier may
 * read of the offer messages, whether the quoted unit can still be accepted,
 * the money state of an accepted order and the admin queue's order. No I/O —
 * the pages load the data and pass the brand (siteName()).
 */

// ── Who wrote a message ──────────────────────────────────────────────────────

export type MessageAuthor = { id: string; role?: string | null; name?: string | null; email?: string | null } | null;

export type ThreadViewer =
  /** The buyer: every buyer-side message is theirs. */
  | { kind: 'BUYER'; userId: string; brand: string }
  /** The assigned supplier: the buyer stays anonymous. */
  | { kind: 'SELLER'; userId: string; brand: string }
  /** Staff: names, with the side they write for. */
  | { kind: 'STAFF'; userId: string; brand: string; buyerName: string };

/**
 * The author line of one quote message. A supplier's message (author role
 * SELLER) is "Supplier", every other message from our side (staff, system) is
 * the brand, the buyer's side is "Buyer" — buyers and suppliers never see a
 * person's name of the other side; staff see the name next to the side.
 */
export function messageAuthorLabel(m: { fromStaff: boolean; author: MessageAuthor }, v: ThreadViewer): string {
  if (m.author && m.author.id === v.userId) return 'You';
  const side = m.author?.role === 'SELLER' ? 'Supplier' : v.brand;
  if (v.kind === 'STAFF') {
    if (!m.fromStaff) return v.buyerName.trim() || 'Buyer';
    const who = m.author?.name?.trim() || m.author?.email || '';
    return who ? `${side} · ${who}` : side;
  }
  if (m.fromStaff) return side;
  return v.kind === 'BUYER' ? 'You' : 'Buyer';
}

// ── What a supplier may read ─────────────────────────────────────────────────

const OFFER_MESSAGE = /^(?:Updated offer|Offer) \(revision (\d+)\)/;
const ACCEPTED_MESSAGE = /^Offer accepted\b/;
const ORDER_CANCELED_MESSAGE = /^Order \S+ was canceled (by the buyer|automatically|by [^:]+?)(?: after payment)?:/;

/** An offer / acceptance message of the thread: it states the buyer price. */
export function isBuyerPriceMessage(body: string): boolean {
  return OFFER_MESSAGE.test(body) || ACCEPTED_MESSAGE.test(body);
}

/**
 * A message as the assigned supplier reads it. Without SELLER_SEES_SELL_PRICE
 * every offer and acceptance message is replaced, whoever wrote it — with
 * supplier review off the supplier's own direct offer carries the buyer price
 * (their price plus the margin). Order-cancel messages always are: they carry
 * the buyer's own words, document numbers and refund amounts.
 */
export function supplierSafeBody(body: string, o: { brand: string; showSellPrice: boolean }): string {
  if (!o.showSellPrice) {
    const offer = OFFER_MESSAGE.exec(body);
    if (offer) return `${o.brand} sent the buyer an offer (revision ${offer[1]}). Buyer prices are not shown to suppliers.`;
    if (ACCEPTED_MESSAGE.test(body)) return `The buyer accepted ${o.brand}’s offer. Buyer prices are not shown to suppliers.`;
  }
  const cancel = ORDER_CANCELED_MESSAGE.exec(body);
  if (cancel) {
    return cancel[1] === 'by the buyer'
      ? 'The buyer canceled the order.'
      : cancel[1] === 'automatically'
        ? 'The order was canceled automatically.'
        : `${o.brand} canceled the order.`;
  }
  return body;
}

/** What the close dialog says will happen (QUOTE_AUTO_ARCHIVE_ON_CLOSE decides Lost vs Archived). */
export function closeConfirmText(o: { autoArchive: boolean; hasOpenOffer: boolean }): string {
  return [
    o.hasOpenOffer ? 'The open offer is withdrawn and can no longer be accepted.' : '',
    'Any unpaid order of this request is canceled and a unit reserved for it goes back on sale.',
    'The buyer is e-mailed that the request was closed, with the reason and your note; the assigned supplier is told.',
    o.autoArchive
      ? 'The request then moves to Archived (Settings → Quotes & offers → archive on close).'
      : 'The request then moves to Lost.',
    'It can not be reopened — “New quote for this buyer” starts a new one.',
  ].filter(Boolean).join(' ');
}

// ── Offer validity ───────────────────────────────────────────────────────────

/** Today and the last day an offer may be valid (one year), as YYYY-MM-DD (UTC, as the server reads it). */
export function validUntilBounds(now: Date = new Date()): { min: string; max: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { min: day(now), max: day(new Date(now.getTime() + 365 * 86_400_000)) };
}

// ── The quoted unit ──────────────────────────────────────────────────────────

/**
 * The listed unit can no longer be accepted on this offer: the listing is gone,
 * or fewer units are in stock than offered and none is held for this quote
 * (another buyer's acceptance or order took it).
 */
export function unitUnavailable(av: { quantity: number; heldByThisQuote: boolean } | null, qty: number): boolean {
  if (!av) return true;
  return !av.heldByThisQuote && av.quantity < Math.max(1, qty);
}

// ── Money of an accepted order ───────────────────────────────────────────────

export type DealStage = 'UNPAID' | 'PART_PAID' | 'PROOF' | 'TERMS' | 'PAID' | 'SHIPPED' | 'CANCELED' | 'REFUNDED';

export interface OrderMoney {
  status: string;
  totalCents: number;
  currency: string;
  amountPaidCents: number;
  refunds: Array<{ status: string; amountCents: number }>;
  paymentSubmittedAt?: Date | string | null;
  shippedAt?: Date | string | null;
}

/** Money received and kept for the order (net of refunds owed or sent). */
export function receivedCents(o: Pick<OrderMoney, 'amountPaidCents' | 'refunds'>): number {
  return heldMoneyCents(o.amountPaidCents, o.refunds);
}

/** "€2,825 received, €200 open" — null when nothing (or everything) was received. */
export function partPaidLine(o: Pick<OrderMoney, 'totalCents' | 'currency' | 'amountPaidCents' | 'refunds'>): string | null {
  const got = receivedCents(o);
  if (got <= 0 || got >= o.totalCents) return null;
  return `${formatPrice(got, o.currency)} received, ${formatPrice(o.totalCents - got, o.currency)} open`;
}

/**
 * Where an accepted quote's order stands for the Deal panel. A receipt to
 * verify comes first; an unpaid order with money already received is
 * PART_PAID (it can no longer simply be canceled — that needs a refund).
 */
export function dealStageOf(o: OrderMoney, onTerms: boolean): DealStage {
  if (o.status === 'CANCELED') return 'CANCELED';
  if (o.status === 'REFUNDED') return 'REFUNDED';
  if (o.status === 'PENDING_PAYMENT') {
    if (o.paymentSubmittedAt) return 'PROOF';
    return receivedCents(o) > 0 ? 'PART_PAID' : 'UNPAID';
  }
  if (onTerms) return o.shippedAt ? 'SHIPPED' : 'TERMS';
  if (o.status === 'SHIPPED' || o.status === 'DELIVERED') return 'SHIPPED';
  return 'PAID';
}

// ── Admin queue ──────────────────────────────────────────────────────────────

export type QueueSort = 'urgency' | 'sla' | 'newest' | 'oldest';

export interface QueueSortRow {
  id: string;
  priority: string;
  status: string;
  dueAt: Date | null;
  createdAt: Date;
}

const PRIORITY_WEIGHT: Record<string, number> = { VIP: 0, URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
const STATUS_WEIGHT: Record<string, number> = { PENDING: 0, RESPONDED: 1, ACCEPTED: 2, DECLINED: 3, CLOSED: 4 };

/** The queue order: urgency (priority, status, reply due, newest), SLA (reply due first), newest or oldest. */
export function sortQueue<T extends QueueSortRow>(rows: T[], sort: QueueSort): T[] {
  const due = (r: QueueSortRow) => r.dueAt?.getTime() ?? Infinity;
  const out = [...rows];
  if (sort === 'urgency') {
    return out.sort((a, b) =>
      (PRIORITY_WEIGHT[a.priority] ?? 9) - (PRIORITY_WEIGHT[b.priority] ?? 9)
      || (STATUS_WEIGHT[a.status] ?? 9) - (STATUS_WEIGHT[b.status] ?? 9)
      || (due(a) === due(b) ? 0 : due(a) - due(b))
      || b.createdAt.getTime() - a.createdAt.getTime());
  }
  if (sort === 'sla') {
    return out.sort((a, b) => (due(a) === due(b) ? b.createdAt.getTime() - a.createdAt.getTime() : due(a) - due(b)));
  }
  return out.sort((a, b) => (sort === 'oldest' ? 1 : -1) * (a.createdAt.getTime() - b.createdAt.getTime()));
}

/** Page `requested` (1-based) of `total` rows, clamped to the pages that exist. */
export function queuePage(total: number, requested: number, perPage: number): { page: number; pages: number; skip: number } {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(pages, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 1));
  return { page, pages, skip: (page - 1) * perPage };
}

// ── Deal badge after dispatch ────────────────────────────────────────────────

/**
 * "Won · paid" says nothing once the unit left: name the shipped / delivered
 * state (staff and supplier views; the dates are on the page). A deal on
 * invoice terms keeps its "unpaid" label.
 */
export function withFulfilment<T extends { state: string; tone: string; label: string }>(
  badge: T,
  order: { status: string; shippedAt?: Date | string | null; deliveredAt?: Date | string | null } | null | undefined,
): T {
  if (!order || badge.state !== 'won_paid' || badge.tone !== 'emerald') return badge;
  if (order.deliveredAt || order.status === 'DELIVERED') return { ...badge, label: 'Won · delivered' };
  if (order.shippedAt || order.status === 'SHIPPED') return { ...badge, label: 'Won · shipped' };
  return badge;
}
