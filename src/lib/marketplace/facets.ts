import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { productTextWhere } from '@/lib/search/where';
import { PURCHASABLE_WHERE, QUOTE_ONLY_WHERE, type MarketplaceFilters } from '@/lib/marketplace/queries';

/** Product.priceCents is a Postgres INT4 (same clamp as listProducts). */
const INT4_MAX = 2_147_483_647;
const clampCents = (n: number) => Math.min(INT4_MAX, Math.max(0, Math.round(n)));

/**
 * The marketplace filter conditions (mirrors listProducts), optionally leaving
 * one facet out. A facet's counts must reflect every OTHER active filter:
 * "Waters (2)" next to an active "Pumps & Fluidics" used to lead to "No
 * instruments match" because the brand counts were global.
 */
function filterAnd(filters: MarketplaceFilters, omit?: 'category' | 'brand'): Prisma.ProductWhereInput[] {
  const and: Prisma.ProductWhereInput[] = [];
  if (filters.q?.trim()) and.push(productTextWhere(filters.q));
  if (filters.category && omit !== 'category') and.push({ category: { slug: filters.category } });
  if (filters.brand && omit !== 'brand') and.push({ brand: { slug: filters.brand } });
  if (filters.condition) and.push({ condition: filters.condition });
  if (filters.mode === 'BUY_NOW') and.push(PURCHASABLE_WHERE);
  else if (filters.mode === 'HYBRID') and.push(PURCHASABLE_WHERE, { mode: 'HYBRID' });
  else if (filters.mode === 'QUOTE_ONLY') and.push(QUOTE_ONLY_WHERE);
  if (filters.minPriceCents !== undefined || filters.maxPriceCents !== undefined) {
    and.push({
      priceCents: {
        ...(filters.minPriceCents !== undefined ? { gte: clampCents(filters.minPriceCents) } : {}),
        ...(filters.maxPriceCents !== undefined ? { lte: clampCents(filters.maxPriceCents) } : {}),
      },
    });
  }
  return and;
}

/**
 * Category and brand counts under the current filters (keyed by slug), plus
 * whether any live listing can be bought at a visible price at all.
 * `live` is the "what a buyer can browse" rule of the listing query.
 */
export async function marketplaceFacets(filters: MarketplaceFilters, live: Prisma.ProductWhereInput) {
  const withAnd = (and: Prisma.ProductWhereInput[]): Prisma.ProductWhereInput => ({
    ...live,
    ...(and.length ? { AND: and } : {}),
  });
  const [byCategory, byBrand, categories, brands, priced] = await Promise.all([
    prisma.product.groupBy({ by: ['categoryId'], where: withAnd(filterAnd(filters, 'category')), _count: { _all: true } }),
    prisma.product.groupBy({ by: ['brandId'], where: withAnd(filterAnd(filters, 'brand')), _count: { _all: true } }),
    prisma.category.findMany({ select: { id: true, slug: true } }),
    prisma.brand.findMany({ select: { id: true, slug: true } }),
    prisma.product.count({ where: { ...live, AND: [PURCHASABLE_WHERE] } }),
  ]);
  const catSlug = new Map(categories.map((c) => [c.id, c.slug]));
  const brandSlug = new Map(brands.map((b) => [b.id, b.slug]));
  const categoryCounts = new Map<string, number>();
  for (const r of byCategory) {
    const s = catSlug.get(r.categoryId);
    if (s) categoryCounts.set(s, r._count._all);
  }
  const brandCounts = new Map<string, number>();
  for (const r of byBrand) {
    const s = r.brandId ? brandSlug.get(r.brandId) : undefined;
    if (s) brandCounts.set(s, r._count._all);
  }
  return { categoryCounts, brandCounts, hasPricedListings: priced > 0 };
}
