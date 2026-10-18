import type { ProductCondition, ProductMode } from '@prisma/client';
import { prisma } from '@/lib/db';
import { LIVE_PRODUCT_WHERE, getTopCategoriesWithImage, listProducts } from '@/lib/marketplace/queries';
import { getCatalogPolicy } from '@/lib/catalog/policy';
import { isPlaceholderBrand } from '@/lib/catalog/jsonld';
import { firstPublicImage, ownMediaPath } from '@/lib/media/public-src';
import { SELL_PRICE_SELECT, sellPriceOf } from '@/lib/pricing/server';
import { isCategoryIcon } from '@/lib/home/category-icons';
import type { HomeCategoryItem } from '@/lib/home-sections';

declare global {
  var __homeLandingGen: number | undefined;
}

/**
 * The homepage's live data is computed at most once a minute and served from
 * memory meanwhile (src/app/page.tsx, stale-cache). A category or homepage edit
 * bumps this generation, which is part of every cache key, so the next request
 * computes fresh data instead of serving the old names for another minute or
 * two. Kept on globalThis: the server action and the page may run in separate
 * copies of this module.
 */
export function invalidateHomeLanding(): void {
  globalThis.__homeLandingGen = (globalThis.__homeLandingGen ?? 0) + 1;
}
export function homeLandingGen(): number {
  return globalThis.__homeLandingGen ?? 0;
}

export interface StationCategory {
  slug: string;
  name: string;
  count: number;
  image: string | null;
  brands: string[];
  /** Icon name from the fixed set (Category.icon), or null. */
  icon: string | null;
  /** Where the card and the list item lead: the category page, or the chosen listing. */
  href: string;
}

const categoryHref = (slug: string) => `/marketplace?category=${encodeURIComponent(slug)}`;

/** Live listings by slug → their first own photo (a sold or hidden listing is not in the map). */
async function liveProducts(slugs: string[]): Promise<Map<string, { image: string | null }>> {
  if (!slugs.length) return new Map();
  const rows = await prisma.product.findMany({ where: { ...LIVE_PRODUCT_WHERE, slug: { in: slugs } }, select: { slug: true, images: true } });
  return new Map(rows.map((r) => [r.slug, { image: firstPublicImage(r.images) }]));
}

/**
 * Station 3's cards and list. With items chosen in Admin → Homepage: exactly
 * those categories, in that order, with their label, image and link. Without:
 * the categories marked “show on homepage”, in their homepage order, then by
 * live listings (at most `max`). A category without live listings is never
 * shown (its card would open an empty page). The picture is the item's image,
 * else the category's own (Category.imageUrl), else its best listing photo;
 * the leading brands come from the catalogue (importer placeholders left out).
 * `photos: false` skips the photo search (the admin only lists the names).
 */
export async function getStationCategories(items: readonly HomeCategoryItem[], max = 9, { photos = true } = {}): Promise<StationCategory[]> {
  const [all, policy] = await Promise.all([
    prisma.category.findMany({
      select: { slug: true, name: true, icon: true, imageUrl: true, showOnHome: true, homeOrder: true, _count: { select: { products: { where: LIVE_PRODUCT_WHERE } } } },
    }),
    getCatalogPolicy(),
  ]);
  const bySlug = new Map(all.map((c) => [c.slug, c]));
  type Pick = { cat: (typeof all)[number]; item: HomeCategoryItem | null };
  let picked: Pick[] = items.flatMap((item) => {
    const cat = bySlug.get(item.slug);
    return cat && cat._count.products > 0 ? [{ cat, item }] : [];
  });
  // (none of the chosen ones has live listings any more: the automatic choice rather than an empty station)
  if (!picked.length) {
    picked = all
      .filter((c) => c.showOnHome && c._count.products > 0)
      .sort((a, b) => (a.homeOrder ?? Infinity) - (b.homeOrder ?? Infinity) || b._count.products - a._count.products || a.name.localeCompare(b.name))
      .slice(0, Math.max(1, max))
      .map((cat) => ({ cat, item: null }));
  }
  if (!picked.length) return [];

  // Listings named by an item (its photo, its page): only live ones count.
  const productSlugs = picked.flatMap(({ item }) => [
    ...(item?.image.kind === 'product' ? [item.image.slug] : []),
    ...(item?.link.kind === 'product' ? [item.link.slug] : []),
  ]);
  const live = await liveProducts([...new Set(productSlugs)]);
  const ownImage = (p: Pick): string | null => {
    const im = p.item?.image;
    if (im?.kind === 'url') return ownMediaPath(im.value);
    if (im?.kind === 'product') return live.get(im.slug)?.image ?? null;
    return ownMediaPath(p.cat.imageUrl);
  };
  const needAuto = photos && picked.some((p) => !ownImage(p));
  const auto = needAuto ? new Map((await getTopCategoriesWithImage(all.length)).map((c) => [c.slug, c.image])) : new Map<string, string | null>();

  return Promise.all(
    picked.map(async (p) => {
      const rows = await prisma.product.groupBy({
        by: ['brandId'],
        where: { ...LIVE_PRODUCT_WHERE, category: { slug: p.cat.slug }, brandId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { brandId: 'desc' } },
        take: 6,
      });
      const ids = rows.map((r) => r.brandId).filter((v): v is string => !!v);
      const brands = ids.length ? await prisma.brand.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } }) : [];
      const names = ids
        .map((id) => brands.find((b) => b.id === id))
        .filter((b): b is NonNullable<typeof b> => !!b && !isPlaceholderBrand(b, policy.placeholderBrands))
        .map((b) => b.name)
        .slice(0, 3);
      const link = p.item?.link;
      const href = link?.kind === 'product' && live.has(link.slug) ? `/marketplace/${encodeURIComponent(link.slug)}` : categoryHref(p.cat.slug);
      return {
        slug: p.cat.slug,
        name: p.item?.label || p.cat.name,
        count: p.cat._count.products,
        image: ownImage(p) ?? auto.get(p.cat.slug) ?? null,
        brands: names,
        icon: isCategoryIcon(p.cat.icon) ? p.cat.icon : null,
        href,
      };
    }),
  );
}

export interface DemoProduct {
  title: string;
  brand: string;
  image: string | null;
  category: string;
}

/** The live listing the buying-panel demo shows as sample data: the chosen one, else the newest live listing with a photo. */
export async function getDemoProduct(slug = ''): Promise<DemoProduct | null> {
  const select = { title: true, images: true, brand: { select: { name: true } }, category: { select: { name: true } } } as const;
  const chosen = slug ? await prisma.product.findFirst({ where: { ...LIVE_PRODUCT_WHERE, slug }, select }) : null;
  const p = chosen ?? (await prisma.product.findFirst({ where: { ...LIVE_PRODUCT_WHERE, hasImages: true }, orderBy: { createdAt: 'desc' }, select }));
  if (!p) return null;
  return { title: p.title, brand: p.brand?.name ?? '', image: firstPublicImage(p.images), category: p.category.name };
}

export interface FeaturedProduct {
  slug: string;
  title: string;
  brand: string;
  illustration: string | null;
  imageUrl: string | null;
  condition: ProductCondition;
  mode: ProductMode;
  priceCents: number | null;
  currency: string;
  vatScheme: 'STANDARD' | 'MARGIN';
  yearMade: number | null;
}

/** The featured module's cards: the chosen live listings in their order (sold or hidden ones left out), else the eight newest. */
export async function getFeaturedProducts(slugs: readonly string[]): Promise<FeaturedProduct[]> {
  if (!slugs.length) {
    const { items } = await listProducts({ pageSize: 8, sort: 'newest' });
    return items.map((p) => ({
      slug: p.slug, title: p.title, brand: p.brand?.name ?? '—', illustration: p.illustration, imageUrl: firstPublicImage(p.images),
      condition: p.condition, mode: p.mode, priceCents: p.priceCents, currency: p.currency, vatScheme: p.vatScheme, yearMade: p.yearMade,
    }));
  }
  const rows = await prisma.product.findMany({
    where: { ...LIVE_PRODUCT_WHERE, slug: { in: [...slugs] } },
    select: {
      ...SELL_PRICE_SELECT, slug: true, title: true, illustration: true, images: true, condition: true, vatScheme: true, yearMade: true,
      brand: { select: { name: true } },
    },
  });
  const order = new Map(slugs.map((s, i) => [s, i]));
  return rows
    .sort((a, b) => (order.get(a.slug) ?? 99) - (order.get(b.slug) ?? 99))
    .map((p) => {
      const r = sellPriceOf(p);
      return {
        slug: p.slug, title: p.title, brand: p.brand?.name ?? '—', illustration: p.illustration, imageUrl: firstPublicImage(p.images),
        condition: p.condition, mode: r.mode as ProductMode, priceCents: r.sellPriceCents, currency: p.currency, vatScheme: p.vatScheme, yearMade: p.yearMade,
      };
    });
}

export async function getLiveListingCount(): Promise<number> {
  return prisma.product.count({ where: LIVE_PRODUCT_WHERE });
}
