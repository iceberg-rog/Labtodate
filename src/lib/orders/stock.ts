import { prisma } from '@/lib/db';
import { logError } from '@/lib/observability';

/**
 * BUG-045 — release stock that was atomically reserved for a checkout that did
 * not end up producing an Order row.
 *
 * Both checkout paths (`startCheckoutWithAddress`, `checkoutCart`) decrement
 * `product.quantity` BEFORE `createOrderWithUniqueNumber`, so that the same used
 * unit can never be sold twice. That ordering is correct — but it means the
 * window between the reservation and the successful create is a window in which
 * a throw leaks stock **permanently**: there is no Order row, so neither the
 * orphan sweep, `cancelOrder`, nor `refundOrder` can ever restock it. The unit
 * is simply gone from inventory until someone edits the DB by hand.
 *
 * This helper is the compensating action for that window. Two deliberate
 * properties:
 *
 * 1. **It never throws.** It runs on failure paths, usually inside a `catch`,
 *    right before a `redirect()`. A throw here would replace a recoverable
 *    "order could not be created, try again" with an unhandled 500 AND still
 *    leak the stock — strictly worse than the bug it fixes. Every restore is
 *    attempted independently and failures are logged, not propagated.
 *
 * 2. **It uses `updateMany`, not `update`.** `update({where:{id}})` throws
 *    P2025 if the product row vanished (hard-deleted between reserve and
 *    rollback). With a plain loop of `update`s, one missing row aborts the
 *    restore of every *remaining* item in a multi-item cart. `updateMany`
 *    no-ops (count 0) on a missing row so the rest of the cart still gets its
 *    stock back.
 *
 * Restocking a product that no longer exists is a no-op by definition, which is
 * the correct outcome — there is nothing to sell.
 */
export async function releaseReservedStock(
  reserved: ReadonlyArray<{ productId: string; quantity: number }>,
  where: string,
): Promise<void> {
  for (const item of reserved) {
    if (!item.productId || !Number.isFinite(item.quantity) || item.quantity <= 0) continue;
    try {
      await prisma.product.updateMany({
        where: { id: item.productId },
        data: { quantity: { increment: item.quantity } },
      });
    } catch (e) {
      // Last-resort: a restore we could not perform. Log loudly (this is real
      // inventory drift that an operator has to reconcile by hand) but keep
      // going so the other items in the cart are still released.
      await logError(`${where}.releaseReservedStock`, e);
    }
  }
}
