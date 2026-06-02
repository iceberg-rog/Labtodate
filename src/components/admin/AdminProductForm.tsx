'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, X, Loader2, Save, Star, Trash2, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InstrumentIllustration, type IllustrationName } from '@/components/illustrations/instruments';
import { TiptapEditor } from '@/components/editor/TiptapEditor';
import type { AdminProductInputType } from '@/app/admin/actions';

const ILLUSTRATIONS: IllustrationName[] = ['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector'];
const CONDITIONS = ['NEW', 'REFURBISHED', 'USED'] as const;
const MODES = [
  { value: 'BUY_NOW',   label: 'Buy now (fixed price)' },
  { value: 'HYBRID',    label: 'Buy now or quote' },
  { value: 'QUOTE_ONLY', label: 'Quote only' },
] as const;
const STATUSES = [
  { value: 'PUBLISHED',      label: 'Published (live)' },
  { value: 'DRAFT',          label: 'Draft (hidden)' },
  { value: 'PENDING_REVIEW', label: 'Pending review' },
  { value: 'ARCHIVED',       label: 'Archived' },
] as const;

interface Props {
  initial?: Partial<AdminProductInputType> & { slug?: string };
  categories: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  companies: { id: string; name: string }[];
  onSubmit: (input: AdminProductInputType) => Promise<{ ok: true; slug?: string } | { ok: boolean; message: string } | void>;
  submitLabel?: string;
}

export function AdminProductForm({ initial, categories, brands, companies, onSubmit, submitLabel = 'Save product' }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const [title, setTitle] = useState(initial?.title ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? categories[0]?.id ?? '');
  const [brandId, setBrandId] = useState(initial?.brandId ?? '');
  const [companyId, setCompanyId] = useState(initial?.companyId ?? '');
  const [condition, setCondition] = useState<'NEW' | 'REFURBISHED' | 'USED'>(initial?.condition ?? 'REFURBISHED');
  const [mode, setMode] = useState<'BUY_NOW' | 'QUOTE_ONLY' | 'HYBRID'>(initial?.mode ?? 'HYBRID');
  const [priceEur, setPriceEur] = useState<string>(initial?.priceCents ? String(initial.priceCents / 100) : '');
  const [quantity, setQuantity] = useState<string>(initial?.quantity != null ? String(initial.quantity) : '1');
  const [yearMade, setYearMade] = useState<string>(initial?.yearMade ? String(initial.yearMade) : '');
  const [illustration, setIllustration] = useState<IllustrationName>(initial?.illustration ?? 'balance');
  const [images, setImages] = useState<string[]>(initial?.images ?? []);
  const [status, setStatus] = useState<'PUBLISHED' | 'DRAFT' | 'PENDING_REVIEW' | 'ARCHIVED'>(initial?.status ?? 'PUBLISHED');
  const [specs, setSpecs] = useState<Array<{ k: string; v: string }>>(
    initial?.specs
      ? Object.entries(initial.specs as Record<string, string>).map(([k, v]) => ({ k, v }))
      : [{ k: '', v: '' }],
  );
  const [uploading, setUploading] = useState(false);
  const [coverReplaceMode, setCoverReplaceMode] = useState(false);

  /** Upload action: either appends a new image OR replaces the current cover
   *  (images[0]). Tracked by the `coverReplaceMode` flag so the user can
   *  unambiguously swap the cover without first deleting it. */
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setImages((prev) => {
        if (coverReplaceMode && prev.length > 0) {
          // bust browser cache of the cover by replacing index 0
          return [data.url, ...prev.slice(1)];
        }
        return [...prev, data.url];
      });
      setCoverReplaceMode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  function makeCover(url: string) {
    setImages((prev) => {
      const rest = prev.filter((u) => u !== url);
      return [url, ...rest];
    });
  }

  function removeImage(url: string) {
    setImages((prev) => prev.filter((u) => u !== url));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedMsg(null);

    const specsObj: Record<string, string> = {};
    for (const { k, v } of specs) if (k.trim() && v.trim()) specsObj[k.trim()] = v.trim();

    const input: AdminProductInputType = {
      title: title.trim(),
      summary: summary.trim() || null,
      description: description.trim() || null,
      categoryId,
      brandId: brandId || null,
      companyId: companyId || null,
      condition,
      mode,
      priceCents: priceEur.trim() ? Math.round(parseFloat(priceEur) * 100) : null,
      currency: 'EUR',
      quantity: quantity.trim() ? Math.max(0, parseInt(quantity, 10) || 0) : 1,
      yearMade: yearMade.trim() ? parseInt(yearMade, 10) : null,
      illustration,
      images,
      specs: specsObj,
      status,
    };

    startTransition(async () => {
      try {
        const r = await onSubmit(input);
        if (r && 'ok' in r && r.ok === false) {
          setError('message' in r ? r.message : 'Save failed.');
        } else {
          // Persistent success badge — stays until next save or navigation.
          // Tested operator habit: they expect a confirmation to linger.
          setSavedMsg(`✓ Saved at ${new Date().toLocaleTimeString()}`);
          router.refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed');
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8 max-w-4xl">
      {/* Basics + ownership */}
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-bold">Basics</h2>
        <Field label="Title (required)" hint="Brand + model + form factor.">
          <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={6} className={inputCls} placeholder="Beckman Allegra X-30R Refrigerated Benchtop Centrifuge" />
        </Field>
        <Field label="Short summary" hint="One sentence shown on listing cards.">
          <input value={summary} onChange={(e) => setSummary(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Description" hint="Rich text. Renders on the public product page exactly as you see it here.">
          <TiptapEditor value={description ?? ''} onChange={setDescription} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Category">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputCls}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Brand">
            <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className={inputCls}>
              <option value="">(no brand)</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Shop / supplier" hint="Leave blank = lab2date own inventory.">
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
              <option value="">lab2date (own inventory)</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
      </section>

      {/* Condition + commerce */}
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-bold">Condition, pricing & visibility</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Field label="Condition">
            <select value={condition} onChange={(e) => setCondition(e.target.value as typeof condition)} className={inputCls}>
              {CONDITIONS.map((c) => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>)}
            </select>
          </Field>
          <Field label="Buying mode">
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className={inputCls}>
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={inputCls}>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Price (EUR)" hint={mode === 'QUOTE_ONLY' ? 'Quote-only — leave blank.' : 'List price ex. VAT.'}>
            <input type="number" min="0" step="0.01" value={priceEur} onChange={(e) => setPriceEur(e.target.value)} className={inputCls} placeholder="12800" disabled={mode === 'QUOTE_ONLY'} />
          </Field>
          <Field label="Quantity in stock">
            <input type="number" min="0" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Year made">
            <input type="number" min="1900" max="2100" value={yearMade} onChange={(e) => setYearMade(e.target.value)} className={inputCls} placeholder="2020" />
          </Field>
        </div>
      </section>

      {/* Cover preview + photos with explicit Make-cover / Replace-cover UX */}
      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold">Cover image & photos</h2>
        <p className="text-sm text-muted-foreground mt-1 mb-4">
          The <strong>first photo</strong> is used as the cover on the marketplace card and product page.
          Use <strong>Make cover</strong> on any tile to promote it, or <strong>Replace cover</strong> to upload a new
          file that overwrites the current cover.
        </p>

        <div className="grid sm:grid-cols-[260px_1fr] gap-5 items-start">
          {/* Cover preview */}
          <div>
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
              What buyers will see
            </p>
            <div className="aspect-[4/3] rounded-xl border border-border bg-muted overflow-hidden flex items-center justify-center">
              {images[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={images[0]} alt="Cover preview" className="w-full h-full object-cover" key={images[0]} />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-[hsl(82_55%_95%)] to-[hsl(168_30%_94%)] p-3">
                  <InstrumentIllustration name={illustration} />
                </div>
              )}
            </div>
            <p className="text-[11px] mt-1.5 text-muted-foreground">
              {images[0] ? 'Real photo' : `Generic illustration · ${illustration}`}
            </p>
            {images[0] && (
              <label className="inline-flex items-center gap-1.5 mt-2 cursor-pointer text-xs font-semibold text-primary hover:underline">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={(e) => { setCoverReplaceMode(true); handleFile(e); }}
                  disabled={uploading}
                  className="sr-only"
                />
                {uploading && coverReplaceMode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
                Replace cover
              </label>
            )}
          </div>

          {/* All photos grid */}
          <div>
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
              All photos ({images.length}/8)
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
              {images.map((url, idx) => (
                <div key={url} className="relative aspect-[4/3] rounded-xl border border-border overflow-hidden bg-muted group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  {idx === 0 && (
                    <span className="absolute top-1 left-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-400 text-amber-950 text-[9px] font-bold uppercase">
                      <Star className="h-2.5 w-2.5 fill-current" /> Cover
                    </span>
                  )}
                  <div className="absolute inset-0 bg-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1.5">
                    {idx !== 0 && (
                      <button
                        type="button"
                        onClick={() => makeCover(url)}
                        className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-amber-400 text-amber-950 hover:bg-amber-300"
                      >
                        Make cover
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeImage(url)}
                      className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-red-500 text-white hover:bg-red-600 inline-flex items-center gap-1"
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  </div>
                </div>
              ))}
              {images.length < 8 && (
                <label className="aspect-[4/3] rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-primary hover:bg-foreground/[0.02] transition-colors">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    onChange={(e) => { setCoverReplaceMode(false); handleFile(e); }}
                    disabled={uploading}
                    className="sr-only"
                  />
                  {uploading && !coverReplaceMode ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : <Upload className="h-5 w-5 text-muted-foreground" />}
                  <span className="text-xs font-medium text-muted-foreground">{uploading && !coverReplaceMode ? 'Uploading…' : 'Add image'}</span>
                </label>
              )}
            </div>

            {images.length === 0 && (
              <>
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
                  Fallback illustration (used when no photos)
                </p>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  {ILLUSTRATIONS.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setIllustration(name)}
                      className={`relative rounded-xl border-2 p-2 aspect-[4/3] bg-gradient-to-br from-[hsl(82_55%_95%)] to-[hsl(168_30%_94%)] transition-colors ${
                        illustration === name ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/40'
                      }`}
                      aria-pressed={illustration === name}
                    >
                      <InstrumentIllustration name={name} />
                      <span className="absolute bottom-1 left-2 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                        {name}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Specs */}
      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold">Technical specs</h2>
        <p className="text-sm text-muted-foreground mt-1 mb-4">Key-value pairs displayed in the spec table.</p>
        <div className="space-y-2">
          {specs.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2">
              <input value={row.k} onChange={(e) => setSpecs(prev => prev.map((r, j) => j === i ? { ...r, k: e.target.value } : r))} placeholder="Max speed" className={inputCls} />
              <input value={row.v} onChange={(e) => setSpecs(prev => prev.map((r, j) => j === i ? { ...r, v: e.target.value } : r))} placeholder="18,500 RPM" className={inputCls} />
              <Button type="button" variant="ghost" size="icon" onClick={() => setSpecs(prev => prev.filter((_, j) => j !== i))} aria-label="Remove spec row">
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setSpecs(prev => [...prev, { k: '', v: '' }])} className="rounded-full">
            + Add spec row
          </Button>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">{error}</div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 items-center sticky bottom-3 z-20 bg-background/80 backdrop-blur-sm border border-border rounded-2xl p-3 shadow-sm">
        <Button type="submit" size="lg" disabled={pending} className="rounded-2xl font-semibold w-full sm:w-auto gap-2">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} className="rounded-2xl font-semibold">
          Cancel
        </Button>
        {savedMsg && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-900 text-sm font-bold">
            {savedMsg}
          </span>
        )}
      </div>
    </form>
  );
}

const inputCls =
  'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-50';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1">{label}</span>
      {hint && <span className="block text-xs text-muted-foreground mb-1.5">{hint}</span>}
      {children}
    </label>
  );
}
