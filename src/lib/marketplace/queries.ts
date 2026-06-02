import { prisma } from '@/lib/db';
import type { Prisma, ProductCondition, ProductMode } from '@prisma/client';
import { applyShopPricing, type ShopPricingMode } from '@/lib/shop-pricing';

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

export async function listProducts(filters: MarketplaceFilters = {}): Promise<MarketplaceResult> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.max(1, Math.min(60, filters.pageSize ?? DEFAULT_PAGE_SIZE));

  const where: Prisma.ProductWhereInput = {
    status: 'PUBLISHED',
    quantity: { gt: 0 },
  };

  if (filters.q) {
    where.OR = [
      { title:   { contains: filters.q, mode: 'insensitive' } },
      { summary: { contains: filters.q, mode: 'insensitive' } },
    ];
  }
  if (filters.category) where.category = { slug: filters.category };
  if (filters.brand)    where.brand    = { slug: filters.brand };
  if (filters.condition) where.condition = filters.condition;
  if (filters.mode)      where.mode = filters.mode;
  if (filters.minPriceCents !== undefined || filters.maxPriceCents !== undefined) {
    where.priceCents = {
      ...(filters.minPriceCents !== undefined ? { gte: filters.minPriceCents } : {}),
      ...(filters.maxPriceCents !== undefined ? { lte: filters.maxPriceCents } : {}),
    };
  }

  // Products with real photography always lead within any sort.
  const orderBy: Prisma.ProductOrderByWithRelationInput[] =
    filters.sort === 'price_asc'
      ? [{ hasImages: 'desc' }, { priceCents: 'asc' }]
      : filters.sort === 'price_desc'
        ? [{ hasImages: 'desc' }, { priceCents: 'desc' }]
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
        yearMade: true,
        summary: true,
        brand: { select: { name: true, slug: true } },
        category: { select: { name: true, slug: true } },
        company: { select: { name: true, slug: true, pricingMode: true, pricingMarkupBp: true } },
      },
    }),
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
  const cats = await prisma.category.findMany({
    where: { products: { some: { status: 'PUBLISHED' } } },
    select: {
      slug: true,
      name: true,
      _count: { select: { products: { where: { status: 'PUBLISHED' } } } },
    },
  });
  return cats
    .sort((a, b) => b._count.products - a._count.products)
    .slice(0, limit)
    .map((c) => ({ slug: c.slug, name: c.name, count: c._count.products }));
}

export async function getTopCategoriesWithImage(limit = 10) {
  const cats = await prisma.category.findMany({
    where: { products: { some: { status: 'PUBLISHED' } } },
    select: {
      slug: true,
      name: true,
      _count: { select: { products: { where: { status: 'PUBLISHED' } } } },
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

      let best = pool[0] ?? null;
      let bestScore = -Infinity;
      for (const p of pool) {
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
        image: best?.images?.[0] ?? null,
      };
    }),
  );
}

export async function getCategories() {
  return prisma.category.findMany({
    orderBy: { sortOrder: 'asc' },
    select: { slug: true, name: true, _count: { select: { products: { where: { status: 'PUBLISHED' } } } } },
  });
}

export async function getTopBrands(limit: number = 12) {
  // Order brands by their published product count (desc).
  const brands = await prisma.brand.findMany({
    select: { slug: true, name: true, _count: { select: { products: { where: { status: 'PUBLISHED' } } } } },
  });
  return brands
    .filter((b) => b._count.products > 0)
    .sort((a, b) => b._count.products - a._count.products)
    .slice(0, limit);
}
