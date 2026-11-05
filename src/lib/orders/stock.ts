import { prisma } from '@/lib/db';
import { logError, notifyAdmins } from '@/lib/observability';
import { checkLowStock } from '@/lib/inventory/alerts';
import { takeQuoteOrderStock } from '@/lib/inventory/take';

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
/**
 * Take the unit(s) out of stock for an order that came from a quote/proforma,
 * at the moment it is paid.
 *
 * Quote orders deliberately reserve nothing while the offer is open — an offer
 * the buyer has not accepted must not hold inventory. But once the money is in,
 * the unit IS gone, and before this existed a one-off used part stayed on sale
 * after it had been sold and could be sold again to a second buyer.
 *
 * Cart orders are skipped: they already reserved at checkout
 * (reserveAndCreateOrder), and decrementing here would double-count.
 *
 * Like releaseReservedStock this NEVER throws. It runs after the payment has
 * been recorded, so a stock problem must not turn a successful payment into a
 * 500 — it is logged for an operator to reconcile instead.
 *
 * Call it exactly once per order, guarded by the caller's atomic
 * PENDING_PAYMENT -> PAID claim (count === 1).
 */
export async function consumeStockForPaidQuoteOrder(orderId: string, where: string): Promise<void> {
  try {
    // Takes the units and records per line how many were really taken
    // (OrderItem.stockTaken), so Reserved in the inventory and a later refund
    // use the real number. Never takes twice for the same line.
    const res = await takeQuoteOrderStock(orderId);
    if (!res) return; // no order, or a cart order that already reserved at checkout
    for (const line of res.lines) {
      if (line.taken >= line.wanted) continue;
      // The listing held fewer units than were sold (edited, sold through
      // another route, or quoted above stock) or is gone. The sale stands; what
      // was there was taken, so the same one-off part can't be sold again.
      const title = line.title ?? `product ${line.productId} (deleted)`;
      await logError(
        `${where}.consumeStockForPaidQuoteOrder`,
        new Error(
          `order ${res.orderNumber}: sold ${line.wanted} × "${title}" but the listing had ${line.before ?? 0} in stock — took ${line.taken}, listing now 0 (out of stock)`,
        ),
      );
      await notifyAdmins(
        `Stock check needed — ${title}`,
        `Order ${res.orderNumber} was paid for ${line.wanted} unit(s), but the listing only had ${line.before ?? 0}, so ${line.taken} were taken from stock and the listing is now out of stock. If you have more units, set On hand in the inventory.`,
        line.title ? `/admin/inventory?focus=${line.productId}` : '/admin/inventory',
        'SYSTEM',
      ).catch(() => {});
    }
    await checkLowStock(res.lines.map((l) => l.productId));
  } catch (e) {
    await logError(`${where}.consumeStockForPaidQuoteOrder`, e);
  }
}

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
  await checkLowStock(reserved.map((r) => r.productId));
}
