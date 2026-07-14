import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Order-lifecycle state transitions that MUST be atomic. Each takes a
 * PrismaClient (dependency-injected) so it is exercised directly by both the
 * production callers and the disposable-DB integration tests.
 *
 * Why transactions and not compensations: a reservation (product.quantity
 * decrement) that commits before the Order row exists leaks stock forever if the
 * process dies in between — no Order means no sweep/cancel/refund can restock it.
 * A single DB transaction makes reservation + create atomic: an interpreter
 * crash, a dropped connection, or a mid-transaction throw all roll back the
 * decrements automatically. Likewise a cancel that commits before its restock
 * loop leaks stock if a restock then fails; claim + restock in one tx rolls back.
 */

export function generateOrderNumber(): string {
  const year = new Date().getFullYear();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `L2D-${year}-${rand}`;
}

/** Thrown inside the reservation transaction when a unit is no longer available
 *  OR the product changed under the buyer (unpublished / became QUOTE_ONLY /
 *  price or currency changed since the snapshot). Aborts (and rolls back) the
 *  whole transaction. Not exported — callers branch on the discriminated result. */
class InsufficientStockError extends Error {}
/** Thrown when a checked-out cart row changed or vanished between the caller's
 *  snapshot and the transaction (concurrent quantity change / removal). Rolls the
 *  whole checkout back so a stale subset is never ordered and no row is silently
 *  deleted. A concurrently ADDED row is simply not in the snapshot, so it survives. */
class CartChangedError extends Error {}

/** One unit to reserve, with the exact buyability/financial snapshot the buyer saw.
 *  The guarded decrement requires ALL of these to still hold, so an admin edit
 *  (archive / QUOTE_ONLY / price / currency) between read and tx cannot sell at a
 *  stale snapshot. */
export type Reservation = {
  productId: string;
  quantity: number;
  expectedPriceCents: number;
  expectedCurrency: string;
};

export type ReserveAndCreateResult =
  | { ok: true; order: { id: string; orderNumber: string } }
  | { ok: false; reason: 'unavailable' }
  | { ok: false; reason: 'cart-changed' }
  | { ok: false; reason: 'order'; error: unknown };

/**
 * Reserve every unit AND create the Order (+items, +optional cart clear) in ONE
 * transaction. Guarantees:
 *  - a partial reservation or an order-create failure rolls back EVERY decrement
 *    (and leaves the cart intact);
 *  - success decrements once, creates one order, clears the cart once;
 *  - concurrent quantity=1 checkouts produce exactly one order (the guarded
 *    `updateMany ... quantity >= n` serialises on the row lock; the loser sees
 *    count 0 → InsufficientStockError → rollback → `unavailable`);
 *  - an orderNumber P2002 collision retries the WHOLE transaction (the rollback
 *    already undid the decrements) — it never continues issuing statements inside
 *    a poisoned/aborted transaction.
 */
export async function reserveAndCreateOrder(
  db: PrismaClient,
  params: {
    reservations: ReadonlyArray<Reservation>;
    orderData: Omit<Prisma.OrderUncheckedCreateInput, 'orderNumber' | 'items'>;
    items: Prisma.OrderItemUncheckedCreateWithoutOrderInput[];
    /** Exact cart rows being checked out. Cleared with a GUARDED per-row delete
     *  (id + userId + expected quantity); a changed/removed row makes the whole
     *  checkout roll back, and a concurrently added row (not in the snapshot)
     *  survives. */
    cartClear?: { userId: string; items: ReadonlyArray<{ id: string; quantity: number }> };
  },
): Promise<ReserveAndCreateResult> {
  const { reservations, orderData, items, cartClear } = params;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const order = await db.$transaction(async (tx) => {
        for (const r of reservations) {
          const dec = await tx.product.updateMany({
            where: {
              id: r.productId,
              quantity: { gte: r.quantity },
              status: 'PUBLISHED',
              mode: { not: 'QUOTE_ONLY' },
              priceCents: r.expectedPriceCents,
              currency: r.expectedCurrency,
            },
            data: { quantity: { decrement: r.quantity } },
          });
          if (dec.count !== 1) throw new InsufficientStockError();
        }
        const created = await tx.order.create({
          data: { ...orderData, orderNumber: generateOrderNumber(), items: { create: items } },
          select: { id: true, orderNumber: true },
        });
        if (cartClear) {
          let deleted = 0;
          for (const ci of cartClear.items) {
            const d = await tx.cartItem.deleteMany({
              where: { id: ci.id, userId: cartClear.userId, quantity: ci.quantity },
            });
            deleted += d.count;
          }
          // Exact-snapshot invariant: every checked-out row must still match.
          if (deleted !== cartClear.items.length) throw new CartChangedError();
        }
        return created;
      });
      return { ok: true, order };
    } catch (e) {
      if (e instanceof InsufficientStockError) return { ok: false, reason: 'unavailable' };
      if (e instanceof CartChangedError) return { ok: false, reason: 'cart-changed' };
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && attempt < 5) {
        continue; // retry the ENTIRE transaction; the rollback already restored stock
      }
      return { ok: false, reason: 'order', error: e };
    }
  }
  return { ok: false, reason: 'order', error: new Error('Could not allocate an order number') };
}

export type CancelAndRestockResult = 'canceled' | 'noop';

/**
 * Atomically claim `PENDING_PAYMENT → CANCELED` and restock every line, in ONE
 * transaction. Used by the Stripe `checkout.session.expired` webhook and by both
 * checkout Stripe-handoff-failure cleanups.
 *  - Only the writer that flips the row restocks (claim.count === 1); redeliveries
 *    / concurrent writers no-op.
 *  - If ANY restock throws, the whole transaction rolls back and the status
 *    returns to PENDING_PAYMENT, so a retry cancels + restocks exactly once.
 *  - PAID / already-CANCELED orders are no-ops.
 *  - `requireNoProof` additionally refuses to cancel an order with a manual
 *    payment proof in flight (used where a buyer upload must win the race).
 *  - when `expectedStripeSessionId` is PRESENT (incl. explicit `null`), the claim
 *    also CAS-matches `stripeSessionId`, so a concurrent session-persist (or a
 *    stale/superseded session) makes the cancel a no-op — the single-winner guard
 *    that stops an active payable session being canceled/restocked out from under.
 * Restock uses `updateMany` so a hard-deleted product no-ops (count 0) rather
 * than throwing P2025 and rolling back a legitimate cancel. The caller (cancel
 * saga) is responsible for expiring any active Stripe session BEFORE calling this.
 */
export async function cancelAndRestockOrder(
  db: PrismaClient,
  orderId: string,
  opts: { requireNoProof?: boolean; expectedStripeSessionId?: string | null } = {},
): Promise<CancelAndRestockResult> {
  return db.$transaction(async (tx) => {
    const where: Prisma.OrderWhereInput = { id: orderId, status: 'PENDING_PAYMENT' };
    if (opts.requireNoProof) where.paymentSubmittedAt = null;
    if ('expectedStripeSessionId' in opts) where.stripeSessionId = opts.expectedStripeSessionId;
    const claim = await tx.order.updateMany({
      where,
      data: { status: 'CANCELED' },
    });
    if (claim.count !== 1) return 'noop';
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { productId: true, quantity: true },
    });
    for (const it of items) {
      if (!it.productId) continue;
      await tx.product.updateMany({
        where: { id: it.productId },
        data: { quantity: { increment: it.quantity } },
      });
    }
    return 'canceled';
  });
}
