/**
 * Search provider abstraction.
 *
 * Default: Postgres ILIKE (works out of the box, no external service).
 * Future: swap in Algolia by implementing `SearchProvider` and exporting
 * a new singleton from this file.
 */

import { prisma } from '@/lib/db';
import { productTextWhere } from '@/lib/search/where';
import type { IllustrationName } from '@/components/illustrations/instruments';

export interface SearchHit {
  slug: string;
  title: string;
  brand: string | null;
  category: string;
  illustration: IllustrationName;
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
      orderBy: [{ priceCents: 'asc' }],
      select: {
        slug: true,
        title: true,
        illustration: true,
        priceCents: true,
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
      illustration: (r.illustration ?? 'balance') as IllustrationName,
      priceCents: r.priceCents,
      currency: r.currency,
      condition: r.condition,
    }));
  }
}

export const searchProvider: SearchProvider = new PostgresSearchProvider();
