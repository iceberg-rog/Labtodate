'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Search, Loader2, ArrowRight } from 'lucide-react';
import { InstrumentIllustration, type IllustrationName } from '@/components/illustrations/instruments';
import { formatPrice } from '@/lib/utils';

interface Hit {
  slug: string;
  title: string;
  brand: string | null;
  category: string;
  illustration: IllustrationName;
  priceCents: number | null;
  currency: string;
  condition: string;
}

export function SearchTypeahead({ placeholder = 'Search instruments…', className = '' }: { placeholder?: string; className?: string }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);

  // Debounced fetch
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/typeahead?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        setHits(data.hits ?? []);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  // Click outside to close
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setOpen(false);
    router.push(`/marketplace?q=${encodeURIComponent(q.trim())}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIdx((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIdx((i) => Math.max(-1, i - 1));
    } else if (e.key === 'Enter' && focusedIdx >= 0 && hits[focusedIdx]) {
      e.preventDefault();
      setOpen(false);
      router.push(`/marketplace/${hits[focusedIdx].slug}`);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      <form onSubmit={submit}>
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <input
          type="search"
          name="q"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setFocusedIdx(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-autocomplete="list"
          aria-expanded={open}
          autoComplete="off"
          className="w-full h-10 pl-10 pr-3 rounded-full border border-border bg-foreground/[0.03] text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
        )}
      </form>

      {open && q.trim().length >= 2 && (
        <div className="absolute top-12 left-0 right-0 rounded-2xl border border-border bg-card shadow-xl z-50 overflow-hidden">
          {hits.length === 0 && !loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No results for &ldquo;{q}&rdquo;.
              <br />
              <button
                type="button"
                onClick={(e) => submit(e as unknown as React.FormEvent)}
                className="text-primary hover:underline font-medium mt-2 inline-block"
              >
                Search anyway →
              </button>
            </div>
          ) : (
            <>
              <ul role="listbox" className="max-h-96 overflow-y-auto">
                {hits.map((h, i) => (
                  <li key={h.slug}>
                    <Link
                      href={`/marketplace/${h.slug}`}
                      onClick={() => setOpen(false)}
                      className={`flex items-center gap-3 px-3 py-2.5 hover:bg-foreground/5 transition-colors ${
                        focusedIdx === i ? 'bg-foreground/5' : ''
                      }`}
                    >
                      <div className="flex-shrink-0 h-12 w-12 rounded-lg bg-gradient-to-br from-[hsl(82_55%_92%)] to-[hsl(168_30%_92%)] p-1.5">
                        <InstrumentIllustration name={h.illustration} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">
                          {h.brand ?? h.category}
                        </p>
                        <p className="text-sm font-semibold text-foreground truncate">{h.title}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        {h.priceCents ? (
                          <span className="text-sm font-bold tabular-nums">
                            {formatPrice(h.priceCents, h.currency)}
                          </span>
                        ) : (
                          <span className="text-xs font-medium text-primary">Quote</span>
                        )}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
              <Link
                href={`/marketplace?q=${encodeURIComponent(q.trim())}`}
                onClick={() => setOpen(false)}
                className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border bg-foreground/[0.02] text-sm font-semibold text-primary hover:bg-foreground/5"
              >
                See all matches for &ldquo;{q.trim()}&rdquo;
                <ArrowRight className="h-4 w-4" />
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
