import { Hero } from '@/components/home/Hero';
import { TrustBar } from '@/components/home/TrustBar';
import { CategoryGrid } from '@/components/home/CategoryGrid';
import { FeaturedProducts } from '@/components/home/FeaturedProducts';
import { FeaturedSuppliers } from '@/components/home/FeaturedSuppliers';
import { BlogTeasers } from '@/components/home/BlogTeasers';
import { Testimonials } from '@/components/home/Testimonials';
import { CTASection } from '@/components/home/CTASection';
import { Reveal } from '@/components/motion/Reveal';
import { JsonLd } from '@/components/seo/JsonLd';
import { countSearchMatches } from '@/lib/marketplace/queries';
import { isBuildPhase } from '@/lib/build-phase';
import { ensureSettingsLoaded } from '@/lib/settings';
import { type HomeSection, getHomeContent, getHomeSectionOrder, parseHeroStats } from '@/lib/home-sections';
import { getLiveHeroStats } from '@/lib/home-stats';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  await ensureSettingsLoaded();
  const content = getHomeContent();

  // Unless admin typed explicit (parseable) HERO_STATS, show REAL counts so the
  // headline never lies — an unparseable value falls back to live counts too,
  // never to the zero placeholders.
  if (!isBuildPhase() && !parseHeroStats(process.env.HERO_STATS)) {
    content.stats = await getLiveHeroStats();
  }

  // "Popular" chips (defaults or admin's HOMEPAGE_POPULAR) must lead somewhere:
  // drop any term the marketplace search would return nothing for.
  if (!isBuildPhase()) {
    const counts = await Promise.all(content.popular.map((t) => countSearchMatches(t)));
    content.popular = content.popular.filter((_, i) => counts[i] > 0);
  }

  const order: HomeSection[] = getHomeSectionOrder();

  const render: Record<HomeSection, React.ReactNode> = {
    hero: <Hero key="hero" content={content} />,
    trustbar: <TrustBar key="trustbar" />,
    categories: <Reveal key="categories"><CategoryGrid /></Reveal>,
    featured: <Reveal key="featured"><FeaturedProducts /></Reveal>,
    suppliers: <Reveal key="suppliers"><FeaturedSuppliers /></Reveal>,
    blog: <BlogTeasers key="blog" />,
    testimonials: (
      <Reveal key="testimonials">
        <Testimonials heading={content.testHeading} meta={content.testMeta} />
      </Reveal>
    ),
    cta: (
      <Reveal key="cta">
        <CTASection heading={content.ctaHeading} subtitle={content.ctaSubtitle} />
      </Reveal>
    ),
  };

  const base = process.env.BETTER_AUTH_URL ?? 'https://labtodate.com';
  const orgLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: process.env.SITE_NAME || 'lab2date',
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
    name: process.env.SITE_NAME || 'lab2date',
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
      {order.map((k) => render[k])}
    </>
  );
}
