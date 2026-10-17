import { ensureSettingsLoaded } from '@/lib/settings';
import { CATALOG_TEXT_DEFAULTS as T } from '@/lib/catalog/texts';

/**
 * Settings → Site texts & pages: the site's own descriptions and page
 * introductions. Defaults describe only what the site really does (no claims,
 * no reply-time promises, no "refurbished" for a catalogue of used units).
 */
export interface SiteTexts {
  siteName: string;
  titleSuffix: string;
  metaDescription: string;
  footerSignoff: string;
  sourcingNoObligation: string;
  caseStudiesIntro: string;
  labRentalIntro: string;
  blogIntro: string;
  wikiIntro: string;
}

export function siteTextsFrom(get: (k: string) => string): SiteTexts {
  const r = (k: string, d: string) => (get(k) ?? '').trim() || d;
  return {
    siteName: r('SITE_NAME', 'lab2date'),
    titleSuffix: r('SITE_TITLE_SUFFIX', T.siteTitleSuffix),
    metaDescription: r('SITE_META_DESCRIPTION', T.siteMetaDescription),
    footerSignoff: (get('FOOTER_SIGNOFF') ?? '').trim(),
    sourcingNoObligation: r('SOURCING_NO_OBLIGATION_TEXT', T.sourcingNoObligation),
    caseStudiesIntro: r('CASE_STUDIES_INTRO', T.caseStudiesIntro),
    labRentalIntro: r('LAB_RENTAL_INTRO', T.labRentalIntro),
    blogIntro: r('BLOG_INTRO', T.blogIntro),
    wikiIntro: r('WIKI_INTRO', T.wikiIntro),
  };
}

export async function getSiteTexts(): Promise<SiteTexts> {
  await ensureSettingsLoaded();
  return siteTextsFrom((k) => process.env[k] ?? '');
}
