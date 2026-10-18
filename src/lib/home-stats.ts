import { prisma } from '@/lib/db';
import { LIVE_PRODUCT_WHERE } from '@/lib/marketplace/queries';
import { homeField, parsePairs, type HomeStat } from '@/lib/home-sections';

/** The live counts behind the hero stats: published listings, onboarded suppliers, countries. */
export interface LiveCounts {
  listings: number;
  suppliers: number;
  countries: number;
}

export async function getLiveCounts(): Promise<LiveCounts> {
  // Count what a buyer can actually browse (same rule as /marketplace), and
  // only suppliers that have such a listing — not sold units or empty shops.
  // A supplier is "onboarded" only with a signed agreement (Admin → Shops).
  const withListings = { products: { some: LIVE_PRODUCT_WHERE } };
  const [listings, suppliers, countriesRow] = await Promise.all([
    prisma.product.count({ where: LIVE_PRODUCT_WHERE }),
    prisma.company.count({ where: { agreementStatus: 'SIGNED', ...withListings } }),
    prisma.company.findMany({
      where: { country: { not: null }, ...withListings },
      select: { country: true },
      distinct: ['country'],
    }),
  ]);
  return { listings, suppliers, countries: countriesRow.length };
}

/**
 * The counts as hero stats, labelled with Admin → Homepage “Labels of the live
 * counts” (singular|plural per line). A stat that would read 0 is not shown.
 */
export function liveStats(c: LiveCounts, labels: readonly [string, string][] = parsePairs(homeField('HOME_STAT_LABELS')!.default)): HomeStat[] {
  const label = (i: number, n: number) => {
    const [one = '', many = ''] = labels[i] ?? [];
    return (n === 1 ? one || many : many || one).trim();
  };
  const stats: HomeStat[] = [
    { value: c.listings, suffix: '', label: label(0, c.listings) },
    { value: c.suppliers, suffix: '', label: label(1, c.suppliers) },
    { value: c.countries, suffix: '', label: label(2, c.countries) },
  ];
  return stats.filter((s) => s.value > 0 && s.label);
}

/** Live hero counts (published listings, suppliers, countries) — what the
 *  homepage shows whenever the admin hasn't typed explicit HERO_STATS. */
export async function getLiveHeroStats(labels?: readonly [string, string][]): Promise<HomeStat[]> {
  return liveStats(await getLiveCounts(), labels);
}
