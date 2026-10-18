import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { consumeReservation, releaseReservation, reserveStock } from '@/lib/stock/reserve';
import { stockReserveOn } from './policy';
import { QUOTE_REF } from '@/lib/quotes/offer';

/**
 * Stock holds for quote deals (A09) on top of lib/stock/reserve.ts. One hold per
 * quote: source QUOTE, refId = the SourcingRequest id. Product.quantity is the
 * AVAILABLE count, so a held unit can not be bought with Buy Now / the cart
 * (their guarded decrement needs quantity ≥ 1) and no other offer on it can be
 * accepted.
 *
 *  - reserved when the offer is sent / accepted / paid (STOCK_RESERVE_ON);
 *  - released exactly once on decline, close, expiry, buyer or staff cancel;
 *  - consumed (sold, no restock) when the payment is verified / approved on terms.
 * Server-internal (no session checks) — never import from a client component.
 */

type Db = Prisma.TransactionClient;

export interface UnitAvailability {
  productId: string;
  quantity: number;
  /** This quote already holds the unit. */
  heldByThisQuote: boolean;
  /** Other active holds on the product (order / other quote). */
  otherHolds: Array<{ source: string; refId: string; orderNumber: string | null; quoteRef: string | null }>;
}

const quoteRefOf = (id: string) => QUOTE_REF(id);

/** What staff need to know before sending / while viewing an offer on a listed unit. */
export async function unitAvailability(productId: string, quoteId: string): Promise<UnitAvailability | null> {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, quantity: true } });
  if (!product) return null;
  const holds = await prisma.stockReservation.findMany({
    where: { productId, releasedAt: null, consumedAt: null },
    select: { source: true, refId: true, order: { select: { orderNumber: true } } },
  });
  return {
    productId,
    quantity: product.quantity,
    heldByThisQuote: holds.some((h) => h.source === 'QUOTE' && h.refId === quoteId),
    otherHolds: holds
      .filter((h) => !(h.source === 'QUOTE' && h.refId === quoteId))
      .map((h) => ({ source: h.source, refId: h.refId, orderNumber: h.order?.orderNumber ?? null, quoteRef: h.source === 'QUOTE' ? quoteRefOf(h.refId) : null })),
  };
}

export type HoldResult = { ok: true; created: boolean } | { ok: false; message: string };

/**
 * Hold one unit for the quote (idempotent per quote). With `orderId` the hold
 * belongs to the accepted order and never expires on its own (it ends when the
 * order is paid or canceled); without, it expires at `expiresAt` (open offer).
 */
export async function holdUnitForQuote(
  tx: Db,
  p: { quoteId: string; productId: string; qty: number; orderId?: string | null; expiresAt?: Date | null },
): Promise<HoldResult> {
  const r = await reserveStock(
    { productId: p.productId, qty: p.qty, source: 'QUOTE', refId: p.quoteId, orderId: p.orderId ?? null, expiresAt: p.orderId ? null : p.expiresAt ?? null },
    tx,
  );
  if (!r.ok) return { ok: false, message: r.message };
  if (!r.created) {
    // An existing open-offer hold now belongs to the accepted order: no expiry.
    await tx.stockReservation.update({
      where: { id: r.reservationId },
      data: p.orderId ? { orderId: p.orderId, expiresAt: null } : { expiresAt: p.expiresAt ?? null },
    });
  }
  return { ok: true, created: r.created };
}

/** Put the quote's held unit back on sale (exactly once). Returns units released. */
export async function releaseQuoteHold(quoteId: string, reason: string, tx?: Db): Promise<number> {
  return releaseReservation({ source: 'QUOTE', refId: quoteId }, reason, tx);
}

/** The held unit was sold (payment verified / approved on terms). */
export async function consumeQuoteHold(quoteId: string, tx?: Db): Promise<number> {
  return consumeReservation({ source: 'QUOTE', refId: quoteId }, tx);
}

/** Did this (quote) order take a unit out of stock? (A consumed or active hold exists.) */
export async function quoteOrderTookStock(orderId: string, db: Db | typeof prisma = prisma): Promise<boolean> {
  const n = await db.stockReservation.count({ where: { orderId, source: 'QUOTE', releasedAt: null } });
  return n > 0;
}

/**
 * A quote order was paid: its held unit is sold (A09). With STOCK_RESERVE_ON =
 * PAYMENT_VERIFIED nothing was held yet — take the unit now; if it is gone, the
 * payment still counts (money arrived) and staff are told to sort the stock out.
 * Used by every "paid" path: verify / mark paid / terms (admin) and a card
 * payment confirmed by the Stripe webhook (pay-by-card on the payment page).
 */
export async function sellQuoteUnit(tx: Prisma.TransactionClient, quoteId: string, orderId: string, item: { productId: string | null; quantity: number } | undefined): Promise<string> {
  if (stockReserveOn() === 'PAYMENT_VERIFIED' && item?.productId) {
    const h = await holdUnitForQuote(tx, { quoteId, productId: item.productId, qty: item.quantity, orderId });
    if (!h.ok) return ` Warning: the unit could not be taken from stock (${h.message}) — check the listing before shipping.`;
  }
  await consumeQuoteHold(quoteId, tx);
  return '';
}

/** Outcome of taking a paid quote order's unit out of stock. */
export interface TakeUnitResult {
  /** The unit is sold to this order (or the order holds no listed unit). */
  ok: boolean;
  /** The unit is no longer in stock: staff decide refund, backorder or another unit (STOCK_SHORTAGE). */
  short: boolean;
  /** For staff ('' when there is nothing to say). */
  warning: string;
}

/**
 * sellQuoteUnit with a typed result for the "paid" paths: `short` instead of a
 * warning sentence when the unit could not be taken. An order without a quote
 * has no quote hold — nothing to take.
 */
export async function takeQuoteUnit(
  tx: Prisma.TransactionClient,
  order: { id: string; sourcingRequestId: string | null; items: Array<{ productId: string | null; quantity: number }> },
): Promise<TakeUnitResult> {
  if (!order.sourcingRequestId) return { ok: true, short: false, warning: '' };
  const warning = (await sellQuoteUnit(tx, order.sourcingRequestId, order.id, order.items[0])).trim();
  return warning ? { ok: false, short: true, warning } : { ok: true, short: false, warning: '' };
}
