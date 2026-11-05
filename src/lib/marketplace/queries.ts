import { prisma } from '@/lib/db';
import type { Prisma, ProductCondition, ProductMode } from '@prisma/client';
import { applyShopPricing, type ShopPricingMode } from '@/lib/shop-pricing';
import { productTextWhere } from '@/lib/search/where';
import { pickCardImage } from '@/lib/card-image-pick';
import { liveProductWhere } from '@/lib/inventory/public';

export interface MarketplaceFilters {
  q?: string;
  category?: string;       // slug
  brand?: string;          // slug
  condition?: ProductCondition;
  mode?: ProductMode;
  minPriceCents?: number;
  maxPriceCents?: number;
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'relevance';
  page?: number;
  pageSize?: number;
}

export interface MarketplaceResult {
  items: Array<{
    slug: string;
    title: string;
    illustration: string | null;
    images: string[];
    condition: ProductCondition;
    mode: ProductMode;
    priceCents: number | null;
    currency: string;
    yearMade: number | null;
    summary: string | null;
    priceHidden: boolean;
    /** False when nothing is available (only listed with the zero-stock rule "label"). */
    inStock: boolean;
    brand: { name: string; slug: string } | null;
    category: { name: string; slug: string };
    company: { name: string; slug: string } | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const DEFAULT_PAGE_SIZE = 24;

/**
 * What a buyer can browse: the same rule for listings, facets and headline
 * counts. Whether an item with nothing available stays listed is the inventory
 * setting "When an item has nothing available" (src/lib/inventory/public.ts).
 */
export { liveProductWhere };

/**
 * Listings that show a Buy now button: a buyable mode with a price that the
 * shop's pricing rule doesn't hide (see applyShopPricing + the product page).
 * Imports are HYBRID, so matching `mode = BUY_NOW` alone returned nothing.
 */
export const PURCHASABLE_WHERE: Prisma.ProductWhereInput = {
  mode: { in: ['BUY_NOW', 'HYBRID'] },
  priceCents: { gt: 0 },
  OR: [{ companyId: null }, { company: { pricingMode: { in: ['PASS_THROUGH', 'MARKUP_PERCENT'] } } }],
};

/** Everything a buyer has to request a quote for (the complement of the above). */
export const QUOTE_ONLY_WHERE: Prisma.ProductWhereInput = {
  OR: [
    { mode: 'QUOTE_ONLY' },
    { priceCents: null },
    { priceCents: { lte: 0 } },
    { company: { pricingMode: { in: ['FORCE_QUOTE', 'HIDE_PRICE'] } } },
  ],
};

/** Product.priceCents is a Postgres INT4; larger bounds made Prisma throw (500). */
const INT4_MAX = 2_147_483_647;
const clampCents = (n: number) => Math.min(INT4_MAX, Math.max(0, Math.round(n)));

export async function listProducts(filters: MarketplaceFilters = {}): Promise<MarketplaceResult> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.max(1, Math.min(60, filters.pageSize ?? DEFAULT_PAGE_SIZE));

  // Conditions are ANDed so the text, mode and price filters can't overwrite
  // each other's OR / priceCents keys.
  const and: Prisma.ProductWhereInput[] = [];
  if (filters.q?.trim()) and.push(productTextWhere(filters.q));
  if (filters.category) and.push({ category: { slug: filters.category } });
  if (filters.brand)    and.push({ brand: { slug: filters.brand } });
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
  const live = await liveProductWhere();
  const where: Prisma.ProductWhereInput = { ...live, ...(and.length ? { AND: and } : {}) };
  // When sold-out items stay listed, they follow every available one (in any sort).
  const splitByStock = !('quantity' in live);

  // Products with real photography always lead within any sort. Quote-only
  // items have no price: keep them after the priced ones in both directions
  // (Postgres puts NULLs first on DESC, which filled "high → low" with them).
  const orderBy: Prisma.ProductOrderByWithRelationInput[] =
    filters.sort === 'price_asc'
      ? [{ hasImages: 'desc' }, { priceCents: { sort: 'asc', nulls: 'last' } }]
      : filters.sort === 'price_desc'
        ? [{ hasImages: 'desc' }, { priceCents: { sort: 'desc', nulls: 'last' } }]
        : [{ hasImages: 'desc' }, { createdAt: 'desc' }];

  const select = {
    slug: true,
    title: true,
    illustration: true,
    images: true,
    condition: true,
    mode: true,
    priceCents: true,
    currency: true,
    yearMade: true,
    summary: true,
    quantity: true,
    brand: { select: { name: true, slug: true } },
    category: { select: { name: true, slug: true } },
    company: { select: { name: true, slug: true, pricingMode: true, pricingMarkupBp: true } },
  } satisfies Prisma.ProductSelect;
  const offset = (page - 1) * pageSize;
  const pageItems = async () => {
    if (!splitByStock) return prisma.product.findMany({ where, orderBy, skip: offset, take: pageSize, select });
    const inStockWhere: Prisma.ProductWhereInput = { AND: [where, { quantity: { gt: 0 } }] };
    const soldOutWhere: Prisma.ProductWhereInput = { AND: [where, { quantity: { lte: 0 } }] };
    const inStockCount = await prisma.product.count({ where: inStockWhere });
    const first = offset < inStockCount
      ? await prisma.product.findMany({ where: inStockWhere, orderBy, skip: offset, take: pageSize, select })
      : [];
    const remaining = pageSize - first.length;
    if (remaining <= 0) return first;
    const rest = await prisma.product.findMany({
      where: soldOutWhere,
      orderBy,
      skip: Math.max(0, offset - inStockCount),
      take: remaining,
      select,
    });
    return [...first, ...rest];
  };

  const [items, total] = await Promise.all([
    pageItems(),
    prisma.product.count({ where }),
  ]);

  const adjusted = items.map((p) => {
    const dp = applyShopPricing(
      { priceCents: p.priceCents, currency: p.currency, mode: p.mode },
      p.company ? { pricingMode: p.company.pricingMode as ShopPricingMode, pricingMarkupBp: p.company.pricingMarkupBp } : null,
    );
    return {
      slug: p.slug,
      title: p.title,
      illustration: p.illustration,
      images: p.images,
      condition: p.condition,
      mode: dp.mode,
      priceCents: dp.priceCents,
      currency: dp.currency,
      yearMade: p.yearMade,
      summary: p.summary,
      priceHidden: dp.priceHidden,
      inStock: p.quantity > 0,
      brand: p.brand,
      category: p.category,
      company: p.company ? { name: p.company.name, slug: p.company.slug } : null,
    };
  });

  return {
    items: adjusted,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** How many live listings `/marketplace?q=<query>` would show. */
export async function countSearchMatches(query: string): Promise<number> {
  if (!query.trim()) return 0;
  const live = await liveProductWhere();
  return prisma.product.count({ where: { ...live, ...productTextWhere(query) } });
}

export async function getProductBySlug(slug: string) {
  const product = await prisma.product.findUnique({
    where: { slug },
    include: {
      brand: true,
      category: true,
      company: true,
      seller: { select: { name: true, email: true } },
    },
  });
  if (!product) return null;
  const dp = applyShopPricing(
    { priceCents: product.priceCents, currency: product.currency, mode: product.mode },
    product.company ? { pricingMode: product.company.pricingMode as ShopPricingMode, pricingMarkupBp: product.company.pricingMarkupBp } : null,
  );
  // Override visible price/mode but leave the raw fields intact for admin views.
  return {
    ...product,
    priceCents: dp.priceCents,
    mode: dp.mode,
    priceHidden: dp.priceHidden,
    // Preserve the unadjusted base in case the consumer needs it.
    basePriceCents: product.priceCents,
    baseMode: product.mode,
  };
}

export async function getSimilarProducts(categoryId: string, excludeSlug: string, take = 4) {
  return prisma.product.findMany({
    where: {
      categoryId,
      status: 'PUBLISHED',
      quantity: { gt: 0 },
      slug: { not: excludeSlug },
    },
    orderBy: [{ hasImages: 'desc' }, { createdAt: 'desc' }],
    take,
    select: {
      slug: true, title: true, illustration: true, images: true,
      condition: true, mode: true, priceCents: true, currency: true, yearMade: true,
      brand: { select: { name: true } },
      company: { select: { name: true } },
    },
  });
}

export async function getTopCategories(limit = 10) {
  const live = await liveProductWhere();
  const cats = await prisma.category.findMany({
    where: { products: { some: live } },
    select: {
      slug: true,
      name: true,
      _count: { select: { products: { where: live } } },
    },
  });
  return cats
    .sort((a, b) => b._count.products - a._count.products)
    .slice(0, limit)
    .map((c) => ({ slug: c.slug, name: c.name, count: c._count.products }));
}

export async function getTopCategoriesWithImage(limit = 10) {
  const live = await liveProductWhere();
  const cats = await prisma.category.findMany({
    where: { products: { some: live } },
    select: {
      slug: true,
      name: true,
      _count: { select: { products: { where: live } } },
    },
  });
  const top = cats
    .sort((a, b) => b._count.products - a._count.products)
    .slice(0, limit);

  // Words that signal a tiny, unrepresentative component close-up.
  const BAD =
    /\b(board|pcb|fan|fuse|cable|seal|o-?ring|gasket|kit|screw|lamp|bulb|filter|tubing|fitting|spring|washer|ferrule|frit|plunger|piston|sensor|chip|relay|nut|bolt|connector|adapter|bracket|cover|knob|switch|\bled\b|battery|belt|wire|fuses?|capillary|needle|septa|septum|vial|holder|clip|spacer|insert|rotor seal)\b/i;
  // Words that signal a recognisable instrument / sub-system.
  const GOOD =
    /\b(system|instrument|module|detector|pump|autosampler|sampler|injector|oven|analy[sz]er|spectromet|chromatograph|\bhplc\b|\bgc\b|\blc\b|\bms\b|degasser|controller|unit|interface|source|generator|column compartment|monochromator|lamp house|stage|microscope|centrifuge|reader|incubator)\b/i;

  return Promise.all(
    top.map(async (c) => {
      const pool = await prisma.product.findMany({
        where: { category: { slug: c.slug }, status: 'PUBLISHED', hasImages: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { title: true, images: true },
      });

      const ranked = pool
        .map((p) => {
          let score = Math.min(p.images.length, 4); // more photos ≈ a feature listing
          if (GOOD.test(p.title)) score += 6;
          if (BAD.test(p.title)) score -= 6;
          if (c.name.length > 3 && p.title.toLowerCase().includes(c.name.toLowerCase())) score += 4;
          return { score, image: p.images.find((u) => /^https:\/\/|^\//.test(u)) ?? null };
        })
        .sort((a, b) => b.score - a.score)
        .map((r) => r.image)
        .filter((u): u is string => !!u);

      // Always surface the best available real photo for the category. The
      // scoring above already prefers full-system instrument shots over
      // tiny-part close-ups; for a parts category a part photo is fine. Among
      // the best-ranked, one with enough pixels for the homepage's card wins.
      return {
        slug: c.slug,
        name: c.name,
        count: c._count.products,
        image: pickCardImage(ranked.slice(0, 10), ranked[0] ?? null),
      };
    }),
  );
}

export async function getCategories() {
  const live = await liveProductWhere();
  return prisma.category.findMany({
    orderBy: { sortOrder: 'asc' },
    select: { slug: true, name: true, _count: { select: { products: { where: live } } } },
  });
}

export async function getTopBrands(limit: number = 12) {
  const live = await liveProductWhere();
  // Order brands by their live (published, in-stock) product count (desc).
  const brands = await prisma.brand.findMany({
    select: { slug: true, name: true, _count: { select: { products: { where: live } } } },
  });
  return brands
    .filter((b) => b._count.products > 0)
    .sort((a, b) => b._count.products - a._count.products)
    .slice(0, limit);
}
