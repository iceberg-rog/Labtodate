'use client';

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { X, SlidersHorizontal, ChevronDown } from 'lucide-react';

interface FacetItem {
  slug: string;
  name: string;
  count: number;
}

export function Filters({
  categories,
  brands,
}: {
  categories: FacetItem[];
  brands: FacetItem[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false); // mobile filter drawer

  const activeCategory  = params.get('category');
  const activeBrand     = params.get('brand');
  const activeCondition = params.get('condition');
  const activeMode      = params.get('mode');

  // On phones the filters sit above the results, which are off-screen — so after
  // applying one, scroll the results into view so the change is visible.
  const scrollToResults = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setTimeout(() => {
        document.getElementById('marketplace-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
    }
  }, []);

  const set = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null || next.get(key) === value) next.delete(key);
      else next.set(key, value);
      next.delete('page');
      router.push(`${pathname}?${next.toString()}`, { scroll: false });
      scrollToResults();
    },
    [params, pathname, router, scrollToResults],
  );

  const clearAll = useCallback(() => {
    const next = new URLSearchParams();
    const q = params.get('q');
    if (q) next.set('q', q);
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
    setOpen(false);
    scrollToResults();
  }, [params, pathname, router, scrollToResults]);

  const activeCount = [
    activeCategory, activeBrand, activeCondition, activeMode,
    params.get('minPrice'), params.get('maxPrice'),
  ].filter(Boolean).length;
  const hasActive = activeCount > 0;

  return (
    <aside className="space-y-4 lg:space-y-6 lg:sticky lg:top-24 lg:self-start">
      {/* Mobile: collapsible filter drawer trigger (filters otherwise push the
          results far below the fold, so tapping one felt like "nothing happens"). */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="lg:hidden w-full flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-sm font-bold"
      >
        <span className="inline-flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4" /> Filters
          {activeCount > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-bold min-w-[1.25rem] h-5 px-1.5">
              {activeCount}
            </span>
          )}
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Desktop: heading + clear all */}
      <div className="hidden lg:flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-foreground">Filters</h2>
        {hasActive && (
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 font-medium"
          >
            <X className="h-3 w-3" /> Clear all
          </button>
        )}
      </div>

      {/* Collapsible body: hidden on mobile until opened, always shown on lg+ */}
      <div className={`${open ? 'block' : 'hidden'} lg:block space-y-6`}>
        {hasActive && (
          <button
            type="button"
            onClick={clearAll}
            className="lg:hidden w-full text-xs text-muted-foreground hover:text-primary inline-flex items-center justify-center gap-1 font-medium rounded-lg border border-border py-2"
          >
            <X className="h-3 w-3" /> Clear all filters
          </button>
        )}

      <FilterGroup title="Category">
        {categories.map((c) => (
          <FilterToggle
            key={c.slug}
            active={activeCategory === c.slug}
            onClick={() => set('category', c.slug)}
            label={c.name}
            count={c.count}
          />
        ))}
      </FilterGroup>

      <FilterGroup title="Brand">
        {brands.map((b) => (
          <FilterToggle
            key={b.slug}
            active={activeBrand === b.slug}
            onClick={() => set('brand', b.slug)}
            label={b.name}
            count={b.count}
          />
        ))}
      </FilterGroup>

      <FilterGroup title="Condition">
        {(['NEW', 'REFURBISHED', 'USED'] as const).map((c) => (
          <FilterToggle
            key={c}
            active={activeCondition === c}
            onClick={() => set('condition', c)}
            label={c.charAt(0) + c.slice(1).toLowerCase()}
          />
        ))}
      </FilterGroup>

      <FilterGroup title="Buying mode">
        {(
          [
            { v: 'BUY_NOW', l: 'Buy now' },
            { v: 'HYBRID', l: 'Buy or quote' },
            { v: 'QUOTE_ONLY', l: 'Quote only' },
          ] as const
        ).map((m) => (
          <FilterToggle
            key={m.v}
            active={activeMode === m.v}
            onClick={() => set('mode', m.v)}
            label={m.l}
          />
        ))}
      </FilterGroup>

      <FilterGroup title="Price (€)">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget as HTMLFormElement);
            const next = new URLSearchParams(params.toString());
            const min = String(fd.get('minPrice') ?? '').trim();
            const max = String(fd.get('maxPrice') ?? '').trim();
            if (min) next.set('minPrice', min);
            else next.delete('minPrice');
            if (max) next.set('maxPrice', max);
            else next.delete('maxPrice');
            next.delete('page');
            router.push(`${pathname}?${next.toString()}`, { scroll: false });
            scrollToResults();
          }}
          className="flex items-center gap-2"
        >
          <input
            name="minPrice"
            type="number"
            min={0}
            placeholder="Min"
            defaultValue={params.get('minPrice') ?? ''}
            className="w-full h-9 px-2 rounded-lg border border-input bg-background text-sm"
          />
          <span className="text-muted-foreground text-xs">–</span>
          <input
            name="maxPrice"
            type="number"
            min={0}
            placeholder="Max"
            defaultValue={params.get('maxPrice') ?? ''}
            className="w-full h-9 px-2 rounded-lg border border-input bg-background text-sm"
          />
          <button
            type="submit"
            className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-semibold"
          >
            Go
          </button>
        </form>
      </FilterGroup>
      </div>
    </aside>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground mb-3">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function FilterToggle({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
        active
          ? 'bg-primary text-primary-foreground font-semibold'
          : 'text-foreground hover:bg-foreground/5 font-medium'
      }`}
    >
      <span className="truncate text-left">{label}</span>
      {count !== undefined && (
        <span className={`text-xs tabular-nums ${active ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
          {count}
        </span>
      )}
    </button>
  );
}
