export const HOME_SECTIONS = [
  'hero',
  'trustbar',
  'categories',
  'featured',
  'suppliers',
  'blog',
  'testimonials',
  'cta',
] as const;

export type HomeSection = (typeof HOME_SECTIONS)[number];

export const HOME_SECTION_LABEL: Record<HomeSection, string> = {
  hero: 'Hero + search',
  trustbar: 'Trust bar (brands)',
  categories: 'Category grid',
  featured: 'Featured products',
  suppliers: 'Verified supply',
  blog: 'Blog teasers',
  testimonials: 'Testimonials',
  cta: 'Call to action',
};

export interface HomeStat {
  value: number;
  suffix: string;
  label: string;
}

export interface HomeContent {
  popular: string[];
  heroBadge: string;
  heroTitle: string;
  heroAccent: string;
  heroSubtitle: string;
  stats: HomeStat[];
  testHeading: string;
  testMeta: string;
  ctaHeading: string;
  ctaSubtitle: string;
}

export const HOME_DEFAULTS: HomeContent = {
  popular: ['Centrifuges', 'HPLC', 'PCR', 'Microscopes', 'Mass Spec'],
  heroBadge: 'Up to 50% off · certified refurbished',
  heroTitle: 'The marketplace for',
  heroAccent: 'science.',
  heroSubtitle:
    'Source new & certified-refurbished laboratory equipment from vetted suppliers worldwide — quote to delivery in days, not months.',
  stats: [
    { value: 12400, suffix: '+', label: 'instruments listed' },
    { value: 840, suffix: '+', label: 'verified suppliers' },
    { value: 95, suffix: '+', label: 'countries served' },
  ],
  testHeading: 'Loved by people who buy expensive things.',
  testMeta: '4.9 / 5 · 410+ verified buyers',
  ctaHeading: 'Discontinued. Rare. Out of budget. We find it.',
  ctaSubtitle:
    "Tell our sourcing team what you need. We'll come back with vetted quotes from up to 8 suppliers — typically within 5 business days.",
};

/** Parse "12400|+|instruments listed" lines; fall back to defaults. */
function parseStats(raw: string | undefined): HomeStat[] {
  if (!raw) return HOME_DEFAULTS.stats;
  const out: HomeStat[] = [];
  for (const line of raw.split('\n')) {
    const [v, suf, ...rest] = line.split('|');
    const value = parseInt((v || '').replace(/[^0-9]/g, ''), 10);
    const label = rest.join('|').trim();
    if (Number.isFinite(value) && label) out.push({ value, suffix: (suf || '').trim(), label });
  }
  return out.length ? out : HOME_DEFAULTS.stats;
}

/** Read homepage content from process.env (call ensureSettingsLoaded first). */
export function getHomeContent(): HomeContent {
  const d = HOME_DEFAULTS;
  const popular = (process.env.HOMEPAGE_POPULAR || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    popular: popular.length ? popular : d.popular,
    heroBadge: process.env.HERO_BADGE?.trim() || d.heroBadge,
    heroTitle: process.env.HERO_TITLE?.trim() || d.heroTitle,
    heroAccent: process.env.HERO_ACCENT?.trim() || d.heroAccent,
    heroSubtitle: process.env.HERO_SUBTITLE?.trim() || d.heroSubtitle,
    stats: parseStats(process.env.HERO_STATS),
    testHeading: process.env.TEST_HEADING?.trim() || d.testHeading,
    testMeta: process.env.TEST_META?.trim() || d.testMeta,
    ctaHeading: process.env.CTA_HEADING?.trim() || d.ctaHeading,
    ctaSubtitle: process.env.CTA_SUBTITLE?.trim() || d.ctaSubtitle,
  };
}
