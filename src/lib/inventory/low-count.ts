import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getInventorySettings } from './settings';

/**
 * How many of Labtodate's own, non-archived items are at or below their
 * low-stock threshold (the item's own, else the default in settings). Same
 * rule as the sheet's "Low stock" filter; used for the admin menu badge.
 */
export async function countLowStock(): Promise<number> {
  const s = await getInventorySettings();
  const rows = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS n
    FROM "Product" p
    LEFT JOIN "ProductInventory" i ON i."productId" = p."id"
    WHERE p."companyId" IS NULL
      AND p."status" <> 'ARCHIVED'
      AND p."quantity" <= COALESCE(i."lowStockAt", ${s.INVENTORY_LOW_STOCK_DEFAULT})
  `);
  return Number(rows[0]?.n ?? 0);
}
