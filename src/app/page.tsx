import type { Metadata } from 'next';
import { TrustBar } from '@/components/home/TrustBar';
import { FeaturedProducts } from '@/components/home/FeaturedProducts';
import { BlogTeasers } from '@/components/home/BlogTeasers';
import { Testimonials } from '@/components/home/Testimonials';
import { Reveal } from '@/components/motion/Reveal';
import { Landing } from '@/components/home/landing/Landing';
import { JsonLd } from '@/components/seo/JsonLd';
import { countSearchMatches } from '@/lib/marketplace/queries';
import { isBuildPhase } from '@/lib/build-phase';
import { ensureSettingsLoaded, settingList, settingString } from '@/lib/settings';
import { type HomeExtra, draftRead, envRead, getHomeContent, getHomeLayout } from '@/lib/home-sections';
import { getLiveCounts, liveStats } from '@/lib/home-stats';
import { siteTextsFrom } from '@/lib/catalog/site-texts';
import { getCatalogPolicy } from '@/lib/catalog/policy';
import { availablePaymentMethods } from '@/lib/checkout/server';
import { legalIdentity } from '@/lib/brand/identity';
import { absoluteSiteUrl } from '@/lib/media/public-src';
import { organizationJsonLd } from '@/lib/home/org-jsonld';
import { hubFromCompany } from '@/lib/home/hub';
import { draftForToken } from '@/lib/home/draft';
import {
  type DemoProduct, type FeaturedProduct, type StationCategory,
  getDemoProduct, getFeaturedProducts, getLiveListingCount, getStationCategories, homeLandingGen,
} from '@/lib/home-landing-data';
import { staleWhileRevalidate } from '@/lib/stale-cache';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const baseUrl = () => (process.env.BETTER_AUTH_URL || 'https://labtodate.com').replace(/\/+$/, '');

/**
 * The homepage's own title, description, canonical and link preview, from
 * Settings → Brand / Site texts (the layout's defaults are for other pages).
 * A draft preview (?homepreview=…) is never indexed.
 */
export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  if (!isBuildPhase()) await ensureSettingsLoaded();
  const t = siteTextsFrom((k) => process.env[k] ?? '');
  const title = `${t.siteName} — ${t.titleSuffix}`;
  const preview = !!one((await searchParams).homepreview);
  const image = settingString('OG_DEFAULT_IMAGE_URL');
  const imageUrl = image ? (/^https?:\/\//i.test(image) ? image : absoluteSiteUrl(image)) : '';
  return {
    title: { absolute: title },
    description: t.metaDescription,
    alternates: { canonical: '/' },
    openGraph: {
      title,
      description: t.metaDescription,
      url: '/',
      type: 'website',
      siteName: t.siteName,
      locale: settingString('OG_LOCALE') || 'en_US',
      ...(imageUrl ? { images: [{ url: imageUrl }] } : {}),
    },
    ...(preview ? { robots: { index: false, follow: false } } : {}),
  };
}

/**
 * The homepage: the pinned stations of the Shelter-style landing
 * (components/home/landing) chosen and ordered in Admin → Homepage, then any
 * extra modules switched on there as ordinary sections below the story. With
 * ?homepreview=<token> it shows the editor's unpublished draft instead.
 */
export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  await ensureSettingsLoaded();
  const sp = await searchParams;
  const draft = await draftForToken(one(sp.homepreview));
  const read = draft ? draftRead(draft.values) : envRead;
  const texts = siteTextsFrom((k) => process.env[k] ?? '');
  const site = texts.siteName;
  const policy = await getCatalogPolicy();
  const content = getHomeContent(read, {
    site,
    sellLogistics: policy.sellLogisticsMode,
    incoterm: settingString('OFFER_DEFAULT_INCOTERM'),
    // the proforma / VAT-invoice wording follows the methods checkout offers now
    paymentMethods: availablePaymentMethods(),
  });
  const { stations, extras } = getHomeLayout(read);
  const build = isBuildPhase();

  // The live data below is public and the same for every visitor: computed at
  // most once a minute, in parallel, and served from memory meanwhile (refreshed
  // in the background), so the page doesn't wait on these queries. The keys
  // carry what was chosen in Admin → Homepage and a generation that every
  // category or homepage edit bumps (home-landing-data.ts), so an edit shows on
  // the next request.
  let categories: StationCategory[] = [];
  let listings = 0;
  let demo: DemoProduct | null = null;
  let featured: FeaturedProduct[] = [];
  if (!build) {
    const ttl = 60_000;
    const gen = homeLandingGen();
    const key = (name: string, extra = '') => `home:${name}:${gen}:${extra}`;
    const items = content.catItems;
    const [counts, hits, c, l, d, f] = await Promise.all([
      // Unless admin typed explicit (parseable) HERO_STATS, show REAL counts so the
      // headline never lies.
      content.stats.length ? null : staleWhileRevalidate(key('counts'), ttl, getLiveCounts),
      // "Popular" chips (defaults or admin's HOMEPAGE_POPULAR) must lead somewhere:
      // drop any term the marketplace search would return nothing for.
      staleWhileRevalidate(key('popular', content.popular.join('|')), ttl, () => Promise.all(content.popular.map((t) => countSearchMatches(t)))),
      stations.includes('categories')
        ? staleWhileRevalidate(key('categories', `${JSON.stringify(items)}:${content.catMax}`), ttl, () => getStationCategories(items, content.catMax))
        : [],
      staleWhileRevalidate(key('listings'), ttl, getLiveListingCount),
      stations.includes('process') ? staleWhileRevalidate(key('demo', content.demoProduct), ttl, () => getDemoProduct(content.demoProduct)) : null,
      extras.includes('featured') ? staleWhileRevalidate(key('featured', content.featuredProducts.join(',')), ttl, () => getFeaturedProducts(content.featuredProducts)) : [],
    ]);
    if (counts) content.stats = liveStats(counts, content.statLabels);
    content.popular = content.popular.filter((_, i) => hits[i] > 0);
    categories = c;
    listings = l;
    demo = d;
    featured = f;
  }

  const hub = content.netHub ?? hubFromCompany(site, settingString('COMPANY_CITY'), settingString('TAX_HOME_COUNTRY'));
  const extra: Record<HomeExtra, React.ReactNode> = {
    trustbar: <TrustBar key="trustbar" label={content.trustLabel} />,
    featured: (
      <Reveal key="featured">
        <FeaturedProducts products={featured} listings={listings} kicker={content.featuredKicker} title={content.featuredTitle} button={content.featuredButton} />
      </Reveal>
    ),
    blog: <BlogTeasers key="blog" kicker={content.blogKicker} title={content.blogTitle} button={content.blogButton} readTime={content.blogRead} />,
    testimonials: (
      <Reveal key="testimonials">
        <Testimonials heading={content.testHeading} meta={content.testMeta} />
      </Reveal>
    ),
  };

  const base = baseUrl();
  const orgLd = organizationJsonLd({
    identity: legalIdentity(),
    address: settingString('COMPANY_ADDRESS'),
    homeCountry: settingString('TAX_HOME_COUNTRY'),
    sameAs: settingList('SOCIAL_LINKS'),
    url: base,
    description: texts.metaDescription,
  });
  const siteLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: site,
    url: base,
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${base}/marketplace?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };

  return (
    <>
      {!draft && <JsonLd data={[orgLd, siteLd]} />}
      {draft && (
        <div role="status" style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 80, padding: '6px 12px', borderRadius: 999, background: '#a4e335', color: '#062a28', font: '700 12px/1.4 var(--font-inter, sans-serif)', boxShadow: '0 6px 24px rgb(0 0 0 / 0.25)' }}>
          Draft preview — not published
        </div>
      )}
      <Landing stations={stations} content={content} categories={categories} listings={listings} demo={demo} hub={hub} sourcingNote={texts.sourcingNoObligation}>
        {extras.length > 0 && <div className="lnd-extras">{extras.map((k) => extra[k])}</div>}
      </Landing>
    </>
  );
}
