import { Suspense } from 'react';
import { Search } from 'lucide-react';
import type { Metadata } from 'next';
import { listProducts, getCategories, getTopBrands } from '@/lib/marketplace/queries';
import { getMarketing } from '@/lib/marketing';
import { ProductCard } from '@/components/marketplace/ProductCard';
import { Filters } from '@/components/marketplace/Filters';
import { SortDropdown } from '@/components/marketplace/SortDropdown';
import { Pagination } from '@/components/marketplace/Pagination';
import type { ProductCondition, ProductMode } from '@prisma/client';
import type { IllustrationName } from '@/components/illustrations/instruments';

export const metadata: Metadata = {
  title: 'Marketplace — Browse all instruments',
  description: 'Browse 12,000+ new and certified refurbished lab instruments from 840+ verified suppliers.',
};

export const dynamic = 'force-dynamic';

interface SearchParams {
  q?: string;
  category?: string;
  brand?: string;
  condition?: ProductCondition;
  mode?: ProductMode;
  sort?: 'newest' | 'price_asc' | 'price_desc';
  minPrice?: string;
  maxPrice?: string;
  page?: string;
}

export default async function MarketplacePage({ searchParams }: { searchParams: SearchParams }) {
  const page = parseInt(searchParams.page ?? '1', 10) || 1;
  const mk = await getMarketing();

  const minEuro = parseFloat(searchParams.minPrice ?? '');
  const maxEuro = parseFloat(searchParams.maxPrice ?? '');

  const [result, categories, brands] = await Promise.all([
    listProducts({
      q: searchParams.q,
      category: searchParams.category,
      brand: searchParams.brand,
      condition: searchParams.condition,
      mode: searchParams.mode,
      sort: searchParams.sort,
      minPriceCents: Number.isFinite(minEuro) && minEuro >= 0 ? Math.round(minEuro * 100) : undefined,
      maxPriceCents: Number.isFinite(maxEuro) && maxEuro >= 0 ? Math.round(maxEuro * 100) : undefined,
      page,
    }),
    getCategories(),
    getTopBrands(12),
  ]);

  const baseParams = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v && k !== 'page') baseParams.set(k, String(v));
  }

  const activeCategoryName = searchParams.category
    ? categories.find((c) => c.slug === searchParams.category)?.name
    : null;

  return (
    <div className="container-px py-10 md:py-14">
      {/* Hero strip */}
      <div className="mb-10">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">Marketplace</p>
        <h1
          className="text-3xl md:text-5xl font-bold text-foreground"
          style={{ letterSpacing: '-0.035em' }}
        >
          {activeCategoryName ? activeCategoryName : 'All lab instruments'}
        </h1>
        <p className="mt-3 text-muted-foreground max-w-2xl">
          {result.total.toLocaleString()} listings · verified suppliers · {mk.inspection} on every refurbished unit
        </p>

        {/* Inline search */}
        <form action="/marketplace" className="mt-6 max-w-xl">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              name="q"
              defaultValue={searchParams.q ?? ''}
              placeholder="Try ‘Zeiss confocal’ or ‘HPLC under €30k’…"
              className="w-full h-12 pl-11 pr-4 rounded-2xl border border-border bg-card text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
            {/* preserve current filters in the form */}
            {(['category', 'brand', 'condition', 'mode', 'sort'] as const).map((k) =>
              searchParams[k] ? (
                <input key={k} type="hidden" name={k} value={String(searchParams[k])} />
              ) : null,
            )}
          </div>
        </form>
      </div>

      <div className="grid lg:grid-cols-[260px_1fr] gap-10">
        {/* Filters + SortDropdown call useSearchParams(); without a Suspense
         *  parent, Next 14 fires a client-render bailout that produces an
         *  SSR/CSR hydration text mismatch (#418). */}
        <Suspense fallback={<div className="lg:sticky lg:top-24 h-10 rounded-lg bg-foreground/5 animate-pulse" />}>
          <Filters
            categories={categories.map((c) => ({ slug: c.slug, name: c.name, count: c._count.products }))}
            brands={brands.map((b) => ({ slug: b.slug, name: b.name, count: b._count.products }))}
          />
        </Suspense>

        <div>
          <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
            <p className="text-sm text-muted-foreground">
              Showing <strong className="text-foreground tabular-nums">{result.items.length}</strong> of{' '}
              <strong className="text-foreground tabular-nums">{result.total}</strong> instruments
            </p>
            <Suspense fallback={<div className="h-9 w-40 rounded-full bg-foreground/5 animate-pulse" />}>
              <SortDropdown />
            </Suspense>
          </div>

          {result.items.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
              <p className="text-lg font-semibold">No instruments match these filters.</p>
              <p className="text-sm text-muted-foreground mt-2">Try removing a filter or broadening your search.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
              {result.items.map((p) => (
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
          )}

          <Pagination page={result.page} totalPages={result.totalPages} searchParams={baseParams} />
        </div>
      </div>
    </div>
  );
}
