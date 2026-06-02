'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Loader2, Link2, AlertTriangle, CheckCircle2, ShieldAlert, Save, ExternalLink, Sparkles, Cloud, Code, ImageIcon, Tag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { previewProductFromUrl, createDraftFromExtraction } from '@/app/admin/actions';
import type { ImportRunResult } from '@/lib/import/run';

interface Props {
  categories: { slug: string; name: string }[];
  companies: { slug: string; name: string }[];
}

const ILLUSTRATIONS = ['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector'] as const;

function fmtPrice(cents: number | null, currency: string): string {
  if (cents == null) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100); }
  catch { return `${currency} ${(cents / 100).toFixed(2)}`; }
}

const PLATFORM_LABEL: Record<string, { label: string; tone: string; icon: React.ReactNode }> = {
  'woo':        { label: 'WooCommerce Store API', tone: 'bg-emerald-100 text-emerald-900', icon: <Cloud className="h-3 w-3" /> },
  'shopify':    { label: 'Shopify JSON',          tone: 'bg-emerald-100 text-emerald-900', icon: <Cloud className="h-3 w-3" /> },
  'json-ld':    { label: 'JSON-LD schema.org',    tone: 'bg-blue-100 text-blue-900',       icon: <Code className="h-3 w-3" /> },
  'opengraph':  { label: 'OpenGraph meta',        tone: 'bg-amber-100 text-amber-900',     icon: <Code className="h-3 w-3" /> },
  'ai-fallback':{ label: 'AI fallback',           tone: 'bg-purple-100 text-purple-900',   icon: <Sparkles className="h-3 w-3" /> },
  'unknown':    { label: 'Not detected',          tone: 'bg-foreground/10 text-foreground', icon: <AlertTriangle className="h-3 w-3" /> },
};

export function UrlImportForm({ categories, companies }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [url, setUrl] = useState(searchParams.get('url') ?? '');
  // ?shop=<slug> arrives when the user lands here from the in-app shop browser.
  // Pre-select that supplier so the imported product is filed under the
  // correct Company without manual selection.
  const initialShop = searchParams.get('shop') ?? '';
  const [autoStartedRef] = useState({ done: false });
  const [previewing, startPreview] = useTransition();
  const [committing, startCommit] = useTransition();
  const [result, setResult] = useState<ImportRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successSlug, setSuccessSlug] = useState<string | null>(null);

  // Editable form derived from extraction
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [brand, setBrand] = useState('');
  const [description, setDescription] = useState('');
  const [priceEur, setPriceEur] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [categorySlug, setCategorySlug] = useState(categories[0]?.slug ?? '');
  const [companySlug, setCompanySlug] = useState(initialShop);
  const [condition, setCondition] = useState<'NEW' | 'REFURBISHED' | 'USED'>('REFURBISHED');
  const [illustration, setIllustration] = useState<typeof ILLUSTRATIONS[number]>('balance');
  const [imagesText, setImagesText] = useState('');
  const [specsText, setSpecsText] = useState('');

  // Auto-run when URL is pre-filled via ?url= query (e.g., user arrived
  // from the in-app shop browser's "Add via AI" button).
  useEffect(() => {
    if (autoStartedRef.done) return;
    const initial = searchParams.get('url');
    if (initial && !result) {
      autoStartedRef.done = true;
      setTimeout(() => runPreview(), 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function runPreview() {
    setError(null); setResult(null); setSuccessSlug(null);
    if (!/^https?:\/\//i.test(url)) { setError('URL must start with http:// or https://'); return; }
    startPreview(async () => {
      const r = await previewProductFromUrl(url.trim());
      setResult(r);
      if (r.ok && r.product) {
        setTitle(r.product.title);
        setSummary(r.product.summary ?? '');
        setBrand(r.product.brand ?? '');
        setDescription(r.product.description ?? '');
        setPriceEur(r.product.priceCents != null ? (r.product.priceCents / 100).toString() : '');
        setCurrency(r.product.currency || 'EUR');
        setImagesText(r.product.images.join('\n'));
        setSpecsText(Object.entries(r.product.specs).map(([k, v]) => `${k}: ${v}`).join('\n'));
      }
    });
  }

  function commit() {
    if (!result?.product) return;
    setError(null);
    if (title.trim().length < 6) { setError('Title must be at least 6 characters.'); return; }
    const images = imagesText.split('\n').map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)).slice(0, 8);
    const specs: Record<string, string> = {};
    for (const line of specsText.split('\n')) {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      if (m) specs[m[1].trim().slice(0, 80)] = m[2].trim().slice(0, 200);
    }
    const price = priceEur.trim() ? Math.round(parseFloat(priceEur) * 100) : null;
    startCommit(async () => {
      const r = await createDraftFromExtraction({
        sourceUrl: url.trim(),
        title: title.trim(),
        summary: summary.trim() || null,
        brand: brand.trim() || null,
        description: description.trim() || null,
        priceCents: Number.isFinite(price as number) ? (price ?? null) : null,
        currency: currency || 'EUR',
        categorySlug,
        companySlug: companySlug || null,
        condition,
        images,
        specs,
        illustration,
      });
      if (r.ok && r.slug) {
        setSuccessSlug(r.slug);
        router.refresh();
      } else {
        setError(r.message);
      }
    });
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Step 1 — paste URL */}
      <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-2 text-sm font-bold">
          <Link2 className="h-4 w-4 text-primary" /> Step 1 — paste a product URL
        </div>
        <div className="flex gap-2 flex-wrap">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/product/agilent-1200-hplc"
            className="flex-1 min-w-[280px] h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            onKeyDown={(e) => { if (e.key === 'Enter') runPreview(); }}
          />
          <Button onClick={runPreview} disabled={previewing || !url.trim()} className="rounded-full font-semibold">
            {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Analyse URL
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Tries WooCommerce → Shopify → JSON-LD → OpenGraph → AI fallback. Only public http/https URLs are allowed (private + loopback IPs are blocked).
        </p>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm font-semibold flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" /> {error}
        </div>
      )}

      {successSlug && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-sm font-semibold flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>
            Draft created — slug <code>{successSlug}</code>.
            {' '}<a href={`/admin/products/${successSlug}`} className="underline">Open the full editor →</a>
          </span>
        </div>
      )}

      {/* Pipeline attempts */}
      {result && (
        <section className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-bold mb-3">
            <Cloud className="h-4 w-4 text-primary" /> Pipeline result
          </div>
          <div className="flex items-center gap-2 flex-wrap mb-3">
            {(() => { const meta = PLATFORM_LABEL[result.platform] ?? PLATFORM_LABEL['unknown']; return (
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${meta.tone}`}>{meta.icon} {meta.label}</span>
            ); })()}
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
              result.confidence === 'high' ? 'bg-emerald-100 text-emerald-900' :
              result.confidence === 'medium' ? 'bg-amber-100 text-amber-900' :
              'bg-foreground/10 text-foreground'
            }`}>{result.confidence} confidence</span>
            {result.finalUrl && (
              <a href={result.finalUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline inline-flex items-center gap-1 ml-auto">
                <ExternalLink className="h-3 w-3" /> {(() => { try { return new URL(result.finalUrl).hostname; } catch { return result.finalUrl; } })()}
              </a>
            )}
          </div>
          <ol className="space-y-1 text-xs">
            {result.attempts.map((a, i) => {
              const meta = PLATFORM_LABEL[a.platform] ?? PLATFORM_LABEL['unknown'];
              return (
                <li key={i} className="flex items-center gap-2 text-muted-foreground">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${meta.tone.replace('bg-', 'bg-').replace('text-', 'text-')} opacity-90`}>{meta.icon} {meta.label}</span>
                  <span>
                    {a.outcome === 'matched' && <strong className="text-emerald-700">matched ✓</strong>}
                    {a.outcome === 'skipped' && <span>skipped{a.note ? ` — ${a.note}` : ''}</span>}
                    {a.outcome === 'error'   && <span className="text-red-700">error: {a.note ?? 'unknown'}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          {!result.ok && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-sm flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" /> {result.error}
            </div>
          )}
        </section>
      )}

      {/* Step 2 — review + edit */}
      {result?.ok && result.product && !successSlug && (
        <section className="rounded-2xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-bold">
            <Save className="h-4 w-4 text-primary" /> Step 2 — review &amp; create draft
          </div>

          {result.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-xs">
              <p className="font-bold flex items-center gap-1.5 mb-1"><ShieldAlert className="h-3.5 w-3.5" /> Warnings</p>
              <ul className="list-disc ml-5 space-y-0.5">
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {/* Live preview as marketplace card */}
          <div className="grid sm:grid-cols-[280px_1fr] gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Preview card</p>
              <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="aspect-[4/3] bg-muted relative overflow-hidden">
                  {imagesText.split('\n')[0]?.trim() && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imagesText.split('\n')[0].trim()} alt="" className="w-full h-full object-cover" />
                  )}
                </div>
                <div className="p-3 space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{brand || '—'}</p>
                  <p className="font-semibold leading-snug line-clamp-2 min-h-[2.6em]">{title || '(no title)'}</p>
                  <p className="text-lg font-bold tabular-nums">
                    {fmtPrice(priceEur ? Math.round(parseFloat(priceEur) * 100) : null, currency)}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <Field label="Title (required)">
                <input value={title} onChange={(e) => setTitle(e.target.value)} className={input} />
              </Field>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Brand">
                  <input value={brand} onChange={(e) => setBrand(e.target.value)} className={input} placeholder="Agilent" />
                </Field>
                <Field label="Currency">
                  <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={4} className={input} />
                </Field>
                <Field label="Price (no decimals = EUR cents)">
                  <input value={priceEur} onChange={(e) => setPriceEur(e.target.value)} type="number" step="0.01" className={input} placeholder="9800" />
                </Field>
                <Field label="Condition">
                  <select value={condition} onChange={(e) => setCondition(e.target.value as typeof condition)} className={input}>
                    <option value="REFURBISHED">Refurbished</option>
                    <option value="USED">Used</option>
                    <option value="NEW">New</option>
                  </select>
                </Field>
                <Field label="Category">
                  <select value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)} className={input}>
                    {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                  </select>
                </Field>
                <Field label={<span className="inline-flex items-center gap-1.5">Supplier{initialShop && companySlug === initialShop && <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-900 text-[9px] font-bold uppercase tracking-wider">auto-linked</span>}</span>}>
                  <select value={companySlug} onChange={(e) => setCompanySlug(e.target.value)} className={input}>
                    <option value="">lab2date (own inventory)</option>
                    {companies.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                  </select>
                </Field>
                <Field label="Fallback illustration">
                  <select value={illustration} onChange={(e) => setIllustration(e.target.value as typeof illustration)} className={input}>
                    {ILLUSTRATIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Short summary (≤ 280 chars)">
                <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={280} className={input} />
              </Field>
              <Field label="Description (markdown OK)">
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className={`${input} h-auto py-2 leading-snug`} />
              </Field>
              <Field label={<span className="inline-flex items-center gap-1.5"><ImageIcon className="h-3.5 w-3.5" /> Image URLs (one per line, ≤ 8)</span>}>
                <textarea value={imagesText} onChange={(e) => setImagesText(e.target.value)} rows={3} className={`${input} h-auto py-2 leading-snug text-xs`} />
              </Field>
              <Field label={<span className="inline-flex items-center gap-1.5"><Tag className="h-3.5 w-3.5" /> Specs (one per line: Key: Value)</span>}>
                <textarea value={specsText} onChange={(e) => setSpecsText(e.target.value)} rows={3} className={`${input} h-auto py-2 leading-snug text-xs`} placeholder={`Max speed: 18,500 RPM\nWeight: 32 kg`} />
              </Field>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button onClick={commit} disabled={committing || !title.trim()} className="rounded-full font-semibold">
              {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Create draft
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

const input = 'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1">{label}</span>
      {children}
    </label>
  );
}
