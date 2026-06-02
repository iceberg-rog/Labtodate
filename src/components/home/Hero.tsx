import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchTypeahead } from '@/components/site/SearchTypeahead';
import { CountUp } from '@/components/motion/CountUp';
import { WaveCanvas } from '@/components/home/WaveCanvas';
import { HeroProductShowcase } from '@/components/home/HeroProductShowcase';
import { HOME_DEFAULTS, type HomeContent } from '@/lib/home-sections';

export function Hero({ content }: { content?: HomeContent } = {}) {
  const c = content ?? HOME_DEFAULTS;
  const POPULAR = c.popular.length ? c.popular : HOME_DEFAULTS.popular;
  const STATS = c.stats;
  return (
    <section className="relative overflow-hidden">
      {/* base background fill */}
      <div className="absolute inset-0 bg-background" style={{ zIndex: 0 }} aria-hidden />
      {/* soft brand glow */}
      <div
        className="absolute inset-0"
        aria-hidden
        style={{
          zIndex: 1,
          backgroundImage:
            'radial-gradient(60% 50% at 78% 18%, hsl(82 76% 55% / 0.10), transparent 60%), radial-gradient(55% 50% at 8% 80%, hsl(168 70% 28% / 0.06), transparent 60%)',
        }}
      />
      {/* animated flowing mesh — kept subtle so it doesn't fight the showcase column */}
      <WaveCanvas light className="absolute inset-x-0 bottom-0 h-[72%] z-[2] opacity-70" />
      <div
        className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-background"
        aria-hidden
        style={{ zIndex: 3 }}
      />

      <div className="container-px pt-14 pb-20 md:pt-20 md:pb-24 relative" style={{ zIndex: 10 }}>
        <div className="grid lg:grid-cols-[1.15fr_1fr] gap-10 xl:gap-16 items-start">
          {/* === LEFT: typography + search + CTAs + stats === */}
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-primary mb-7">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {c.heroBadge}
            </div>

            <h1
              className="font-bold leading-[0.95] text-[2.7rem] sm:text-6xl md:text-[4.2rem] lg:text-[4.5rem] xl:text-[5rem] text-foreground"
              style={{ letterSpacing: '-0.045em' }}
            >
              {c.heroTitle}{' '}
              <span className="text-[hsl(var(--accent-deep))]">{c.heroAccent}</span>
            </h1>

            <p className="mt-6 text-lg md:text-xl text-muted-foreground max-w-xl leading-relaxed">
              {c.heroSubtitle}
            </p>

            <div className="mt-8 flex flex-col sm:flex-row gap-3 max-w-xl">
              <SearchTypeahead className="flex-1" placeholder="Try ‘Zeiss confocal’ or ‘HPLC under €30k’…" />
              <Button size="lg" variant="accent" asChild className="h-10 px-7 rounded-full text-base font-semibold">
                <Link href="/marketplace">Browse <ArrowRight className="h-4 w-4" /></Link>
              </Button>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <span className="text-muted-foreground">Popular:</span>
              {POPULAR.map((t) => (
                <Link
                  key={t}
                  href={`/marketplace?q=${encodeURIComponent(t)}`}
                  className="text-foreground/80 hover:text-primary underline-offset-4 hover:underline font-medium"
                >
                  {t}
                </Link>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <Button variant="outline" size="lg" asChild className="rounded-xl font-semibold bg-card">
                <Link href="/let-us-find-it">Can&apos;t find it? Let us source it <ArrowRight className="h-4 w-4" /></Link>
              </Button>
              <Button variant="ghost" size="lg" asChild className="rounded-xl font-semibold">
                <Link href="/sell">Sell your equipment →</Link>
              </Button>
            </div>

            <dl className="mt-14 grid grid-cols-3 gap-6 max-w-lg">
              {STATS.map((s) => (
                <div key={s.label}>
                  <dt className="text-3xl md:text-4xl font-bold text-foreground data" style={{ letterSpacing: '-0.04em' }}>
                    <CountUp value={s.value} />
                    <span className="text-primary">{s.suffix}</span>
                  </dt>
                  <dd className="text-xs md:text-sm text-muted-foreground mt-1.5">{s.label}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* === RIGHT: live product showcase === */}
          <HeroProductShowcase />
        </div>
      </div>
    </section>
  );
}
