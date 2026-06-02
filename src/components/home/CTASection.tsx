import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HOME_DEFAULTS } from '@/lib/home-sections';

export function CTASection({
  heading = HOME_DEFAULTS.ctaHeading,
  subtitle = HOME_DEFAULTS.ctaSubtitle,
}: {
  heading?: string;
  subtitle?: string;
} = {}) {
  return (
    <section className="container-px py-24">
      <div className="relative overflow-hidden rounded-[2rem] bg-primary px-8 py-16 md:px-16 md:py-24">
        {/* Decorative mesh */}
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage: `
              radial-gradient(at 18% 25%, hsla(82, 76%, 55%, 0.35) 0px, transparent 50%),
              radial-gradient(at 84% 70%, hsla(168, 60%, 38%, 0.5) 0px, transparent 55%),
              radial-gradient(at 95% 10%, hsla(82, 60%, 60%, 0.25) 0px, transparent 50%)
            `,
          }}
        />
        {/* Subtle grid */}
        <div
          className="absolute inset-0 opacity-[0.08]"
          style={{
            backgroundImage:
              'linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)',
            backgroundSize: '36px 36px',
          }}
        />

        <div className="relative grid lg:grid-cols-5 gap-10 items-center">
          <div className="lg:col-span-3 text-primary-foreground">
            <div className="inline-flex items-center gap-2 rounded-full bg-accent/20 border border-accent/40 px-3 py-1 text-xs font-semibold text-accent mb-6">
              <Sparkles className="h-3.5 w-3.5" />
              Concierge sourcing
            </div>
            <h2
              className="text-3xl md:text-5xl lg:text-6xl font-bold leading-[1.05]"
              style={{ letterSpacing: '-0.035em' }}
            >
              {heading}
            </h2>
            <p className="mt-6 text-primary-foreground/80 text-lg max-w-lg leading-relaxed">
              {subtitle}
            </p>
          </div>

          <div className="lg:col-span-2 flex flex-col gap-3 lg:items-end">
            <Button size="lg" variant="accent" asChild className="rounded-2xl font-semibold w-full sm:w-auto">
              <Link href="/let-us-find-it">
                Submit a sourcing request
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="rounded-2xl bg-transparent text-primary-foreground border-primary-foreground/30 hover:bg-primary-foreground hover:text-primary w-full sm:w-auto font-semibold"
              asChild
            >
              <Link href="/contact">Talk to sales</Link>
            </Button>
            <p className="text-xs text-primary-foreground/60 mt-2 lg:text-right">
              Free for buyers · No commission until you accept
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
