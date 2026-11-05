import { Prisma, type PrismaClient } from '@prisma/client';
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
 *
 * Where a line records what it actually took (OrderItem.stockTaken), that
 * number counts: a quote paid for more than was in stock reserves only what was
 * there. Older lines without it fall back to this status rule and `quantity`.
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
  const onlyThese = productIds ? Prisma.sql`AND oi."productId" IN (${Prisma.join(productIds)})` : Prisma.empty;
  const rows = await db.$queryRaw<{ productId: string; n: number }[]>(Prisma.sql`
    SELECT oi."productId", SUM(
      CASE
        WHEN oi."stockTaken" IS NOT NULL THEN oi."stockTaken"
        WHEN o."sourcingRequestId" IS NULL OR o."status" IN ('PAID', 'PROCESSING') THEN oi."quantity"
        ELSE 0
      END
    )::int AS n
    FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    WHERE oi."productId" IS NOT NULL
      AND o."status" IN ('PENDING_PAYMENT', 'PAID', 'PROCESSING')
      ${onlyThese}
    GROUP BY oi."productId"
  `);
  const out = new Map<string, number>();
  for (const r of rows) if (r.n > 0) out.set(r.productId, r.n);
  return out;
}

export type ReservationLine = {
  orderId: string;
  orderNumber: string;
  status: string;
  /** Units this line holds off the stock. */
  quantity: number;
  /** Units the line sold, when more than it could take (stock was short). */
  sold: number | null;
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
      stockTaken: true,
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
  return items.map((i) => {
    const holds = i.stockTaken !== null || orderReservesUnits(i.order);
    const held = i.stockTaken ?? (holds ? i.quantity : 0);
    return {
      orderId: i.order.id,
      orderNumber: i.order.orderNumber,
      status: i.order.status,
      quantity: holds ? held : i.quantity,
      sold: i.stockTaken !== null && i.stockTaken < i.quantity ? i.quantity : null,
      createdAt: i.order.createdAt.toISOString(),
      kind: holds ? 'reserved' : 'proforma',
      buyer: i.order.buyer.name || i.order.buyer.email,
    };
  });
}
