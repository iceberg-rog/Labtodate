import type { Prisma } from '@prisma/client';
import { getInventorySettings, type InventorySettings } from './settings';

/**
 * How stock shows on the public site. Product.quantity is the number available
 * to sell; these rules (all admin settings) decide what a buyer sees at 0.
 */

/** What a buyer can browse (lists, search, facets, counts, homepage). */
export async function liveProductWhere(): Promise<Prisma.ProductWhereInput> {
  const s = await getInventorySettings();
  return liveWhereFor(s);
}

export function liveWhereFor(s: Pick<InventorySettings, 'INVENTORY_ZERO_STOCK'>): Prisma.ProductWhereInput {
  return s.INVENTORY_ZERO_STOCK === 'label' ? { status: 'PUBLISHED' } : { status: 'PUBLISHED', quantity: { gt: 0 } };
}

export type PublicStock = {
  inStock: boolean;
  /** Label for an item with nothing available ("Out of stock"). */
  outLabel: string;
  outNote: string;
  /** "Only 2 left" / "5 in stock" / null. */
  qtyText: string | null;
  /** The product page itself should 404 (zero-stock rule "unpublish"). */
  hidePage: boolean;
};

export function publicStockFor(quantity: number, s: InventorySettings): PublicStock {
  const inStock = quantity > 0;
  let qtyText: string | null = null;
  if (inStock && s.INVENTORY_PUBLIC_QTY === 'exact') qtyText = `${quantity} in stock`;
  if (inStock && s.INVENTORY_PUBLIC_QTY === 'low' && quantity <= s.INVENTORY_PUBLIC_LOW_AT) qtyText = `Only ${quantity} left`;
  return {
    inStock,
    outLabel: s.INVENTORY_OOS_LABEL || 'Out of stock',
    outNote: s.INVENTORY_OOS_NOTE,
    qtyText,
    hidePage: !inStock && s.INVENTORY_ZERO_STOCK === 'unpublish',
  };
}

export async function publicStock(quantity: number): Promise<PublicStock> {
  return publicStockFor(quantity, await getInventorySettings());
}
