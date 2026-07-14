import type { PrismaClient, Prisma } from '@prisma/client';

/**
 * import-woo category cleanup predicate. A category is safe to delete only when
 * it has NO products of ANY status and no children — a retained ARCHIVED product
 * still pins the required `Product.categoryId` FK, so selecting `none: {}` (not
 * `none: { status: PUBLISHED }`) is what prevents a FK-violation on delete.
 * Exported (single source of truth) so import-woo and its regression test assert
 * the exact same value.
 */
export const EMPTY_CATEGORY_DELETE_WHERE: Prisma.CategoryWhereInput = {
  products: { none: {} },
  children: { none: {} },
};

/**
 * Shared product-deletion guard used by EVERY deletion path — the seller action
 * (`deleteProduct`), the admin action (`adminDeleteProduct`) and the import-woo
 * cleanup. Single source of truth so the invariant can't regress in one path
 * while passing in another.
 *
 * Invariant: a product with ANY OrderItem history is archived (status ARCHIVED),
 * never hard-deleted, so the `OrderItem.productId → Product` FK (ON DELETE
 * RESTRICT, see prisma/schema.prisma) keeps its audit/analytics link. The
 * *Snapshot columns on OrderItem are resilience, not permission to sever it.
 *
 * TOCTOU: the history probe and the delete are not atomic. If an OrderItem is
 * created in the gap, the RESTRICT FK makes `delete` raise Prisma P2003; we
 * catch that and archive instead of surfacing a 500. RESTRICT is thus real
 * defense-in-depth, and the probe is just the fast path that avoids a throw.
 */

export type ProductDeleteOutcome = 'deleted' | 'archived';

/** Minimal structural slice of the Prisma client this guard touches. Declared
 *  independently of PrismaClient so the guard is unit-testable with a fake. */
export interface ProductDeleteDb {
  orderItem: { count(args: { where: { productId: string } }): Promise<number> };
  product: {
    update(args: { where: { id: string }; data: { status: 'ARCHIVED' } }): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

/** Adapt a real PrismaClient to the guard's structural surface. */
export function productDeleteDbFrom(prisma: PrismaClient): ProductDeleteDb {
  return {
    orderItem: { count: (args) => prisma.orderItem.count(args) },
    product: {
      update: (args) => prisma.product.update(args),
      delete: (args) => prisma.product.delete(args),
    },
  };
}

/** True for a PostgreSQL FK RESTRICT/violation surfaced by Prisma (code P2003). */
export function isForeignKeyRestrict(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2003';
}

/**
 * Archive-if-ordered, else hard-delete, with a TOCTOU-safe fallback: a hard
 * delete that loses a race to a new OrderItem raises P2003 and is downgraded to
 * an archive. Returns the action actually taken.
 */
export async function deleteOrArchiveProduct(
  db: ProductDeleteDb,
  productId: string,
): Promise<ProductDeleteOutcome> {
  if ((await db.orderItem.count({ where: { productId } })) > 0) {
    await db.product.update({ where: { id: productId }, data: { status: 'ARCHIVED' } });
    return 'archived';
  }
  try {
    await db.product.delete({ where: { id: productId } });
    return 'deleted';
  } catch (err) {
    if (isForeignKeyRestrict(err)) {
      await db.product.update({ where: { id: productId }, data: { status: 'ARCHIVED' } });
      return 'archived';
    }
    throw err;
  }
}
