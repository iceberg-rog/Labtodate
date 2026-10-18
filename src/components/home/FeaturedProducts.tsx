import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { ProductCard } from '@/components/marketplace/ProductCard';
import type { FeaturedProduct } from '@/lib/home-landing-data';

/**
 * Extra module “Featured products”: the live listings picked in Admin →
 * Homepage (in that order), else the eight newest — loaded by the page
 * (getFeaturedProducts). Every card opens its listing; the texts and the
 * button come from Admin → Homepage.
 */
export function FeaturedProducts({
  products,
  listings,
  kicker,
  title,
  button,
}: {
  products: FeaturedProduct[];
  listings: number;
  kicker: string;
  title: string;
  button: [string, string];
}) {
  if (products.length === 0) return null;
  const [label, href] = button;
  return (
    <section id="featured" data-hud="LATEST" className="container-px py-24">
      <div className="flex items-end justify-between mb-12 gap-6 flex-wrap">
        <div>
          {kicker && <span className="kicker mb-4">{kicker}</span>}
          <h2
            className="text-3xl md:text-5xl font-bold text-foreground max-w-2xl"
            style={{ letterSpacing: '-0.035em' }}
          >
            {title}
          </h2>
        </div>
        <Link
          href={href}
          className="inline-flex items-center gap-2 px-5 py-3 rounded-full border border-[hsl(var(--teal)/0.24)] bg-[hsl(var(--teal)/0.05)] text-sm font-semibold text-foreground hover:border-primary/60 transition-colors group"
        >
          {label.replaceAll('{N}', listings.toLocaleString('en-US'))}
          <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {products.map((p) => (
          <ProductCard
            key={p.slug}
            p={{
              slug: p.slug,
              title: p.title,
              brand: p.brand,
              illustration: p.illustration,
              imageUrl: p.imageUrl,
              condition: p.condition,
              mode: p.mode,
              priceCents: p.priceCents,
              currency: p.currency,
              vatScheme: p.vatScheme,
              yearMade: p.yearMade,
            }}
          />
        ))}
      </div>
    </section>
  );
}
