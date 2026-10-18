import type { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * A supplier's view of its sold units (D15 / D06): what we owe it for each one
 * — the agreed supplier price, never our sell price — and how far the sale
 * went (paid, shipped, delivered). Shared by the supplier payouts page, the
 * seller overview and the sale notices (src/lib/sellers/sale-notice.ts), so all
 * three agree on who the supplier is and what it is owed.
 *
 *  - Quote deal (Order.sourcingRequestId): the supplier is the assigned
 *    supplier, else the owner of the anchored listing; it is owed the supplier
 *    price recorded with the offer (offerSupplierCostCents, in its own
 *    currency) for the whole deal.
 *  - Listing sale (checkout): the supplier is the listing's owner; it is owed
 *    the listing price at the moment of sale (OrderItem.basePriceCents, the
 *    price before our margin) × quantity.
 * Only users with role SELLER are suppliers: listings of admins are our own
 * stock. Pure helpers first, then the one DB loader.
 */

export const SOLD_STATUSES: OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

export interface SupplierRef {
  id: string;
  role: string;
}

export interface SaleOrderInput {
  id: string;
  orderNumber: string;
  status: OrderStatus | string;
  currency: string;
  subtotalCents: number;
  paidAt: Date | null;
  createdAt: Date;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  sourcingRequest: {
    id: string;
    assignedTo: SupplierRef | null;
    product: { seller: SupplierRef | null } | null;
    offerSupplierCostCents: number | null;
    offerSupplierCostCurrency: string | null;
    sellerProposalCurrency: string | null;
    quotedCurrency: string | null;
  } | null;
  items: Array<{
    id: string;
    titleSnapshot: string;
    quantity: number;
    lineType: string;
    priceCentsSnapshot: number;
    basePriceCents: number | null;
    product: { seller: SupplierRef | null } | null;
  }>;
  shipments: Array<{
    shippedAt: Date | null;
    deliveredAt: Date | null;
    items: Array<{ orderItemId: string; qty: number }>;
  }>;
}

export interface SupplierSaleLine {
  /** Order item id, or `deal:<orderId>` for a quote deal. */
  key: string;
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  /** The quote of a quote deal, when it is in this supplier's inbox. */
  quoteId: string | null;
  title: string;
  quantity: number;
  /** What we pay the supplier for this line, excl. VAT; null when no supplier price was recorded. */
  supplierCents: number | null;
  supplierCurrency: string;
  /** Our goods price excl. VAT. Shown to suppliers only while SELLER_SEES_SELL_PRICE is on. */
  soldForCents: number;
  soldForCurrency: string;
  paidAt: Date | null;
  /** Set once every unit of the line has left (all its shipments shipped). */
  shippedAt: Date | null;
  /** Set once every unit of the line was delivered. */
  deliveredAt: Date | null;
}

const supplier = (u: SupplierRef | null | undefined): string | null => (u && u.role === 'SELLER' ? u.id : null);

/** Who supplies a quote deal: the assigned supplier, else the supplier who owns the anchored listing. */
export function quoteDealSupplierId(sr: { assignedTo: SupplierRef | null; product: { seller: SupplierRef | null } | null }): string | null {
  return supplier(sr.assignedTo) ?? supplier(sr.product?.seller);
}

/** Latest date of a set, or null when any is missing. */
function allDone(dates: Array<Date | null>): Date | null {
  if (!dates.length || dates.some((d) => !d)) return null;
  return new Date(Math.max(...dates.map((d) => (d as Date).getTime())));
}

/**
 * When the given order items were shipped / delivered in full. Orders shipped
 * before partial shipments existed have no Shipment rows: the order's own
 * dates count then.
 */
export function stageDates(order: Pick<SaleOrderInput, 'shipments' | 'shippedAt' | 'deliveredAt' | 'status'>, items: Array<{ id: string; quantity: number }>): { shippedAt: Date | null; deliveredAt: Date | null } {
  if (!order.shipments.length) {
    const shipped = order.status === 'SHIPPED' || order.status === 'DELIVERED';
    return {
      shippedAt: shipped ? order.shippedAt ?? order.deliveredAt ?? null : null,
      deliveredAt: order.status === 'DELIVERED' ? order.deliveredAt ?? order.shippedAt ?? null : null,
    };
  }
  const per = (pick: 'shippedAt' | 'deliveredAt') =>
    allDone(
      items.map((it) => {
        const carrying = order.shipments.filter((s) => s[pick] && s.items.some((si) => si.orderItemId === it.id));
        const qty = carrying.reduce((n, s) => n + s.items.filter((si) => si.orderItemId === it.id).reduce((m, si) => m + si.qty, 0), 0);
        return qty >= it.quantity ? allDone(carrying.map((s) => s[pick])) : null;
      }),
    );
  return { shippedAt: per('shippedAt'), deliveredAt: per('deliveredAt') };
}

/** Every supplier's lines of one order, keyed by the supplier's user id. */
export function supplierLinesOf(order: SaleOrderInput): Map<string, SupplierSaleLine[]> {
  const out = new Map<string, SupplierSaleLine[]>();
  const goods = order.items.filter((i) => i.lineType === 'GOODS');
  const base = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderStatus: String(order.status),
    paidAt: order.paidAt,
  };
  const sr = order.sourcingRequest;
  if (sr) {
    const id = quoteDealSupplierId(sr);
    if (!id || !goods.length) return out;
    out.set(id, [{
      ...base,
      key: `deal:${order.id}`,
      // Only the assigned supplier has the quote in its inbox.
      quoteId: supplier(sr.assignedTo) === id ? sr.id : null,
      title: goods[0].titleSnapshot,
      quantity: goods.reduce((n, i) => n + i.quantity, 0),
      supplierCents: sr.offerSupplierCostCents,
      supplierCurrency: sr.offerSupplierCostCurrency || sr.sellerProposalCurrency || sr.quotedCurrency || order.currency,
      soldForCents: goods.reduce((n, i) => n + i.priceCentsSnapshot * i.quantity, 0),
      soldForCurrency: order.currency,
      ...stageDates(order, goods),
    }]);
    return out;
  }
  for (const item of goods) {
    const id = supplier(item.product?.seller);
    if (!id) continue;
    const list = out.get(id) ?? [];
    list.push({
      ...base,
      key: item.id,
      quoteId: null,
      title: item.titleSnapshot,
      quantity: item.quantity,
      supplierCents: item.basePriceCents != null ? item.basePriceCents * item.quantity : null,
      supplierCurrency: order.currency,
      soldForCents: item.priceCentsSnapshot * item.quantity,
      soldForCurrency: order.currency,
      ...stageDates(order, [item]),
    });
    out.set(id, list);
  }
  return out;
}

/** Sum of the known supplier amounts, one entry per currency (never added across currencies). */
export function totalsByCurrency(lines: Array<Pick<SupplierSaleLine, 'supplierCents' | 'supplierCurrency'>>): Array<{ currency: string; cents: number }> {
  const m = new Map<string, number>();
  for (const l of lines) if (l.supplierCents != null) m.set(l.supplierCurrency, (m.get(l.supplierCurrency) ?? 0) + l.supplierCents);
  return [...m.entries()].map(([currency, cents]) => ({ currency, cents })).sort((a, b) => b.cents - a.cents);
}

/** Where a sale stands for the supplier. */
export function saleStage(line: Pick<SupplierSaleLine, 'orderStatus' | 'shippedAt' | 'deliveredAt'>): 'paid' | 'shipped' | 'delivered' | 'canceled' {
  if (line.orderStatus === 'CANCELED' || line.orderStatus === 'REFUNDED') return 'canceled';
  if (line.deliveredAt) return 'delivered';
  if (line.shippedAt) return 'shipped';
  return 'paid';
}

// ── sale notices (src/lib/sellers/sale-notice.ts) ───────────────────────────

export type SaleNoticeEvent = 'PAID' | 'SHIPPED' | 'DELIVERED' | 'CANCELED';

/**
 * Whether a supplier's notice for `event` is due now. PAID waits while the
 * unit is short (STOCK_SHORTAGE: staff decide first and call again once the
 * unit is secured); SHIPPED / DELIVERED wait until every unit of this supplier
 * has shipped / arrived (partial shipments); CANCELED only before anything of
 * it left (a return after delivery is not a cancellation).
 */
export function saleNoticeApplies(
  event: SaleNoticeEvent,
  order: { status: string; openHolds: readonly string[] },
  lines: Array<Pick<SupplierSaleLine, 'shippedAt' | 'deliveredAt'>>,
): boolean {
  if (!lines.length) return false;
  const canceled = order.status === 'CANCELED' || order.status === 'REFUNDED';
  switch (event) {
    case 'PAID':
      return (SOLD_STATUSES as string[]).includes(order.status) && !order.openHolds.includes('STOCK_SHORTAGE');
    case 'SHIPPED':
      return !canceled && lines.every((l) => l.shippedAt);
    case 'DELIVERED':
      return !canceled && lines.every((l) => l.deliveredAt);
    case 'CANCELED':
      return canceled && lines.every((l) => !l.shippedAt);
  }
}

export interface SaleNoticeContent {
  /** In-app notification title / body (≤ 140 / 500 characters). */
  title: string;
  body: string;
  subject: string;
  heading: string;
  /** Plain-text sentences; the caller escapes them for HTML. */
  lead: string;
  rows: Array<[string, string, boolean?]>;
  next: string | null;
}

const day = (d: Date | null) => (d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');

/**
 * What the supplier is told. Only the supplier's own lines and its agreed
 * supplier price (never our sell price, never who the buyer is); a line
 * without a recorded supplier price shows no amount rather than a guess.
 */
export function saleNoticeContent(
  event: SaleNoticeEvent,
  orderNumber: string,
  lines: SupplierSaleLine[],
  opts: { dispatchText: string },
): SaleNoticeContent {
  const one = lines.length === 1 ? lines[0] : null;
  const what = one ? `“${one.title}”${one.quantity > 1 ? ` (${one.quantity} units)` : ''}` : `${lines.length} items`;
  const totals = totalsByCurrency(lines);
  const priceLine = totals.length ? `Your price: ${totals.map((t) => formatMoney(t.cents, t.currency)).join(' + ')} excl. VAT.` : '';
  const rows: Array<[string, string, boolean?]> = lines.map((l) => [
    `${l.title}${l.quantity > 1 ? ` × ${l.quantity}` : ''}`,
    l.supplierCents != null ? `${formatMoney(l.supplierCents, l.supplierCurrency)} excl. VAT` : '',
    true,
  ]);
  rows.push(['Our reference', orderNumber]);
  const shippedOn = day(latest(lines.map((l) => l.shippedAt)));
  const deliveredOn = day(latest(lines.map((l) => l.deliveredAt)));
  const firstTitle = (lines[0]?.title ?? 'unit').slice(0, 70);
  const more = lines.length > 1 ? ` (+${lines.length - 1} more)` : '';

  let c: Omit<SaleNoticeContent, 'body' | 'rows'>;
  switch (event) {
    case 'PAID':
      c = {
        title: 'Unit sold — prepare it for dispatch',
        heading: 'Unit sold — prepare it for dispatch',
        subject: `Unit sold — prepare it for dispatch: ${firstTitle}${more} (order ${orderNumber})`,
        lead: `${what} ${one ? 'is' : 'are'} sold and paid for (our order ${orderNumber}).`,
        next: opts.dispatchText.trim() || null,
      };
      break;
    case 'SHIPPED':
      c = {
        title: `Shipped to the buyer — order ${orderNumber}`,
        heading: 'Shipped to the buyer',
        subject: `Shipped to the buyer: ${firstTitle}${more} (order ${orderNumber})`,
        lead: `${what} left for the buyer${shippedOn ? ` on ${shippedOn}` : ''}.`,
        next: null,
      };
      break;
    case 'DELIVERED':
      c = {
        title: `Delivered — order ${orderNumber}`,
        heading: 'Delivered to the buyer',
        subject: `Delivered: ${firstTitle}${more} (order ${orderNumber})`,
        lead: `${what} ${one ? 'was' : 'were'} delivered to the buyer${deliveredOn ? ` on ${deliveredOn}` : ''}.`,
        next: null,
      };
      break;
    case 'CANCELED':
      c = {
        title: `Sale canceled — do not dispatch (order ${orderNumber})`,
        heading: 'Sale canceled — do not dispatch',
        subject: `Sale canceled — do not dispatch: ${firstTitle}${more} (order ${orderNumber})`,
        lead: `The sale of ${what} (our order ${orderNumber}) was canceled.`,
        next: 'Do not dispatch the unit. If it has already left you, contact us.',
      };
      break;
  }
  const body = [c.lead, event === 'CANCELED' ? '' : priceLine, c.next ?? ''].filter(Boolean).join(' ');
  return { ...c, body: body.length > 500 ? `${body.slice(0, 499)}…` : body, rows };
}

function latest(dates: Array<Date | null>): Date | null {
  const known = dates.filter((d): d is Date => !!d);
  return known.length ? new Date(Math.max(...known.map((d) => d.getTime()))) : null;
}

/** €10,000 / £3,800.50 — whole amounts without cents. */
export function formatMoney(cents: number, currency: string): string {
  const digits = Math.round(cents) % 100 === 0 ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(digits)} ${currency}`;
  }
}

export const SALE_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  currency: true,
  subtotalCents: true,
  paidAt: true,
  createdAt: true,
  shippedAt: true,
  deliveredAt: true,
  openHolds: true,
  sourcingRequest: {
    select: {
      id: true,
      assignedTo: { select: { id: true, role: true } },
      product: { select: { seller: { select: { id: true, role: true } } } },
      offerSupplierCostCents: true,
      offerSupplierCostCurrency: true,
      sellerProposalCurrency: true,
      quotedCurrency: true,
    },
  },
  items: {
    select: {
      id: true,
      titleSnapshot: true,
      quantity: true,
      lineType: true,
      priceCentsSnapshot: true,
      basePriceCents: true,
      product: { select: { seller: { select: { id: true, role: true } } } },
    },
  },
  shipments: { select: { shippedAt: true, deliveredAt: true, items: { select: { orderItemId: true, qty: true } } } },
} satisfies Prisma.OrderSelect;

/**
 * The supplier's sold units (orders paid or further, newest first), optionally
 * only those paid since `since`. Canceled and refunded orders are left out.
 */
export async function loadSupplierSales(userId: string, opts: { since?: Date; take?: number } = {}): Promise<SupplierSaleLine[]> {
  const orders = await prisma.order.findMany({
    where: {
      status: { in: SOLD_STATUSES },
      AND: [
        {
          OR: [
            { sourcingRequestId: null, items: { some: { product: { sellerId: userId } } } },
            { sourcingRequest: { OR: [{ assignedToId: userId }, { product: { sellerId: userId } }] } },
          ],
        },
        ...(opts.since ? [{ OR: [{ paidAt: { gte: opts.since } }, { paidAt: null, createdAt: { gte: opts.since } }] }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: opts.take ?? 500,
    select: SALE_ORDER_SELECT,
  });
  return orders.flatMap((o) => supplierLinesOf(o).get(userId) ?? []);
}
