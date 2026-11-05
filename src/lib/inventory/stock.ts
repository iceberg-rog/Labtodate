import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Orders whose units are already off Product.quantity but have not left the
 * warehouse yet. Mirrors when the existing order code takes stock
 * (see orderHoldsStock in src/lib/orders/checkout-tx.ts):
 *  - cart / buy-now orders take it at checkout, so PENDING_PAYMENT counts;
 *  - quote orders take it when PAID (consumeStockForPaidQuoteOrder).
 * Once SHIPPED the unit is gone from the shelf too, so it is no longer reserved.
 *
 * On hand = Product.quantity (available) + reserved.
 */
export const RESERVING_ORDER_WHERE: Prisma.OrderWhereInput = {
  OR: [
    { sourcingRequestId: null, status: { in: ['PENDING_PAYMENT', 'PAID', 'PROCESSING'] } },
    { sourcingRequestId: { not: null }, status: { in: ['PAID', 'PROCESSING'] } },
  ],
};

/** Same rule as a plain predicate (unit-tested against orderHoldsStock). */
export function orderReservesUnits(order: { sourcingRequestId: string | null; status: string }): boolean {
  if (!order.sourcingRequestId) return ['PENDING_PAYMENT', 'PAID', 'PROCESSING'].includes(order.status);
  return ['PAID', 'PROCESSING'].includes(order.status);
}

/** Reserved units per product id (products with none are absent). */
export async function reservedByProduct(db: Db = prisma, productIds?: string[]): Promise<Map<string, number>> {
  if (productIds && productIds.length === 0) return new Map();
  const groups = await db.orderItem.groupBy({
    by: ['productId'],
    where: {
      productId: productIds ? { in: productIds } : { not: null },
      order: RESERVING_ORDER_WHERE,
    },
    _sum: { quantity: true },
  });
  const out = new Map<string, number>();
  for (const g of groups) {
    if (g.productId && g._sum.quantity) out.set(g.productId, g._sum.quantity);
  }
  return out;
}

export type ReservationLine = {
  orderId: string;
  orderNumber: string;
  status: string;
  quantity: number;
  createdAt: string;
  kind: 'reserved' | 'proforma';
  buyer: string;
};

/**
 * The orders behind an item's Reserved number, plus unpaid quote proformas
 * (which do not hold stock yet, but are good to know about).
 */
export async function reservationsFor(productId: string): Promise<ReservationLine[]> {
  const items = await prisma.orderItem.findMany({
    where: {
      productId,
      order: {
        OR: [RESERVING_ORDER_WHERE, { sourcingRequestId: { not: null }, status: 'PENDING_PAYMENT' }],
      },
    },
    select: {
      quantity: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          createdAt: true,
          sourcingRequestId: true,
          buyer: { select: { name: true, email: true } },
        },
      },
    },
    orderBy: { order: { createdAt: 'desc' } },
    take: 100,
  });
  return items.map((i) => ({
    orderId: i.order.id,
    orderNumber: i.order.orderNumber,
    status: i.order.status,
    quantity: i.quantity,
    createdAt: i.order.createdAt.toISOString(),
    kind: orderReservesUnits(i.order) ? 'reserved' : 'proforma',
    buyer: i.order.buyer.name || i.order.buyer.email,
  }));
}
