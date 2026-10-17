import { prisma } from '@/lib/db';
import type { Prisma, ProductCondition, ProductMode } from '@prisma/client';
import { sellPriceOf } from '@/lib/pricing/server';
import { shownToNetCents, type PriceDisplaySettings } from '@/lib/pricing/display';
import { productTextWhere } from '@/lib/search/where';
import { firstPublicImage } from '@/lib/media/public-src';

export interface MarketplaceFilters {
  q?: string;
  category?: string;       // slug
  brand?: string;          // slug
  condition?: ProductCondition;
  mode?: ProductMode;
  /** Bounds as the buyer typed them (shown basis — see PRICE_DISPLAY_MODE). */
  minPriceCents?: number;
  maxPriceCents?: number;
  /** Needed to read the bounds in the shown basis (incl. VAT → net). */
  display?: Pick<PriceDisplaySettings, 'mode' | 'standardRateBp'>;
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
    /** The SELL price (shop rule applied) — never the supplier price; null = quote only / hidden. */
    priceCents: number | null;
    currency: string;
    yearMade: number | null;
    summary: string | null;
    priceHidden: boolean;
    vatScheme: 'STANDARD' | 'MARGIN';
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

/** What a buyer can browse: the same rule for listings, facets and headline counts. */
export const LIVE_PRODUCT_WHERE = {
  status: 'PUBLISHED',
  quantity: { gt: 0 },
} satisfies Prisma.ProductWhereInput;

/**
 * Listings that show a Buy now button: a buyable mode with a public sell price.
 * Product.displayPriceCents is the resolver's sell price (null when the shop
 * forces quotes or hides prices) — kept in sync by a DB trigger (migration 7a).
 * Imports are HYBRID, so matching `mode = BUY_NOW` alone returned nothing.
 */
const PURCHASABLE_WHERE: Prisma.ProductWhereInput = {
  mode: { in: ['BUY_NOW', 'HYBRID'] },
  displayPriceCents: { gt: 0 },
};

/** Everything a buyer has to request a quote for (the complement of the above). */
const QUOTE_ONLY_WHERE: Prisma.ProductWhereInput = {
  OR: [{ mode: 'QUOTE_ONLY' }, { displayPriceCents: null }],
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
  // A08: price filters run on the PUBLIC sell price only. A hidden / quote-only
  // listing has no public price (NULL) and never matches a price range — its
  // supplier price can't be found by narrowing the range.
  if (filters.minPriceCents !== undefined || filters.maxPriceCents !== undefined) {
    const d = filters.display ?? { mode: 'EXCL' as const, standardRateBp: 0 };
    and.push({
      displayPriceCents: {
        not: null,
        ...(filters.minPriceCents !== undefined ? { gte: clampCents(shownToNetCents(filters.minPriceCents, d, 'floor')) } : {}),
        ...(filters.maxPriceCents !== undefined ? { lte: clampCents(shownToNetCents(filters.maxPriceCents, d, 'ceil')) } : {}),
      },
    });
  }
  const where: Prisma.ProductWhereInput = { ...LIVE_PRODUCT_WHERE, ...(and.length ? { AND: and } : {}) };

  // Products with real photography always lead within any sort. Quote-only
  // items have no price: keep them after the priced ones in both directions
  // (Postgres puts NULLs first on DESC, which filled "high → low" with them).
  const orderBy: Prisma.ProductOrderByWithRelationInput[] =
    filters.sort === 'price_asc'
      ? [{ hasImages: 'desc' }, { displayPriceCents: { sort: 'asc', nulls: 'last' } }]
      : filters.sort === 'price_desc'
        ? [{ hasImages: 'desc' }, { displayPriceCents: { sort: 'desc', nulls: 'last' } }]
        : [{ hasImages: 'desc' }, { createdAt: 'desc' }];

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        slug: true,
        title: true,
        illustration: true,
        images: true,
        condition: true,
        mode: true,
        priceCents: true,
        currency: true,
        priceOnHold: true,
        yearMade: true,
        summary: true,
        vatScheme: true,
        brand: { select: { name: true, slug: true } },
        category: { select: { name: true, slug: true } },
        company: { select: { name: true, slug: true, pricingMode: true, pricingMarkupBp: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);

  const adjusted = items.map((p) => {
    const r = sellPriceOf(p);
    return {
      slug: p.slug,
      title: p.title,
      illustration: p.illustration,
      images: p.images,
      condition: p.condition,
      mode: r.mode as ProductMode,
      priceCents: r.sellPriceCents,
      currency: p.currency,
      yearMade: p.yearMade,
      summary: p.summary,
      priceHidden: !r.priceVisible,
      vatScheme: p.vatScheme,
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
  return prisma.product.count({ where: { ...LIVE_PRODUCT_WHERE, ...productTextWhere(query) } });
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
  const r = sellPriceOf(product);
  // Public view: the SELL price and the effective mode (FORCE_QUOTE / HIDE_PRICE
  // → quote only). The supplier price stays only in basePriceCents for the
  // server (never rendered to buyers).
  return {
    ...product,
    priceCents: r.sellPriceCents,
    mode: r.mode as ProductMode,
    priceHidden: !r.priceVisible,
    buyable: r.buyable,
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
      condition: true, mode: true, displayPriceCents: true, currency: true, yearMade: true, vatScheme: true,
      brand: { select: { name: true } },
      company: { select: { name: true } },
    },
  }).then((rows) => rows.map(({ displayPriceCents, ...r }) => ({ ...r, priceCents: displayPriceCents })));
}

export async function getTopCategories(limit = 10) {
  const cats = await prisma.category.findMany({
    where: { products: { some: LIVE_PRODUCT_WHERE } },
    select: {
      slug: true,
      name: true,
      _count: { select: { products: { where: LIVE_PRODUCT_WHERE } } },
    },
  });
  return cats
    .sort((a, b) => b._count.products - a._count.products)
    .slice(0, limit)
    .map((c) => ({ slug: c.slug, name: c.name, count: c._count.products }));
}

export async function getTopCategoriesWithImage(limit = 10) {
  const cats = await prisma.category.findMany({
    where: { products: { some: LIVE_PRODUCT_WHERE } },
    select: {
      slug: true,
      name: true,
      _count: { select: { products: { where: LIVE_PRODUCT_WHERE } } },
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

      // Only our own photos qualify (never a hotlinked supplier image).
      const owned = pool.filter((p) => firstPublicImage(p.images));
      let best = owned[0] ?? null;
      let bestScore = -Infinity;
      for (const p of owned) {
        let score = Math.min(p.images.length, 4); // more photos ≈ a feature listing
        if (GOOD.test(p.title)) score += 6;
        if (BAD.test(p.title)) score -= 6;
        if (c.name.length > 3 && p.title.toLowerCase().includes(c.name.toLowerCase())) score += 4;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }

      // Always surface the best available real photo for the category. The
      // scoring above already prefers full-system instrument shots over
      // tiny-part close-ups; for a parts category a part photo is fine.
      return {
        slug: c.slug,
        name: c.name,
        count: c._count.products,
        image: best ? firstPublicImage(best.images) : null,
      };
    }),
  );
}

export async function getCategories() {
  return prisma.category.findMany({
    orderBy: { sortOrder: 'asc' },
    select: { slug: true, name: true, _count: { select: { products: { where: LIVE_PRODUCT_WHERE } } } },
  });
}

export async function getTopBrands(limit: number = 12) {
  // Order brands by their live (published, in-stock) product count (desc).
  const brands = await prisma.brand.findMany({
    select: { slug: true, name: true, _count: { select: { products: { where: LIVE_PRODUCT_WHERE } } } },
  });
  return brands
    .filter((b) => b._count.products > 0)
    .sort((a, b) => b._count.products - a._count.products)
    .slice(0, limit);
}
