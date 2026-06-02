import { Hero } from '@/components/home/Hero';
import { TrustBar } from '@/components/home/TrustBar';
import { CategoryGrid } from '@/components/home/CategoryGrid';
import { FeaturedProducts } from '@/components/home/FeaturedProducts';
import { FeaturedSuppliers } from '@/components/home/FeaturedSuppliers';
import { BlogTeasers } from '@/components/home/BlogTeasers';
import { Testimonials } from '@/components/home/Testimonials';
import { CTASection } from '@/components/home/CTASection';
import { Reveal } from '@/components/motion/Reveal';
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

  return <>{order.map((k) => render[k])}</>;
}
