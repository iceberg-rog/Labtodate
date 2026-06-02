'use client';

import { useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { X } from 'lucide-react';

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

  const activeCategory  = params.get('category');
  const activeBrand     = params.get('brand');
  const activeCondition = params.get('condition');
  const activeMode      = params.get('mode');

  const set = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null || next.get(key) === value) next.delete(key);
      else next.set(key, value);
      next.delete('page');
      router.push(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const clearAll = useCallback(() => {
    const next = new URLSearchParams();
    const q = params.get('q');
    if (q) next.set('q', q);
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  }, [params, pathname, router]);

  const hasActive =
    activeCategory || activeBrand || activeCondition || activeMode ||
    params.get('minPrice') || params.get('maxPrice');

  return (
    <aside className="space-y-6 sticky top-24 self-start">
      <div className="flex items-center justify-between">
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
