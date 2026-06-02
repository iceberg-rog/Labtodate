'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ChevronDown } from 'lucide-react';

const OPTIONS = [
  { value: '',            label: 'Newest' },
  { value: 'price_asc',   label: 'Price · low → high' },
  { value: 'price_desc',  label: 'Price · high → low' },
];

export function SortDropdown() {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const current = params.get('sort') ?? '';

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(params.toString());
    if (e.target.value) next.set('sort', e.target.value);
    else next.delete('sort');
    next.delete('page');
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  }

  return (
    <div className="relative inline-flex">
      <select
        value={current}
        onChange={onChange}
        className="appearance-none rounded-full border border-border bg-card pl-4 pr-9 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/30"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            Sort: {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
    </div>
  );
}
