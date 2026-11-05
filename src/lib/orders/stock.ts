import { prisma } from '@/lib/db';
import { logError, notifyAdmins } from '@/lib/observability';
import { checkLowStock } from '@/lib/inventory/alerts';

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
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        orderNumber: true,
        sourcingRequestId: true,
        items: { select: { productId: true, quantity: true } },
      },
    });
    // No order, or a cart order that already reserved at checkout.
    if (!order || !order.sourcingRequestId) return;
    for (const item of order.items) {
      if (!item.productId || !Number.isFinite(item.quantity) || item.quantity <= 0) continue;
      const dec = await prisma.product.updateMany({
        where: { id: item.productId, quantity: { gte: item.quantity } },
        data: { quantity: { decrement: item.quantity } },
      });
      if (dec.count !== 1) {
        // The listing holds fewer units than were sold (edited, sold through
        // another route, or quoted above stock) or is gone. The sale still
        // stands. Previously the listing then stayed "in stock" and the same
        // one-off part could be sold again: take what is left (down to 0) so it
        // can't, and tell the team by product name.
        const product = await prisma.product.findUnique({
          where: { id: item.productId },
          select: { title: true, quantity: true },
        });
        if (product && product.quantity > 0) {
          await prisma.product.updateMany({
            where: { id: item.productId, quantity: { lt: item.quantity } },
            data: { quantity: 0 },
          });
        }
        const title = product?.title ?? `product ${item.productId} (deleted)`;
        await logError(
          `${where}.consumeStockForPaidQuoteOrder`,
          new Error(
            `order ${order.orderNumber}: sold ${item.quantity} × "${title}" but the listing had ${product ? Math.max(0, product.quantity) : 0} in stock — listing set to 0 (out of stock)`,
          ),
        );
        await notifyAdmins(
          `Stock check needed — ${title}`,
          `Order ${order.orderNumber} was paid for ${item.quantity} unit(s), but the listing only had ${product ? Math.max(0, product.quantity) : 0}. The listing is now out of stock; correct the stock if you have more units.`,
          '/admin/products',
          'SYSTEM',
        ).catch(() => {});
      }
    }
    await checkLowStock(order.items.map((i) => i.productId));
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
