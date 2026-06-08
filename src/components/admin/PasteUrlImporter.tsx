'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  Loader2,
  Link2,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  ImageIcon,
  ExternalLink,
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { previewProductFromUrl, createDraftFromExtraction } from '@/app/admin/actions';

interface Category {
  slug: string;
  name: string;
}

interface Props {
  companySlug: string;
  initialUrl?: string | null;
  categories: Category[];
}

type Preview = Awaited<ReturnType<typeof previewProductFromUrl>>;

const CONDITIONS = ['NEW', 'REFURBISHED', 'USED'] as const;
const ILLUSTRATIONS = [
  'balance', 'microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'gc', 'autosampler', 'detector',
] as const;

// Best-guess lab-equipment metadata from a product title.
// Empty string = "I don't know — keep current value".
function detectFromTitle(title: string): {
  brand: string;
  category: string;
  illustration: typeof ILLUSTRATIONS[number] | '';
  condition: typeof CONDITIONS[number] | '';
} {
  const t = title.toLowerCase();
  // Brands — first hit wins, ordered by specificity.
  const BRANDS: { match: RegExp; label: string }[] = [
    { match: /\bagilent\b/, label: 'Agilent' },
    { match: /\b(hewlett.?packard|\bhp\b)/, label: 'Hewlett-Packard' },
    { match: /\bthermo\b|\bfinnigan\b/, label: 'Thermo Scientific' },
    { match: /\bperkin.?elmer\b/, label: 'PerkinElmer' },
    { match: /\bwaters\b/, label: 'Waters' },
    { match: /\bshimadzu\b/, label: 'Shimadzu' },
    { match: /\bzeiss\b|\bcarl zeiss\b/, label: 'Zeiss' },
    { match: /\bbruker\b/, label: 'Bruker' },
    { match: /\bbeckman\b/, label: 'Beckman Coulter' },
    { match: /\beppendorf\b/, label: 'Eppendorf' },
    { match: /\bmettler\b/, label: 'Mettler Toledo' },
    { match: /\bnikon\b/, label: 'Nikon' },
    { match: /\bolympus\b/, label: 'Olympus' },
    { match: /\bleica\b/, label: 'Leica' },
    { match: /\bvarian\b/, label: 'Varian' },
    { match: /\bdionex\b/, label: 'Dionex' },
    { match: /\bsciex\b|\babsciex\b/, label: 'SCIEX' },
  ];
  const brand = BRANDS.find((b) => b.match.test(t))?.label ?? '';
  // Category + illustration mapping (slug must exist in your DB Category list).
  const CATS: { match: RegExp; slug: string; illustration: typeof ILLUSTRATIONS[number] }[] = [
    { match: /\b(mass spec|mass.spectromet|maldi|orbitrap|q.?tof|ltq|tsq|quadrupole|triple.?quad|ion trap)\b/, slug: 'mass-spec', illustration: 'massspec' },
    { match: /\b(hplc|uplc|uhplc|liquid chromatograph|lc.?ms|ic system|ion chromatograph)\b/, slug: 'hplc-lc', illustration: 'hplc' },
    { match: /\b(gas chromatograph|\bgc\b|gc.?ms|gc.?fid|gc.?tcd|gc.?ecd|headspace)\b/, slug: 'gc', illustration: 'gc' },
    { match: /\b(autosampler|auto.?sampler|als|injector)\b/, slug: 'autosamplers', illustration: 'autosampler' },
    { match: /\b(detector|fid\b|ecd\b|tcd\b|dad\b|pda\b|fluorescence detector|uv.?vis detector|elsd|refractive)\b/, slug: 'detectors', illustration: 'detector' },
    { match: /\b(centrifuge|rotor|micro.?fuge|ultracentrifuge)\b/, slug: 'centrifuges', illustration: 'centrifuge' },
    { match: /\b(microscope|microscopy|stereo|confocal|fluorescence microscope|imaging)\b/, slug: 'microscopy', illustration: 'microscope' },
    { match: /\b(spectrophotometer|spectroscopy|ftir|ft.?ir|nmr|raman|uv.?vis spectro|nir spec|aas|icp.?oes|icp.?ms)\b/, slug: 'spectroscopy', illustration: 'detector' },
    { match: /\b(pump|fluidic|peristaltic|hplc pump|syringe pump)\b/, slug: 'pumps-fluidics', illustration: 'hplc' },
    { match: /\b(vacuum|gas generator|nitrogen generator|hydrogen generator)\b/, slug: 'vacuum-gas', illustration: 'detector' },
    { match: /\b(thermocycler|pcr|qpcr|rt.?pcr|real.?time pcr)\b/, slug: 'general-lab', illustration: 'pcr' },
    { match: /\b(balance|analytical balance|microbalance|scale)\b/, slug: 'general-lab', illustration: 'balance' },
    { match: /\b(part|module|column|filter|consumable|spare|kit)\b/, slug: 'parts-modules', illustration: 'detector' },
  ];
  const cat = CATS.find((c) => c.match.test(t));
  let condition: typeof CONDITIONS[number] | '' = '';
  if (/\b(refurb|reconditioned)/.test(t)) condition = 'REFURBISHED';
  else if (/\b(used|second.?hand|pre.?owned)/.test(t)) condition = 'USED';
  else if (/\b(new|brand new|unused)/.test(t)) condition = 'NEW';
  return {
    brand,
    category: cat?.slug ?? '',
    illustration: cat?.illustration ?? '',
    condition,
  };
}

export function PasteUrlImporter({ companySlug, initialUrl, categories }: Props) {
  const [url, setUrl] = useState('');
  const [pendingPreview, startPreview] = useTransition();
  const [pendingSave, startSave] = useTransition();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ slug: string; existing?: boolean } | null>(null);

  // Editable form fields (initialised from extraction, user can refine)
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [brand, setBrand] = useState('');
  const [categorySlug, setCategorySlug] = useState(categories[0]?.slug ?? 'general-lab');
  const [condition, setCondition] = useState<typeof CONDITIONS[number]>('REFURBISHED');
  const [priceCents, setPriceCents] = useState<string>('');
  const [currency, setCurrency] = useState('EUR');
  const [illustration, setIllustration] = useState<typeof ILLUSTRATIONS[number]>('balance');

  function extract(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setSaved(null);
    setPreview(null);
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setError('Paste a full https:// product URL.');
      return;
    }
    startPreview(async () => {
      try {
        const r = await previewProductFromUrl(trimmed);
        setPreview(r);
        if (r.product) {
          const t = r.product.title || '';
          const guess = detectFromTitle(t);
          setTitle(t);
          setSummary(r.product.summary || r.product.description?.slice(0, 280) || '');
          // Prefer explicit brand from extractor; else guess from title.
          setBrand((r.product.brand || guess.brand || '').trim());
          // Prefer explicit condition from extractor; else from title; else keep REFURBISHED default.
          if (r.product.condition) setCondition(r.product.condition);
          else if (guess.condition) setCondition(guess.condition);
          setPriceCents(r.product.priceCents != null ? String(r.product.priceCents) : '');
          setCurrency(r.product.currency || 'EUR');
          // Auto-pick a matching category if our guess exists in the list.
          if (guess.category && categories.some((c) => c.slug === guess.category)) {
            setCategorySlug(guess.category);
          }
          if (guess.illustration) setIllustration(guess.illustration);
        } else {
          setError(r.error || 'Could not extract a product from this URL.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Extraction failed.');
      }
    });
  }

  function save() {
    if (!preview?.product) return;
    setError(null);
    startSave(async () => {
      try {
        const r = await createDraftFromExtraction({
          sourceUrl: preview.finalUrl ?? preview.url,
          title: title.trim(),
          summary: summary.trim() || null,
          description: preview.product?.description ?? null,
          brand: brand.trim() || null,
          categorySlug,
          companySlug,
          condition,
          priceCents: priceCents.trim() ? parseInt(priceCents, 10) || null : null,
          currency: currency.trim() || 'EUR',
          images: preview.product?.images ?? [],
          specs: preview.product?.specs ?? {},
          illustration,
        });
        if (r.ok && r.slug) {
          setSaved({ slug: r.slug });
        } else if (r.existing) {
          setSaved({ slug: r.existing.slug, existing: true });
        } else {
          setError(r.message);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed.');
      }
    });
  }

  const product = preview?.product;
  const confidenceColor =
    preview?.confidence === 'high' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' :
    preview?.confidence === 'medium' ? 'text-amber-700 bg-amber-50 border-amber-200' :
    preview?.confidence === 'low' ? 'text-orange-700 bg-orange-50 border-orange-200' :
    'text-muted-foreground bg-foreground/[0.04] border-border';

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-bold inline-flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" /> Paste a product URL
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Browse the supplier in <strong>your own browser</strong>, copy the product URL, paste it below.
          We fetch the page server-side, extract the product (WooCommerce / Shopify / JSON-LD / OpenGraph /
          AI fallback), and create a <strong>draft</strong> you can review before publishing.
        </p>
      </div>

      <form onSubmit={extract} className="flex gap-2 flex-wrap">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={initialUrl ? `e.g. ${initialUrl.replace(/\/$/, '')}/product/...` : 'https://supplier.com/product/zeiss-confocal-lsm-700'}
          className="flex-1 min-w-[240px] h-10 px-3 rounded-lg border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          autoComplete="off"
        />
        <Button type="submit" disabled={pendingPreview || !url.trim()} className="rounded-lg font-semibold">
          {pendingPreview ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Extract
        </Button>
      </form>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 text-red-900 px-3 py-2.5 text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0 break-words">{error}</div>
        </div>
      )}

      {saved && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-3 py-3 text-sm flex items-center justify-between gap-3 flex-wrap">
          <span className="font-semibold inline-flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            {saved.existing ? 'Already imported — opening existing draft.' : 'Draft created.'}
          </span>
          <Link
            href={`/admin/products/${saved.slug}`}
            className="inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline"
          >
            Open draft <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      )}

      {product && !saved && (
        <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="inline-flex items-center gap-2 text-xs">
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold ${confidenceColor}`}>
                Source: {preview!.platform} · {preview!.confidence} confidence
              </span>
              {preview!.warnings.length > 0 && (
                <span className="text-amber-700">{preview!.warnings.length} warning{preview!.warnings.length === 1 ? '' : 's'}</span>
              )}
            </div>
            <a
              href={preview!.finalUrl ?? preview!.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-muted-foreground hover:underline inline-flex items-center gap-1"
            >
              View source <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[120px_1fr] gap-4">
            <div className="rounded-xl border border-border bg-foreground/[0.02] aspect-square flex items-center justify-center overflow-hidden">
              {product.images[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={product.images[0]} alt="" className="h-full w-full object-cover" />
              ) : (
                <ImageIcon className="h-8 w-8 text-muted-foreground/40" />
              )}
            </div>
            <div className="space-y-2 min-w-0">
              <label className="block">
                <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Title</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full h-9 px-2.5 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Brand</span>
                <input
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  className="w-full h-9 px-2.5 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                />
              </label>
            </div>
          </div>

          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Summary (1-2 lines)</span>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={2}
              className="w-full px-2.5 py-1.5 rounded-md border border-input bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </label>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="block">
              <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Category</span>
              <select
                value={categorySlug}
                onChange={(e) => setCategorySlug(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              >
                {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Condition</span>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value as typeof CONDITIONS[number])}
                className="w-full h-9 px-2.5 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              >
                {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Price (cents)</span>
              <input
                value={priceCents}
                onChange={(e) => setPriceCents(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                placeholder="e.g. 450000 = €4,500"
                className="w-full h-9 px-2.5 rounded-md border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Illustration</span>
              <select
                value={illustration}
                onChange={(e) => setIllustration(e.target.value as typeof ILLUSTRATIONS[number])}
                className="w-full h-9 px-2.5 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              >
                {ILLUSTRATIONS.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </label>
          </div>

          {product.images.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {product.images.slice(0, 8).map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={src + i} src={src} alt="" className="h-14 w-14 rounded-md object-cover border border-border flex-shrink-0" />
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => { setPreview(null); setUrl(''); setError(null); }}
              className="rounded-lg"
            >
              Reset
            </Button>
            <Button
              type="button"
              onClick={save}
              disabled={pendingSave || !title.trim() || title.trim().length < 6}
              className="rounded-lg font-semibold"
            >
              {pendingSave ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Create draft
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
