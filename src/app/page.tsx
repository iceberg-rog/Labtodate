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
import { prisma } from '@/lib/db';
import { isBuildPhase } from '@/lib/build-phase';
import { ensureSettingsLoaded } from '@/lib/settings';
import { HOME_SECTIONS, type HomeSection, getHomeContent, type HomeStat } from '@/lib/home-sections';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  await ensureSettingsLoaded();
  const content = getHomeContent();

  // If admin hasn't overridden HERO_STATS in settings, replace the seed values
  // with REAL counts so the headline never lies. process.env.HERO_STATS is set
  // by saveHomepage when (and only when) admin types real numbers in.
  if (!isBuildPhase() && !process.env.HERO_STATS?.trim()) {
    const [listings, suppliers, countriesRow] = await Promise.all([
      prisma.product.count({ where: { status: 'PUBLISHED' } }),
      prisma.company.count(),
      prisma.company.findMany({
        where: { country: { not: null } },
        select: { country: true },
        distinct: ['country'],
      }),
    ]);
    const realStats: HomeStat[] = [
      { value: listings, suffix: '', label: listings === 1 ? 'instrument listed' : 'instruments listed' },
      { value: suppliers, suffix: '', label: suppliers === 1 ? 'supplier onboarded' : 'suppliers onboarded' },
      { value: countriesRow.length, suffix: '', label: countriesRow.length === 1 ? 'country served' : 'countries served' },
    ];
    content.stats = realStats;
  }

  const configured = (process.env.HOMEPAGE_SECTIONS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is HomeSection => (HOME_SECTIONS as readonly string[]).includes(s));
  const order: HomeSection[] = configured.length ? configured : [...HOME_SECTIONS];

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
