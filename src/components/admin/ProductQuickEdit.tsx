'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  X,
  Save,
  ExternalLink,
  Loader2,
  CheckCircle2,
  XCircle,
  Image as ImageIcon,
  Tag,
  Boxes,
  CircleDollarSign,
  Archive,
  Eye,
  EyeOff,
} from 'lucide-react';
import { quickUpdateProduct } from '@/app/admin/actions';

type Status = 'DRAFT' | 'PENDING_REVIEW' | 'PUBLISHED' | 'ARCHIVED';

export type ProductRow = {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  category: string;
  condition: string;
  status: Status;
  priceCents: number | null;
  currency: string;
  quantity: number;
  seller: { name: string; email: string };
  shop: { name: string; slug: string } | null;
  image: string | null;
};

const STATUS_LABEL: Record<Status, string> = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending review',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
};

const STATUS_BADGE: Record<Status, string> = {
  DRAFT: 'bg-foreground/10 text-foreground',
  PENDING_REVIEW: 'bg-amber-100 text-amber-800',
  PUBLISHED: 'bg-emerald-100 text-emerald-800',
  ARCHIVED: 'bg-foreground/10 text-muted-foreground',
};

function fmt(cents: number | null, currency: string) {
  if (cents === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function ProductQuickEdit({
  open,
  product,
  onClose,
}: {
  open: boolean;
  product: ProductRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);

  const [price, setPrice] = useState<string>('');
  const [qty, setQty] = useState<string>('');
  const [status, setStatus] = useState<Status>('DRAFT');

  useEffect(() => {
    if (!product) return;
    setRes(null);
    setPrice(product.priceCents === null ? '' : (product.priceCents / 100).toFixed(2));
    setQty(String(product.quantity));
    setStatus(product.status);
  }, [product]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    if (open) {
      window.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open || !product) return null;

  const dirty =
    String(product.priceCents === null ? '' : (product.priceCents / 100).toFixed(2)) !== price ||
    String(product.quantity) !== qty ||
    product.status !== status;

  function save() {
    if (!product) return;
    const patch: Parameters<typeof quickUpdateProduct>[1] = {};
    const trimmed = price.trim();
    if (trimmed === '') {
      patch.priceCents = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) {
        setRes({ ok: false, message: 'Price must be a positive number or empty.' });
        return;
      }
      patch.priceCents = Math.round(n * 100);
    }
    const q = Number(qty);
    if (!Number.isFinite(q) || q < 0) {
      setRes({ ok: false, message: 'Quantity must be 0 or higher.' });
      return;
    }
    patch.quantity = q;
    patch.status = status;
    start(async () => {
      const r = await quickUpdateProduct(product.slug, patch);
      setRes(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" role="dialog" aria-modal>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="relative w-full md:max-w-2xl bg-card border border-border md:rounded-2xl shadow-xl max-h-[92vh] overflow-auto">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 p-5 border-b border-border bg-card">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              {product.brand ?? '—'} · {product.category}
            </p>
            <h2 className="text-lg font-bold truncate">{product.title}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Listed by {product.seller.name} ({product.seller.email})
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-foreground/5 text-muted-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div className="flex gap-4 flex-wrap">
            <div className="h-28 w-28 rounded-xl bg-foreground/5 border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
              {product.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={product.image} alt={product.title} className="object-cover w-full h-full" />
              ) : (
                <ImageIcon className="h-7 w-7 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1 min-w-[180px] space-y-1.5 text-sm">
              <p className="flex items-center gap-1.5 text-xs"><Tag className="h-3.5 w-3.5 text-muted-foreground" /> Condition: <span className="font-semibold">{product.condition.toLowerCase()}</span></p>
              <p className="flex items-center gap-1.5 text-xs"><CircleDollarSign className="h-3.5 w-3.5 text-muted-foreground" /> Current price: <span className="font-semibold">{fmt(product.priceCents, product.currency)}</span></p>
              <p className="flex items-center gap-1.5 text-xs"><Boxes className="h-3.5 w-3.5 text-muted-foreground" /> In stock: <span className="font-semibold">{product.quantity}</span></p>
              <p className="flex items-center gap-1.5 text-xs">
                Status:&nbsp;
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${STATUS_BADGE[product.status]}`}>
                  {STATUS_LABEL[product.status]}
                </span>
              </p>
            </div>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="block text-xs font-semibold mb-1.5">Price ({product.currency})</span>
              <input
                type="number"
                step="0.01"
                min={0}
                value={price}
                placeholder="leave blank = quote-only"
                onChange={(e) => setPrice(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-semibold mb-1.5">In stock</span>
              <input
                type="number"
                min={0}
                step={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
              />
              <span className="text-[11px] text-muted-foreground mt-0.5 block">
                0 = sold out (Buy button hidden).
              </span>
            </label>
            <label className="block">
              <span className="block text-xs font-semibold mb-1.5">Status</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Status)}
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
              >
                <option value="DRAFT">Draft (hidden)</option>
                <option value="PENDING_REVIEW">Pending review</option>
                <option value="PUBLISHED">Published (live)</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </label>
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap pt-3 border-t border-border">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pending || !dirty}
                onClick={save}
                className="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save changes
              </button>
              {dirty && <span className="text-[11px] text-amber-700 font-semibold">unsaved</span>}
              {res && (
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                    res.ok ? 'text-emerald-600' : 'text-red-600'
                  }`}
                >
                  {res.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                  {res.message}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Link
                href={`/marketplace/${product.slug}`}
                target="_blank"
                className="inline-flex items-center gap-1 px-3 h-9 rounded-full border border-border font-semibold hover:bg-foreground/5"
              >
                <ExternalLink className="h-3.5 w-3.5" /> View live
              </Link>
              <Link
                href={`/admin/products/${product.slug}`}
                className="inline-flex items-center gap-1 px-3 h-9 rounded-full border border-border font-semibold hover:bg-foreground/5"
              >
                Full edit page →
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-2 text-xs">
            <QuickStatusBtn
              current={status}
              target="PUBLISHED"
              icon={<Eye className="h-3.5 w-3.5" />}
              label="Publish"
              onSet={setStatus}
            />
            <QuickStatusBtn
              current={status}
              target="DRAFT"
              icon={<EyeOff className="h-3.5 w-3.5" />}
              label="Hide (draft)"
              onSet={setStatus}
            />
            <QuickStatusBtn
              current={status}
              target="ARCHIVED"
              icon={<Archive className="h-3.5 w-3.5" />}
              label="Archive"
              onSet={setStatus}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickStatusBtn({
  current,
  target,
  icon,
  label,
  onSet,
}: {
  current: Status;
  target: Status;
  icon: React.ReactNode;
  label: string;
  onSet: (s: Status) => void;
}) {
  const on = current === target;
  return (
    <button
      type="button"
      onClick={() => onSet(target)}
      className={`inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-full font-semibold border ${
        on ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-foreground/5'
      }`}
    >
      {icon} {label}
    </button>
  );
}

/** Container that maps rows -> clickable cards + popup. */
export function ProductBrowser({ rows }: { rows: ProductRow[] }) {
  const [active, setActive] = useState<ProductRow | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
        <p className="text-lg font-semibold">No products match</p>
        <p className="text-sm text-muted-foreground mt-2">Try a different search or filter.</p>
      </div>
    );
  }

  // Group by category for clearer navigation.
  const grouped = new Map<string, ProductRow[]>();
  for (const r of rows) {
    const k = r.category;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(r);
  }

  return (
    <>
      <div className="space-y-6">
        {Array.from(grouped.entries()).map(([cat, items]) => (
          <section key={cat}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider font-bold text-muted-foreground">
                {cat}
              </h3>
              <span className="text-[11px] text-muted-foreground tabular-nums">{items.length}</span>
            </div>
            <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
              {items.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setActive(p)}
                    className="w-full text-left p-4 flex items-center gap-4 hover:bg-foreground/[0.03] transition-colors"
                  >
                    <div className="h-12 w-12 rounded-lg bg-foreground/5 border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
                      {p.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.image} alt="" className="object-cover w-full h-full" />
                      ) : (
                        <ImageIcon className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                        {p.brand ?? '—'} · {p.condition.toLowerCase()}
                      </p>
                      <p className="font-semibold truncate">{p.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                        {p.shop ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground text-[10px] font-bold uppercase tracking-wider">
                            {p.shop.name}
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold uppercase tracking-wider">
                            Own
                          </span>
                        )}
                        <span className="truncate">{p.seller.name}</span>
                      </p>
                    </div>
                    <div className="text-right flex flex-col items-end gap-1 flex-shrink-0">
                      <span className="text-sm font-bold tabular-nums">
                        {fmt(p.priceCents, p.currency)}
                      </span>
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        stock: {p.quantity}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${STATUS_BADGE[p.status]}`}>
                        {STATUS_LABEL[p.status]}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <ProductQuickEdit open={!!active} product={active} onClose={() => setActive(null)} />
    </>
  );
}
