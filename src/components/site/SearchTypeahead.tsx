'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Search, Loader2, ArrowRight, Camera } from 'lucide-react';
import { formatPrice } from '@/lib/utils';

interface Hit {
  slug: string;
  title: string;
  brand: string | null;
  category: string;
  /** Our own photo, or null (then a neutral “no photo” tile — never a drawing posing as the item). */
  image: string | null;
  noPhotoLabel?: string;
  priceCents: number | null;
  priceLabel?: string | null;
  currency: string;
  condition: string;
}

export function SearchTypeahead({
  placeholder = 'Search instruments…',
  className = '',
  autoFocus = false,
  onNavigate,
  onDismiss,
  size = 'md',
}: {
  placeholder?: string;
  /** 'lg' = the big borderless field inside the homepage hero glass bar. */
  size?: 'md' | 'lg';
  className?: string;
  autoFocus?: boolean;
  /** Called after the user picks a hit or submits a search. */
  onNavigate?: () => void;
  /** Called on Escape when the suggestions are already closed. */
  onDismiss?: () => void;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  // 'busy' = the endpoint rate-limited us (429), 'error' = any other failure.
  // Both used to fall through to "No results", which is untrue.
  const [status, setStatus] = useState<'ok' | 'busy' | 'error'>('ok');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);

  // Debounced fetch; a newer keystroke aborts the older request so a slow
  // response can't overwrite the hits for what's typed now.
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      setStatus('ok');
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/typeahead?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (!res.ok) {
          setHits([]);
          setStatus(res.status === 429 ? 'busy' : 'error');
          return;
        }
        const data = await res.json();
        setHits(data.hits ?? []);
        setStatus('ok');
      } catch {
        if (ctrl.signal.aborted) return;
        setHits([]);
        setStatus('error');
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
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
    onNavigate?.();
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
      onNavigate?.();
      router.push(`/marketplace/${hits[focusedIdx].slug}`);
    } else if (e.key === 'Escape') {
      if (open && q.trim().length >= 2) setOpen(false);
      else onDismiss?.();
    }
  }

  const expanded = open && q.trim().length >= 2;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <form onSubmit={submit} role="search">
        <Search className={`absolute top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none ${size === 'lg' ? 'left-4 h-[19px] w-[19px]' : 'left-3.5 h-4 w-4'}`} />
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
          aria-label="Search instruments"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={expanded}
          aria-activedescendant={expanded && focusedIdx >= 0 ? `${listId}-${focusedIdx}` : undefined}
          autoFocus={autoFocus}
          autoComplete="off"
          className={
            size === 'lg'
              ? 'w-full h-[52px] pl-12 pr-3 rounded-xl border-0 bg-transparent text-[15.5px] placeholder:text-muted-foreground/80 focus:outline-none focus:ring-2 focus:ring-primary/25'
              : 'w-full h-10 pl-10 pr-3 rounded-full border border-border bg-foreground/[0.03] text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary'
          }
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
        )}
      </form>

      {expanded && (
        <div className={`absolute left-0 right-0 rounded-2xl border border-border bg-card shadow-xl z-50 overflow-hidden ${size === 'lg' ? 'top-[60px]' : 'top-12'}`}>
          {hits.length === 0 && !loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground" role="status">
              {status === 'busy'
                ? 'Suggestions are busy right now — the full search still works.'
                : status === 'error'
                  ? 'Suggestions couldn’t be loaded — the full search still works.'
                  : <>No results for &ldquo;{q}&rdquo;.</>}
              <br />
              <button
                type="button"
                onClick={(e) => submit(e as unknown as React.FormEvent)}
                className="text-primary hover:underline font-medium mt-2 inline-block"
              >
                {status === 'ok' ? 'Search anyway →' : `See all results for “${q.trim()}” →`}
              </button>
            </div>
          ) : (
            <>
              <ul id={listId} role="listbox" aria-label="Suggestions" className="max-h-96 overflow-y-auto">
                {hits.map((h, i) => (
                  <li key={h.slug} id={`${listId}-${i}`} role="option" aria-selected={focusedIdx === i}>
                    <Link
                      href={`/marketplace/${h.slug}`}
                      onClick={() => {
                        setOpen(false);
                        onNavigate?.();
                      }}
                      className={`flex items-center gap-3 px-3 py-2.5 hover:bg-foreground/5 transition-colors ${
                        focusedIdx === i ? 'bg-foreground/5' : ''
                      }`}
                    >
                      <div className="flex-shrink-0 h-12 w-12 rounded-lg overflow-hidden bg-muted border border-border flex items-center justify-center" aria-hidden="true">
                        {h.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={h.image} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <Camera className="h-4 w-4 text-muted-foreground" aria-label={h.noPhotoLabel ?? 'Photo on request'} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">
                          {h.brand ?? h.category}
                        </p>
                        <p className="text-sm font-semibold text-foreground truncate">{h.title}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        {h.priceCents ? (
                          <span className="flex flex-col items-end">
                            <span className="text-sm font-bold tabular-nums">{formatPrice(h.priceCents, h.currency)}</span>
                            {h.priceLabel && <span className="text-[10px] text-muted-foreground">{h.priceLabel}</span>}
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
                onClick={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
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
