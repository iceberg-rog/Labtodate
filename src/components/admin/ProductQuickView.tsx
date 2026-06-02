'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  X,
  Loader2,
  Image as ImageIcon,
  Tag,
  CircleDollarSign,
  Boxes,
  ExternalLink,
  ShoppingBag,
  Calendar,
} from 'lucide-react';
import { getProductQuickSummary } from '@/app/admin/actions';

type Summary = NonNullable<Awaited<ReturnType<typeof getProductQuickSummary>>>;

function fmt(cents: number | null, currency: string) {
  if (cents === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

const STATUS_BADGE: Record<string, string> = {
  DRAFT: 'bg-foreground/10 text-foreground',
  PENDING_REVIEW: 'bg-amber-100 text-amber-800',
  PUBLISHED: 'bg-emerald-100 text-emerald-800',
  ARCHIVED: 'bg-foreground/10 text-muted-foreground',
};

export function ProductQuickView() {
  const [slug, setSlug] = useState<string | null>(null);
  const [data, setData] = useState<Summary | null>(null);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [imgIdx, setImgIdx] = useState(0);

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ slug: string }>).detail;
      if (!detail?.slug) return;
      setSlug(detail.slug);
      setData(null);
      setErr(null);
      setImgIdx(0);
      start(async () => {
        try {
          const r = await getProductQuickSummary(detail.slug);
          if (!r) setErr('Product not found.');
          else setData(r);
        } catch (e) {
          setErr(e instanceof Error ? e.message : 'Failed to load.');
        }
      });
    }
    window.addEventListener('admin:productquick', handler);
    return () => window.removeEventListener('admin:productquick', handler);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSlug(null);
    }
    if (slug) {
      window.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [slug]);

  if (!slug) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" role="dialog" aria-modal>
      <button
        type="button"
        aria-label="Close"
        onClick={() => setSlug(null)}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="relative w-full md:max-w-3xl bg-card border border-border md:rounded-2xl shadow-xl max-h-[92vh] overflow-auto">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 p-5 border-b border-border bg-card">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Product</p>
            <h2 className="text-lg font-bold truncate">{data?.title ?? 'Loading…'}</h2>
            {data && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {data.brand ?? '—'} · {data.category} · {data.condition.toLowerCase()}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSlug(null)}
            className="p-1.5 rounded-lg hover:bg-foreground/5 text-muted-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5">
          {pending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Fetching product…
            </div>
          )}
          {err && <p className="text-sm text-red-600">{err}</p>}

          {data && (
            <div className="grid sm:grid-cols-[260px_1fr] gap-5">
              {/* Images */}
              <div className="space-y-2">
                <div className="aspect-square rounded-xl bg-foreground/5 border border-border overflow-hidden flex items-center justify-center">
                  {data.images.length > 0 ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={data.images[imgIdx] ?? data.images[0]} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon className="h-10 w-10 text-muted-foreground" />
                  )}
                </div>
                {data.images.length > 1 && (
                  <div className="grid grid-cols-4 gap-1.5">
                    {data.images.slice(0, 8).map((src, i) => (
                      <button
                        key={src}
                        type="button"
                        onClick={() => setImgIdx(i)}
                        className={`aspect-square rounded-md overflow-hidden border ${
                          i === imgIdx ? 'border-primary ring-2 ring-primary/30' : 'border-border'
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt="" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Meta */}
              <div className="space-y-4 min-w-0">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-xl font-bold tabular-nums">{fmt(data.priceCents, data.currency)}</p>
                    {data.priceCents === null && (
                      <p className="text-[11px] text-muted-foreground">Quote-only — no fixed price.</p>
                    )}
                  </div>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full ${STATUS_BADGE[data.status] ?? 'bg-foreground/10'}`}>
                    {data.status.replace('_', ' ').toLowerCase()}
                  </span>
                </div>

                {data.summary && (
                  <p className="text-sm text-foreground/80 leading-relaxed">{data.summary}</p>
                )}

                <div className="grid grid-cols-3 gap-2.5">
                  <Stat
                    icon={<ShoppingBag className="h-3.5 w-3.5" />}
                    label="Units sold"
                    value={data.salesUnits.toLocaleString()}
                    sub={`across ${data.salesOrders} order${data.salesOrders === 1 ? '' : 's'}`}
                    accent={data.salesUnits > 0}
                  />
                  <Stat
                    icon={<Boxes className="h-3.5 w-3.5" />}
                    label="In stock"
                    value={data.quantity.toLocaleString()}
                  />
                  <Stat
                    icon={<Calendar className="h-3.5 w-3.5" />}
                    label="Live since"
                    value={new Date(data.liveSinceISO).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  />
                </div>

                <div className="flex items-center gap-2 pt-2 border-t border-border">
                  <Link
                    href={`/marketplace/${data.slug}`}
                    target="_blank"
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-border bg-card text-xs font-semibold hover:bg-foreground/5"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Open public page
                  </Link>
                  <Link
                    href={`/app/seller/products/${data.slug}/edit`}
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-border bg-card text-xs font-semibold hover:bg-foreground/5"
                  >
                    <Tag className="h-3.5 w-3.5" /> Full edit
                  </Link>
                  <Link
                    href={`/admin/products?q=${encodeURIComponent(data.title.split(' ').slice(0, 3).join(' '))}`}
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full text-xs font-semibold text-primary hover:underline"
                  >
                    <CircleDollarSign className="h-3.5 w-3.5" /> See in catalog
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, sub, accent }: { icon: React.ReactNode; label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-2.5 ${accent ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'}`}>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
        {icon} {label}
      </div>
      <p className={`text-lg font-bold tabular-nums mt-1 ${accent ? 'text-primary' : ''}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{sub}</p>}
    </div>
  );
}

/** Trigger that any server component can render. */
export function ProductQuickTrigger({
  slug,
  children,
  className,
}: {
  slug: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('admin:productquick', { detail: { slug } }));
      }}
      className={className}
    >
      {children}
    </button>
  );
}
