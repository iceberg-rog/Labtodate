import type { IllustrationName } from '@/components/illustrations/instruments';

export interface BlogPostItem {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  date: string;
  readMinutes: number;
  illustration: IllustrationName;
  /** Tailwind gradient classes for the cover background */
  coverGradient: string;
}

export const FEATURED_POSTS: BlogPostItem[] = [
  {
    slug: 'buying-refurbished-hplc-checklist',
    title: 'Buying refurbished HPLC: 14 things to demand from your supplier',
    excerpt:
      'Column condition, detector lamp hours, pump seals, autosampler — what to inspect before signing.',
    category: 'Buying guide',
    date: '2026-04-22',
    readMinutes: 8,
    illustration: 'hplc',
    coverGradient: 'from-[hsl(168_60%_22%)] via-[hsl(168_50%_30%)] to-[hsl(82_60%_55%)]',
  },
  {
    slug: 'mass-spec-cost-breakdown-2026',
    title: 'Mass spec total cost of ownership in 2026',
    excerpt:
      'Service contracts, consumables, and downtime — the numbers OEMs never put on the quote.',
    category: 'Cost analysis',
    date: '2026-04-15',
    readMinutes: 12,
    illustration: 'massspec',
    coverGradient: 'from-[hsl(82_55%_50%)] via-[hsl(168_55%_30%)] to-[hsl(168_70%_18%)]',
  },
  {
    slug: 'centrifuge-rotor-compatibility-guide',
    title: 'Centrifuge rotors: the cross-brand swap that voided a $80k warranty',
    excerpt:
      'Real story from a Pivot Park lab. Plus a compatibility matrix for Beckman, Eppendorf, and Thermo.',
    category: 'Technical guide',
    date: '2026-04-03',
    readMinutes: 6,
    illustration: 'centrifuge',
    coverGradient: 'from-[hsl(168_70%_18%)] via-[hsl(168_55%_30%)] to-[hsl(82_55%_50%)]',
  },
];
