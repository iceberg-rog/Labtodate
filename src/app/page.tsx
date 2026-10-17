import { TrustBar } from '@/components/home/TrustBar';
import { FeaturedProducts } from '@/components/home/FeaturedProducts';
import { BlogTeasers } from '@/components/home/BlogTeasers';
import { Testimonials } from '@/components/home/Testimonials';
import { Reveal } from '@/components/motion/Reveal';
import { Landing } from '@/components/home/landing/Landing';
import { JsonLd } from '@/components/seo/JsonLd';
import { countSearchMatches } from '@/lib/marketplace/queries';
import { isBuildPhase } from '@/lib/build-phase';
import { ensureSettingsLoaded } from '@/lib/settings';
import { type HomeExtra, type HomeStation, getHomeContent, getHomeSectionOrder, isStation, parseHeroStats } from '@/lib/home-sections';
import { getLiveHeroStats } from '@/lib/home-stats';
import { getDemoProduct, getLiveListingCount, getStationCategories } from '@/lib/home-landing-data';

export const dynamic = 'force-dynamic';

/**
 * The homepage: the seven pinned stations of the Shelter-style landing
 * (components/home/landing), then any extra modules switched on in
 * Admin → Homepage as ordinary sections below the story.
 */
export default async function HomePage() {
  await ensureSettingsLoaded();
  const content = getHomeContent();
  const build = isBuildPhase();

  // Unless admin typed explicit (parseable) HERO_STATS, show REAL counts so the
  // headline never lies — an unparseable value falls back to live counts too,
  // never to the zero placeholders.
  if (!build && !parseHeroStats(process.env.HERO_STATS)) {
    content.stats = await getLiveHeroStats();
  }

  // "Popular" chips (defaults or admin's HOMEPAGE_POPULAR) must lead somewhere:
  // drop any term the marketplace search would return nothing for.
  if (!build) {
    const counts = await Promise.all(content.popular.map((t) => countSearchMatches(t)));
    content.popular = content.popular.filter((_, i) => counts[i] > 0);
  }

  const [categories, listings, demo] = build
    ? [[], 0, null]
    : await Promise.all([getStationCategories(9), getLiveListingCount(), getDemoProduct()]);

  const order = getHomeSectionOrder();
  const stations = order.filter(isStation) as HomeStation[];
  const extras = order.filter((k) => !isStation(k)) as HomeExtra[];
  const siteName = process.env.SITE_NAME?.trim() || 'Labtodate';
  const extra: Record<HomeExtra, React.ReactNode> = {
    trustbar: <TrustBar key="trustbar" />,
    featured: <Reveal key="featured"><FeaturedProducts /></Reveal>,
    blog: <BlogTeasers key="blog" />,
    testimonials: (
      <Reveal key="testimonials">
        <Testimonials heading={content.testHeading} meta={content.testMeta} />
      </Reveal>
    ),
  };

  const base = process.env.BETTER_AUTH_URL ?? 'https://labtodate.com';
  const orgLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: process.env.SITE_NAME || 'Labtodate',
    url: base,
    logo: process.env.COMPANY_LOGO_URL || undefined,
    description:
      'B2B marketplace for refurbished and surplus laboratory & analytical equipment across Europe — HPLC, GC, mass spectrometry and more.',
    email: process.env.SUPPORT_EMAIL || undefined,
    address: process.env.COMPANY_ADDRESS
      ? {
          '@type': 'PostalAddress',
          streetAddress: process.env.COMPANY_ADDRESS,
          addressCountry: process.env.COMPANY_COUNTRY || 'NL',
        }
      : undefined,
  };
  const siteLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: process.env.SITE_NAME || 'Labtodate',
    url: base,
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${base}/marketplace?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };

  return (
    <>
      <JsonLd data={[orgLd, siteLd]} />
      <Landing
        stations={stations}
        content={content}
        siteName={siteName}
        categories={categories}
        listings={listings}
        demo={demo}
        sourcingNote=""
      >
        {extras.length > 0 && <div className="lnd-extras">{extras.map((k) => extra[k])}</div>}
      </Landing>
    </>
  );
}
