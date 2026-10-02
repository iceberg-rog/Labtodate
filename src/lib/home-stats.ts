import { prisma } from '@/lib/db';
import type { HomeStat } from '@/lib/home-sections';

/** Live hero counts (published listings, suppliers, countries) — what the
 *  homepage shows whenever the admin hasn't typed explicit HERO_STATS. */
export async function getLiveHeroStats(): Promise<HomeStat[]> {
  const [listings, suppliers, countriesRow] = await Promise.all([
    prisma.product.count({ where: { status: 'PUBLISHED' } }),
    prisma.company.count(),
    prisma.company.findMany({
      where: { country: { not: null } },
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
