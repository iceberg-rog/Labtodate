import type { Prisma } from '@prisma/client';

/**
 * Prisma's `contains` hands the value to ILIKE unescaped, so a search for
 * "%" or "_" matched every listing. Escape LIKE's wildcards (and the escape
 * character itself) so the query is matched literally.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * Free-text product match shared by the marketplace search and the header
 * typeahead, so "See all matches" lists exactly what the typeahead suggested:
 * title, summary, brand name or category name (case-insensitive, literal).
 */
export function productTextWhere(query: string): Prisma.ProductWhereInput {
  const q = escapeLike(query.trim());
  return {
    OR: [
      { title:    { contains: q, mode: 'insensitive' } },
      { summary:  { contains: q, mode: 'insensitive' } },
      { brand:    { name: { contains: q, mode: 'insensitive' } } },
      { category: { name: { contains: q, mode: 'insensitive' } } },
    ],
  };
}
