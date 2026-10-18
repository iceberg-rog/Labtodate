import type { MetadataRoute } from 'next';

/**
 * The sitemap (src/app/sitemap.ts), built from what the database says — pure,
 * unit-tested in sitemap.test.ts. Rules:
 *  - only pages with content: live listings (published and in stock — what
 *    the marketplace links to; a sold unit's page is no longer linked),
 *    categories with live listings, section pages with published items;
 *  - every real static page (about, FAQ, contact, support, legal pages);
 *  - lastmod is the date the content changed, never the time of the request:
 *    a listing's last change, a list page's newest item, an editable page's
 *    last saved text (Settings). Without such a date, no lastmod at all.
 */

type Dated = { slug: string; updatedAt: Date };

export interface SitemapData {
  base: string;
  /** Live listings (LIVE_PRODUCT_WHERE). */
  products: Array<Dated & { categoryId: string }>;
  /** Categories with at least one live listing. */
  categories: Array<Dated & { id: string }>;
  posts: Dated[];
  articles: Dated[];
  cases: Dated[];
  facilities: Dated[];
  /** When the setting behind an editable page was last saved (Setting.updatedAt), by key. */
  textSavedAt: Partial<Record<(typeof SITEMAP_TEXT_KEYS)[number], Date>>;
}

/** Settings whose text is a public page (their last save is that page's lastmod). */
export const SITEMAP_TEXT_KEYS = ['ABOUT_PAGE_TEXT', 'FAQ_TEXT', 'LEGAL_TERMS_TEXT', 'PRIVACY_POLICY_TEXT', 'COOKIE_POLICY_TEXT'] as const;

function newest(dates: Array<Date | null | undefined>): Date | undefined {
  let out: Date | undefined;
  for (const d of dates) if (d && (!out || d.getTime() > out.getTime())) out = d;
  return out;
}

type Entry = MetadataRoute.Sitemap[number];

function entry(url: string, lastModified: Date | undefined, changeFrequency: Entry['changeFrequency'], priority: number): Entry {
  return lastModified ? { url, lastModified, changeFrequency, priority } : { url, changeFrequency, priority };
}

export function buildSitemap(d: SitemapData): MetadataRoute.Sitemap {
  const B = d.base.replace(/\/+$/, '');
  const listingsChanged = newest(d.products.map((p) => p.updatedAt));
  const byCategory = new Map<string, Date>();
  for (const p of d.products) {
    const seen = byCategory.get(p.categoryId);
    if (!seen || p.updatedAt > seen) byCategory.set(p.categoryId, p.updatedAt);
  }
  const t = d.textSavedAt;

  const pages: MetadataRoute.Sitemap = [
    entry(B, newest([listingsChanged, ...d.posts.map((p) => p.updatedAt)]), 'daily', 1.0),
    entry(`${B}/marketplace`, listingsChanged, 'daily', 0.9),
    entry(`${B}/let-us-find-it`, undefined, 'monthly', 0.8),
    entry(`${B}/sell`, undefined, 'monthly', 0.6),
    entry(`${B}/about`, t.ABOUT_PAGE_TEXT, 'monthly', 0.5),
    entry(`${B}/faq`, t.FAQ_TEXT, 'monthly', 0.5),
    entry(`${B}/contact`, undefined, 'yearly', 0.4),
    entry(`${B}/support`, undefined, 'yearly', 0.4),
    entry(`${B}/legal/terms`, t.LEGAL_TERMS_TEXT, 'yearly', 0.3),
    entry(`${B}/legal/privacy`, t.PRIVACY_POLICY_TEXT, 'yearly', 0.3),
    entry(`${B}/legal/cookies`, t.COOKIE_POLICY_TEXT, 'yearly', 0.3),
  ];
  // Section pages only with something in them (an empty list is a soft 404).
  const sections: Array<[string, Dated[]]> = [
    ['/blog', d.posts],
    ['/wiki', d.articles],
    ['/lab-rental', d.facilities],
    ['/case-studies', d.cases],
  ];
  for (const [path, items] of sections) {
    if (items.length) pages.push(entry(`${B}${path}`, newest(items.map((i) => i.updatedAt)), 'weekly', 0.7));
  }

  return [
    ...pages,
    ...d.products.map((p) => entry(`${B}/marketplace/${p.slug}`, p.updatedAt, 'weekly', 0.7)),
    ...d.categories.map((c) => entry(`${B}/marketplace?category=${c.slug}`, newest([c.updatedAt, byCategory.get(c.id)]), 'weekly', 0.6)),
    ...d.posts.map((p) => entry(`${B}/blog/${p.slug}`, p.updatedAt, 'monthly', 0.6)),
    ...d.articles.map((a) => entry(`${B}/wiki/${a.slug}`, a.updatedAt, 'monthly', 0.5)),
    ...d.cases.map((c) => entry(`${B}/case-studies/${c.slug}`, c.updatedAt, 'monthly', 0.6)),
    ...d.facilities.map((f) => entry(`${B}/lab-rental/${f.slug}`, f.updatedAt, 'monthly', 0.5)),
  ];
}
