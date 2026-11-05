import { prisma } from '@/lib/db';

export type TakenLine = {
  itemId: string;
  productId: string;
  title: string | null;
  /** Units the order line sold. */
  wanted: number;
  /** Units actually taken off the listing (lower when stock was short). */
  taken: number;
  /** The listing's stock before taking; null when the listing is gone. */
  before: number | null;
};

class AlreadyTaken extends Error {}

/**
 * Take a paid quote order's units off stock and record, per line, how many
 * were actually taken (OrderItem.stockTaken). When the listing holds fewer
 * units than were sold, what is there is taken (down to 0): the sale stands,
 * the listing can no longer be sold again, and the record stays exact, so the
 * inventory's Reserved and a later refund use the real number.
 *
 * Per line in its own transaction with the product row locked, and a line is
 * claimed only while stockTaken is still null, so calling this twice never
 * takes twice. Database only (no e-mail, no notifications): the caller reports.
 */
export async function takeQuoteOrderStock(orderId: string): Promise<{ orderNumber: string; lines: TakenLine[] } | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      orderNumber: true,
      sourcingRequestId: true,
      items: { select: { id: true, productId: true, quantity: true, stockTaken: true } },
    },
  });
  // No order, or a cart order (it took its units at checkout).
  if (!order || !order.sourcingRequestId) return null;
  const lines: TakenLine[] = [];
  for (const item of order.items) {
    if (!item.productId || item.stockTaken !== null || !Number.isFinite(item.quantity) || item.quantity <= 0) continue;
    const productId = item.productId;
    try {
      const line = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ quantity: number; title: string }[]>`
          SELECT "quantity", "title" FROM "Product" WHERE "id" = ${productId} FOR UPDATE`;
        const before = rows.length ? rows[0].quantity : null;
        const taken = before === null ? 0 : Math.max(0, Math.min(before, item.quantity));
        const claim = await tx.orderItem.updateMany({ where: { id: item.id, stockTaken: null }, data: { stockTaken: taken } });
        if (claim.count !== 1) throw new AlreadyTaken();
        if (taken > 0) await tx.product.update({ where: { id: productId }, data: { quantity: { decrement: taken } } });
        return { itemId: item.id, productId, title: rows[0]?.title ?? null, wanted: item.quantity, taken, before };
      });
      lines.push(line);
    } catch (e) {
      if (e instanceof AlreadyTaken) continue;
      throw e;
    }
  }
  return { orderNumber: order.orderNumber, lines };
}
