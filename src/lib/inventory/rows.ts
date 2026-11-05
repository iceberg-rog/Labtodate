import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { InventoryRow } from './fields';
import { reservedByProduct } from './stock';

export const ROW_INCLUDE = {
  brand: { select: { name: true } },
  category: { select: { name: true } },
  company: { select: { name: true } },
  inventory: { include: { supplier: { select: { name: true } } } },
} satisfies Prisma.ProductInclude;

export type ProductForRow = Prisma.ProductGetPayload<{ include: typeof ROW_INCLUDE }>;

/** "Part number=G1312-60010; Revision=A" style specs -> the part number, if any. */
export function partNumberFromSpecs(specs: unknown): string | null {
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) return null;
  for (const [k, v] of Object.entries(specs as Record<string, unknown>)) {
    const key = k.toLowerCase().replace(/[^a-z]/g, '');
    if (['partnumber', 'partno', 'pn', 'mpn', 'partnr'].includes(key) && typeof v === 'string' && v.trim()) {
      return v.trim().slice(0, 80);
    }
  }
  return null;
}

export function toInventoryRow(p: ProductForRow, reserved: number, canCost: boolean): InventoryRow {
  const inv = p.inventory;
  const specMpn = inv?.mpn ? null : partNumberFromSpecs(p.specs);
  return {
    id: p.id,
    slug: p.slug,
    image: p.images[0] ?? null,
    sku: inv?.sku ?? null,
    mpn: inv?.mpn ?? specMpn,
    mpnFromSpecs: !inv?.mpn && !!specMpn,
    title: p.title,
    brand: p.brand?.name ?? null,
    category: p.category.name,
    condition: p.condition,
    supplier: inv?.supplier?.name ?? null,
    costCents: canCost ? (inv?.costCents ?? null) : null,
    onHand: p.quantity + reserved,
    reserved,
    available: p.quantity,
    // A quote-only item's selling price lives in the private record (see schema).
    priceCents: p.mode === 'QUOTE_ONLY' ? (inv?.quotePriceCents ?? p.priceCents) : p.priceCents,
    priceInternal: p.mode === 'QUOTE_ONLY',
    currency: p.currency,
    location: inv?.location ?? null,
    notes: inv?.notes ?? null,
    lowStockAt: inv?.lowStockAt ?? null,
    status: p.status,
    mode: p.mode,
    shop: p.company?.name ?? null,
    updatedAt: (inv && inv.updatedAt > p.updatedAt ? inv.updatedAt : p.updatedAt).toISOString(),
  };
}

export type RowScope = 'own' | 'all';

/** Rows for the sheet / export. `own` = Labtodate's own listings (no shop). */
export async function loadInventoryRows(opts: { scope?: RowScope; ids?: string[]; canCost: boolean }): Promise<InventoryRow[]> {
  const where: Prisma.ProductWhereInput = {
    ...(opts.ids ? { id: { in: opts.ids } } : {}),
    ...(opts.scope === 'own' ? { companyId: null } : {}),
  };
  const products = await prisma.product.findMany({
    where,
    include: ROW_INCLUDE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 10000,
  });
  const reserved = await reservedByProduct(prisma, opts.ids ?? (products.length <= 5000 ? products.map((p) => p.id) : undefined));
  return products.map((p) => toInventoryRow(p, reserved.get(p.id) ?? 0, opts.canCost));
}
