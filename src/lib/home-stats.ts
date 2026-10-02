import { prisma } from '@/lib/db';
import { LIVE_PRODUCT_WHERE } from '@/lib/marketplace/queries';
import type { HomeStat } from '@/lib/home-sections';

/** Live hero counts (published listings, suppliers, countries) — what the
 *  homepage shows whenever the admin hasn't typed explicit HERO_STATS. */
export async function getLiveHeroStats(): Promise<HomeStat[]> {
  // Count what a buyer can actually browse (same rule as /marketplace), and
  // only suppliers that have such a listing — not sold units or empty shops.
  const withListings = { products: { some: LIVE_PRODUCT_WHERE } };
  const [listings, suppliers, countriesRow] = await Promise.all([
    prisma.product.count({ where: LIVE_PRODUCT_WHERE }),
    prisma.company.count({ where: withListings }),
    prisma.company.findMany({
      where: { country: { not: null }, ...withListings },
      select: { country: true },
      distinct: ['country'],
    }),
  ]);
  return [
    { value: listings, suffix: '', label: listings === 1 ? 'instrument listed' : 'instruments listed' },
    { value: suppliers, suffix: '', label: suppliers === 1 ? 'supplier onboarded' : 'suppliers onboarded' },
    { value: countriesRow.length, suffix: '', label: countriesRow.length === 1 ? 'country served' : 'countries served' },
  ];
}
