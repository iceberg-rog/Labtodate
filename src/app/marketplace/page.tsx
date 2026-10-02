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
  description: 'Browse new and refurbished laboratory instruments — chromatography, mass spectrometry, spectroscopy and more.',
};

export const dynamic = 'force-dynamic';

type RawSearchParams = Record<string, string | string[] | undefined>;

const CONDITIONS: readonly ProductCondition[] = ['NEW', 'REFURBISHED', 'USED'];
const MODES: readonly ProductMode[] = ['BUY_NOW', 'HYBRID', 'QUOTE_ONLY'];
const SORTS = ['newest', 'price_asc', 'price_desc'] as const;

/** A repeated param (?category=a&category=b) arrives as an array — use the first. */
function first(v: string | string[] | undefined): string {
  return ((Array.isArray(v) ? v[0] : v) ?? '').trim();
}

function oneOf<T extends string>(v: string, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a.toLowerCase() === v.toLowerCase());
}

/** Non-negative euro amount, or undefined (cents are clamped in listProducts). */
function euros(v: string): number | undefined {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * URL params go straight into Prisma, so anything it would reject (an unknown
 * enum such as ?condition=new, an array, a price beyond INT4) used to 500 the
 * page. Keep only values we understand and drop the rest.
 */
function parseParams(raw: RawSearchParams) {
  const minEuro = euros(first(raw.minPrice));
  const maxEuro = euros(first(raw.maxPrice));
  return {
    q: first(raw.q).slice(0, 200) || undefined,
    category: first(raw.category) || undefined,
    brand: first(raw.brand) || undefined,
    condition: oneOf(first(raw.condition), CONDITIONS),
    mode: oneOf(first(raw.mode), MODES),
    sort: oneOf(first(raw.sort), SORTS),
    minPrice: minEuro !== undefined ? first(raw.minPrice) : undefined,
    maxPrice: maxEuro !== undefined ? first(raw.maxPrice) : undefined,
    minEuro,
    maxEuro,
    page: Math.min(10_000, Math.max(1, parseInt(first(raw.page), 10) || 1)),
  };
}

export default async function MarketplacePage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  // Next 16: searchParams is async — it MUST be awaited. Reading it directly
  // yields the Promise object, so every filter (category/brand/search/sort/
  // price/page) silently read `undefined` and the page showed all products.
  const sp = parseParams(await searchParams);
  const page = sp.page;
  const mk = await getMarketing();

  const [result, categories, brands] = await Promise.all([
    listProducts({
      q: sp.q,
      category: sp.category,
      brand: sp.brand,
      condition: sp.condition,
      mode: sp.mode,
      sort: sp.sort,
      minPriceCents: sp.minEuro !== undefined ? sp.minEuro * 100 : undefined,
      maxPriceCents: sp.maxEuro !== undefined ? sp.maxEuro * 100 : undefined,
      page,
    }),
    getCategories(),
    getTopBrands(12),
  ]);

  // Filters that carry over to pagination and the inline search box.
  const KEPT = ['q', 'category', 'brand', 'condition', 'mode', 'sort', 'minPrice', 'maxPrice'] as const;
  const baseParams = new URLSearchParams();
  for (const k of KEPT) {
    const v = sp[k];
    if (v) baseParams.set(k, v);
  }

  const activeCategoryName = sp.category
    ? categories.find((c) => c.slug === sp.category)?.name
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
          {result.total.toLocaleString()} listings{mk.inspection ? ` · ${mk.inspection} on every refurbished unit` : ''}
        </p>

        {/* Inline search */}
        <form action="/marketplace" className="mt-6 max-w-xl">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              name="q"
              defaultValue={sp.q ?? ''}
              placeholder="Search by instrument, brand, category or part number…"
              aria-label="Search the marketplace"
              className="w-full h-12 pl-11 pr-4 rounded-2xl border border-border bg-card text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
            {/* preserve current filters in the form */}
            {KEPT.filter((k) => k !== 'q').map((k) =>
              sp[k] ? (
                <input key={k} type="hidden" name={k} value={sp[k]} />
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
            categories={categories.filter((c) => c._count.products > 0).map((c) => ({ slug: c.slug, name: c.name, count: c._count.products }))}
            brands={brands.map((b) => ({ slug: b.slug, name: b.name, count: b._count.products }))}
          />
        </Suspense>

        <div id="marketplace-results" className="scroll-mt-20">
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
                    supplier: 'lab2date',
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
