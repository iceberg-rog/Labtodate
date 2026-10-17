import { prisma } from '@/lib/db';
import { LIVE_PRODUCT_WHERE, getTopCategoriesWithImage } from '@/lib/marketplace/queries';
import { getCatalogPolicy } from '@/lib/catalog/policy';
import { isPlaceholderBrand } from '@/lib/catalog/jsonld';
import { firstPublicImage } from '@/lib/media/public-src';

export interface StationCategory {
  slug: string;
  name: string;
  count: number;
  image: string | null;
  brands: string[];
}

/**
 * Station 3's cards: up to nine live categories with their best real photo
 * and leading brands (facts from the catalogue; importer placeholders such
 * as "Other" left out).
 */
export async function getStationCategories(limit = 9): Promise<StationCategory[]> {
  const [categories, policy] = await Promise.all([getTopCategoriesWithImage(limit), getCatalogPolicy()]);
  return Promise.all(
    categories.map(async (c) => {
      const rows = await prisma.product.groupBy({
        by: ['brandId'],
        where: { ...LIVE_PRODUCT_WHERE, category: { slug: c.slug }, brandId: { not: null } },
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
      return { slug: c.slug, name: c.name, count: c.count, image: c.image, brands: names };
    }),
  );
}

export interface DemoProduct {
  title: string;
  brand: string;
  image: string | null;
  category: string;
}

/** A real live listing (with a photo) for the buying-panel demo — shown as sample data. */
export async function getDemoProduct(): Promise<DemoProduct | null> {
  const p = await prisma.product.findFirst({
    where: { ...LIVE_PRODUCT_WHERE, hasImages: true, title: { contains: 'HPLC', mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    select: { title: true, images: true, brand: { select: { name: true } }, category: { select: { name: true } } },
  }) ?? await prisma.product.findFirst({
    where: { ...LIVE_PRODUCT_WHERE, hasImages: true },
    orderBy: { createdAt: 'desc' },
    select: { title: true, images: true, brand: { select: { name: true } }, category: { select: { name: true } } },
  });
  if (!p) return null;
  return { title: p.title, brand: p.brand?.name ?? '', image: firstPublicImage(p.images), category: p.category.name };
}

export async function getLiveListingCount(): Promise<number> {
  return prisma.product.count({ where: LIVE_PRODUCT_WHERE });
}
