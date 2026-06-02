import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { listProducts } from '@/lib/marketplace/queries';
import { ProductCard } from '@/components/marketplace/ProductCard';
import type { IllustrationName } from '@/components/illustrations/instruments';
import { getMarketing } from '@/lib/marketing';

export async function FeaturedProducts() {
  const { items } = await listProducts({ pageSize: 8, sort: 'newest' });
  const mk = await getMarketing();

  return (
    <section className="container-px py-24">
      <div className="flex items-end justify-between mb-12 gap-6 flex-wrap">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">Featured equipment</p>
          <h2
            className="text-3xl md:text-5xl font-bold text-foreground max-w-2xl"
            style={{ letterSpacing: '-0.035em' }}
          >
            Hand-picked instruments. Inspected, warrantied, ready to ship.
          </h2>
        </div>
        <Link
          href="/marketplace"
          className="inline-flex items-center gap-2 px-5 py-3 rounded-full border-2 border-foreground/10 text-sm font-semibold text-foreground hover:bg-foreground hover:text-background transition-colors group"
        >
          Browse all {mk.listings}
          <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {items.map((p) => (
          <ProductCard
            key={p.slug}
            p={{
              slug: p.slug,
              title: p.title,
              brand: p.brand?.name ?? '—',
              supplier: 'lab2date Verified Supplier',
              illustration: (p.illustration ?? 'balance') as IllustrationName,
              imageUrl: p.images?.[0] ?? null,
              condition: p.condition,
              mode: p.mode,
              priceCents: p.priceCents,
              currency: p.currency,
              yearMade: p.yearMade,
            }}
          />
        ))}
      </div>
    </section>
  );
}
