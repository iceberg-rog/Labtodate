/**
 * Search provider abstraction.
 *
 * Default: Postgres ILIKE (works out of the box, no external service).
 * Future: swap in Algolia by implementing `SearchProvider` and exporting
 * a new singleton from this file.
 */

import { prisma } from '@/lib/db';
import { productTextWhere } from '@/lib/search/where';
import { firstPublicImage } from '@/lib/media/public-src';

export interface SearchHit {
  slug: string;
  title: string;
  brand: string | null;
  category: string;
  /** Our own photo of the unit ("/media/…"), or null — never a generic drawing. */
  image: string | null;
  priceCents: number | null;
  currency: string;
  condition: string;
}

export interface SearchProvider {
  typeahead(query: string, limit?: number): Promise<SearchHit[]>;
}

class PostgresSearchProvider implements SearchProvider {
  async typeahead(query: string, limit = 6): Promise<SearchHit[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    const rows = await prisma.product.findMany({
      // Same text match as the marketplace `q` filter (listProducts), so every
      // hit shown here is also on the "See all matches" page.
      where: {
        status: 'PUBLISHED',
        quantity: { gt: 0 },
        ...productTextWhere(q),
      },
      take: limit,
      // A08: only the PUBLIC sell price (null for quote-only / hidden prices).
      orderBy: [{ displayPriceCents: { sort: 'asc', nulls: 'last' } }],
      select: {
        slug: true,
        title: true,
        images: true,
        displayPriceCents: true,
        currency: true,
        condition: true,
        brand: { select: { name: true } },
        category: { select: { name: true } },
      },
    });

    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      brand: r.brand?.name ?? null,
      category: r.category.name,
      image: firstPublicImage(r.images),
      priceCents: r.displayPriceCents,
      currency: r.currency,
      condition: r.condition,
    }));
  }
}

export const searchProvider: SearchProvider = new PostgresSearchProvider();
