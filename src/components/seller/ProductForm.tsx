'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, X, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InstrumentIllustration, type IllustrationName } from '@/components/illustrations/instruments';
import { TiptapEditor } from '@/components/editor/TiptapEditor';
import type { ProductActionError, ProductInputType } from '@/app/app/seller/products/actions';
import { MAX_PRICE_CENTS } from '@/lib/products/validation';
import { resolveInspection, resolveWarranty } from '@/lib/catalog/warranty';
import { DIMENSIONS_SPEC_KEY } from '@/lib/sellers/listing-rules';

const ILLUSTRATIONS: IllustrationName[] = ['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector'];
const CONDITIONS = ['NEW', 'REFURBISHED', 'USED'] as const;
const MODES = [
  { value: 'BUY_NOW',   label: 'Buy now (fixed price)' },
  { value: 'HYBRID',    label: 'Buy now or quote' },
  { value: 'QUOTE_ONLY', label: 'Quote only' },
] as const;
type ShippingClass = 'PARCEL' | 'PALLET' | 'FREIGHT_QUOTE';
const SHIPPING_CLASSES: Record<ShippingClass, string> = {
  PARCEL: 'Parcel',
  PALLET: 'Pallet',
  FREIGHT_QUOTE: 'Freight — quote per order',
};

/** Choices and rules the form shows, from Admin → Settings (see form-options.ts). */
export interface SellerFormOptions {
  categories: { id: string; name: string; slug: string }[];
  brands: { id: string; name: string; slug: string }[];
  /** Currencies staff quote in (Settings → Quotes & offers). */
  currencies: string[];
  /** Used for listings without their own class (Settings → Shipping). */
  defaultShippingClass: ShippingClass;
  warrantyFallbackText: string;
  warrantyMonthsFormat: string;
  inspectionRequiresReport: boolean;
  marginSchemeEnabled: boolean;
  grades: Record<string, { label: string; defaultWarrantyMonths: number | null; warrantyScope: string | null }>;
}

interface Props {
  initial?: Partial<ProductInputType> & { slug?: string; inspectionReportUrl?: string | null };
  options: SellerFormOptions;
  /** The listing belongs to a supplier: its price is what we pay for the unit. */
  supplierPrice: boolean;
  /** Server action wrapper — caller decides create vs update. Redirects on
   *  success; returns a readable error when the server rejects the input. */
  onSubmit: (input: ProductInputType) => Promise<ProductActionError | void>;
  submitLabel?: string;
}

export function ProductForm({ initial, options, supplierPrice, onSubmit, submitLabel = 'Save product' }: Props) {
  const router = useRouter();
  const { categories, brands, currencies, grades } = options;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const initialSpecs = (initial?.specs ?? {}) as Record<string, string>;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? categories[0]?.id ?? '');
  const [brandId, setBrandId] = useState(initial?.brandId ?? '');
  const [condition, setCondition] = useState<'NEW' | 'REFURBISHED' | 'USED'>(initial?.condition ?? 'REFURBISHED');
  const [mode, setMode] = useState<'BUY_NOW' | 'QUOTE_ONLY' | 'HYBRID'>(initial?.mode ?? 'HYBRID');
  const [priceEur, setPriceEur] = useState<string>(initial?.priceCents != null ? String(initial.priceCents / 100) : '');
  const [currency, setCurrency] = useState(initial?.currency ?? currencies[0] ?? 'EUR');
  const [quantity, setQuantity] = useState<string>(initial?.quantity != null ? String(initial.quantity) : '1');
  const [yearMade, setYearMade] = useState<string>(initial?.yearMade ? String(initial.yearMade) : '');
  const [illustration, setIllustration] = useState<IllustrationName>(initial?.illustration ?? 'balance');
  const [images, setImages] = useState<string[]>(initial?.images ?? []);
  // The dimensions are their own field, stored as the "Dimensions" spec row.
  const [specs, setSpecs] = useState<Array<{ k: string; v: string }>>(() => {
    const rows = Object.entries(initialSpecs).filter(([k]) => k !== DIMENSIONS_SPEC_KEY).map(([k, v]) => ({ k, v }));
    return rows.length ? rows : [{ k: '', v: '' }];
  });
  const [dimensions, setDimensions] = useState(initialSpecs[DIMENSIONS_SPEC_KEY] ?? '');
  // ── What is promised about this unit ──
  const initialMonths = initial?.warrantyMonths ?? null;
  const [warrantyMode, setWarrantyMode] = useState<'DEFAULT' | 'NONE' | 'MONTHS'>(
    initialMonths === null ? 'DEFAULT' : initialMonths === 0 ? 'NONE' : 'MONTHS',
  );
  const [warrantyMonthsStr, setWarrantyMonthsStr] = useState<string>(initialMonths && initialMonths > 0 ? String(initialMonths) : '12');
  const [warrantyText, setWarrantyText] = useState(initial?.warrantyText ?? '');
  const [conditionNotes, setConditionNotes] = useState(initial?.conditionNotes ?? '');
  const [inspectedAt, setInspectedAt] = useState(initial?.inspectedAt ?? '');
  const [inspectionNotes, setInspectionNotes] = useState(initial?.inspectionNotes ?? '');
  // ── Shipping and VAT ──
  const [shippingClass, setShippingClass] = useState<ShippingClass | ''>(initial?.shippingClass ?? '');
  const [weightKg, setWeightKg] = useState<string>(initial?.weightKg != null ? String(initial.weightKg) : '');
  const [vatScheme, setVatScheme] = useState<'STANDARD' | 'MARGIN'>(initial?.vatScheme ?? 'STANDARD');
  const [uploading, setUploading] = useState(false);

  const warrantyMonthsValue: number | null =
    warrantyMode === 'DEFAULT' ? null : warrantyMode === 'NONE' ? 0 : Math.max(1, parseInt(warrantyMonthsStr, 10) || 0);
  const grade = grades[condition];
  const warrantyPreview = resolveWarranty(
    { warrantyMonths: warrantyMonthsValue, warrantyText },
    grade ?? { label: condition, defaultWarrantyMonths: null, warrantyScope: null },
    options.warrantyFallbackText,
    options.warrantyMonthsFormat,
  );
  const reportUrl = initial?.inspectionReportUrl ?? null;
  const inspectionPreview = resolveInspection({ inspectedAt: inspectedAt || null, inspectionReportUrl: reportUrl }, options.inspectionRequiresReport);

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
      setImages((prev) => [...prev, data.url]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const specsObj: Record<string, string> = {};
    for (const { k, v } of specs) if (k.trim() && v.trim()) specsObj[k.trim()] = v.trim();

    const input: ProductInputType = {
      title: title.trim(),
      summary: summary.trim() || null,
      description: description.trim() || null,
      categoryId,
      brandId: brandId || null,
      condition,
      mode,
      priceCents: priceEur.trim() ? Math.round(parseFloat(priceEur) * 100) : null,
      currency,
      quantity: quantity.trim() ? Math.max(0, parseInt(quantity, 10) || 0) : 1,
      yearMade: yearMade.trim() ? parseInt(yearMade, 10) : null,
      illustration,
      images,
      specs: specsObj,
      warrantyMonths: warrantyMonthsValue,
      warrantyText: warrantyText.trim() || null,
      conditionNotes: conditionNotes.trim() || null,
      inspectedAt: inspectedAt || null,
      inspectionNotes: inspectionNotes.trim() || null,
      shippingClass: shippingClass || null,
      weightKg: weightKg.trim() ? Number(weightKg.replace(',', '.')) : null,
      dimensions: dimensions.trim() || null,
      vatScheme,
    };

    startTransition(async () => {
      try {
        const r = await onSubmit(input);
        if (r && r.ok === false) {
          setError(r.message);
          setFieldErrors(r.fieldErrors ?? {});
        }
      } catch {
        // Thrown server errors are redacted in production builds, so their
        // text is meaningless to the seller.
        setError('Saving failed. Please check your connection and try again.');
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8 max-w-3xl">
      {/* Basics */}
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-bold">Basics</h2>
        <Field label="Title (required)" hint="Brand + model + form factor. 6–180 characters." error={fieldErrors.title}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={6} maxLength={180} className={inputCls} placeholder="Beckman Allegra X-30R Refrigerated Benchtop Centrifuge" />
        </Field>
        <Field label="Short summary" hint="One sentence shown on listing cards (max 300 characters)." error={fieldErrors.summary}>
          <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300} className={inputCls} placeholder="High-capacity refrigerated benchtop centrifuge with broad rotor selection." />
        </Field>
        <Field
          label="Description"
          hint={`Rich text. Renders on the public product page exactly as you see it here. ${(description ?? '').length.toLocaleString('en-US')} / 8,000 characters including formatting.`}
          error={fieldErrors.description}
          plain
        >
          <TiptapEditor value={description ?? ''} onChange={setDescription} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Category" error={fieldErrors.categoryId}>
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
        </div>
      </section>

      {/* Condition + commerce */}
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-bold">Condition, price &amp; stock</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Condition">
            <select value={condition} onChange={(e) => setCondition(e.target.value as typeof condition)} className={inputCls}>
              {CONDITIONS.map((c) => <option key={c} value={c}>{grades[c]?.label ?? c.charAt(0) + c.slice(1).toLowerCase()}</option>)}
            </select>
          </Field>
          <Field label="Buying mode">
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className={inputCls}>
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field
            label={supplierPrice ? 'Your price (excl. VAT)' : 'Price (excl. VAT)'}
            hint={mode === 'QUOTE_ONLY'
              ? 'Leave blank for quote-only.'
              : supplierPrice
                ? 'What you receive for the unit. Our price to the buyer is set separately.'
                : 'List price ex. VAT.'}
            error={fieldErrors.priceCents}
          >
            <input type="number" min="0" max={MAX_PRICE_CENTS / 100} step="0.01" value={priceEur} onChange={(e) => setPriceEur(e.target.value)} className={inputCls} placeholder="12800" disabled={mode === 'QUOTE_ONLY'} />
          </Field>
          <Field label="Currency" error={fieldErrors.currency}>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls}>
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Quantity in stock" hint="Set 0 when the unit is sold elsewhere: it goes off sale at once." error={fieldErrors.quantity}>
            <input type="number" min="0" max="100000" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Year made" error={fieldErrors.yearMade}>
            <input type="number" min="1900" max="2100" value={yearMade} onChange={(e) => setYearMade(e.target.value)} className={inputCls} placeholder="2020" />
          </Field>
          <Field
            label="VAT scheme"
            hint={options.marginSchemeEnabled
              ? 'Margin scheme: second-hand goods you sell to us without VAT (you bought them without deductible VAT). Otherwise standard VAT.'
              : 'Standard VAT applies: the margin scheme is switched off on this site.'}
            error={fieldErrors.vatScheme}
          >
            <select value={vatScheme} onChange={(e) => setVatScheme(e.target.value as 'STANDARD' | 'MARGIN')} className={inputCls}>
              <option value="STANDARD">Standard VAT</option>
              <option value="MARGIN" disabled={condition === 'NEW' || (!options.marginSchemeEnabled && vatScheme !== 'MARGIN')}>
                Margin scheme (second-hand){condition === 'NEW' ? ' — not for new goods' : ''}
              </option>
            </select>
          </Field>
        </div>
      </section>

      {/* What is promised about THIS unit */}
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <div>
          <h2 className="text-lg font-bold">Warranty &amp; inspection</h2>
          <p className="text-sm text-muted-foreground mt-1">The product page, the order and the invoice state exactly what is set here for this unit.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Warranty" error={fieldErrors.warrantyMonths}>
            <select value={warrantyMode} onChange={(e) => setWarrantyMode(e.target.value as typeof warrantyMode)} className={inputCls}>
              <option value="DEFAULT">
                Condition default ({grade?.defaultWarrantyMonths ? `${grade.defaultWarrantyMonths} months` : 'none'})
              </option>
              <option value="NONE">No warranty (sold as-is)</option>
              <option value="MONTHS">Warranty of …</option>
            </select>
          </Field>
          {warrantyMode === 'MONTHS' && (
            <Field label="Months" error={fieldErrors.warrantyMonths}>
              <input type="number" min={1} max={120} step={1} value={warrantyMonthsStr} onChange={(e) => setWarrantyMonthsStr(e.target.value)} className={inputCls} />
            </Field>
          )}
          <Field label="Warranty terms" hint="Scope, e.g. “parts and labour, functional defects”." error={fieldErrors.warrantyText}>
            <input value={warrantyText} onChange={(e) => setWarrantyText(e.target.value)} maxLength={500} className={inputCls} />
          </Field>
        </div>
        <p className="text-xs rounded-lg bg-foreground/[0.03] border border-border px-3 py-2">
          Buyers read: <strong>{warrantyPreview.full}</strong>
        </p>
        <Field label="Condition notes" hint="Cosmetic marks, missing accessories, hours run… shown on the product page." error={fieldErrors.conditionNotes}>
          <input value={conditionNotes} onChange={(e) => setConditionNotes(e.target.value)} maxLength={1000} className={inputCls} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Inspected on" hint="Only if this unit was really inspected." error={fieldErrors.inspectedAt}>
            <input type="date" value={inspectedAt} onChange={(e) => setInspectedAt(e.target.value)} className={inputCls} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Inspection notes" hint="What was checked (optional)." error={fieldErrors.inspectionNotes}>
              <input value={inspectionNotes} onChange={(e) => setInspectionNotes(e.target.value)} maxLength={1000} className={inputCls} />
            </Field>
          </div>
        </div>
        <p className="text-xs rounded-lg bg-foreground/[0.03] border border-border px-3 py-2">
          {inspectionPreview.claim
            ? 'Buyers read: “This unit was inspected on …”.'
            : inspectionPreview.reason === 'NO_REPORT'
              ? 'No inspection claim is shown until the inspection report is on the listing: send the report to our team and we attach it.'
              : 'No inspection claim is shown for this unit.'}
        </p>
      </section>

      {/* Shipping — drives the freight quote at checkout */}
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <div>
          <h2 className="text-lg font-bold">Shipping</h2>
          <p className="text-sm text-muted-foreground mt-1">The shipping class and weight decide the freight buyers are quoted at checkout.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Shipping class" error={fieldErrors.shippingClass}>
            <select value={shippingClass} onChange={(e) => setShippingClass(e.target.value as ShippingClass | '')} className={inputCls}>
              <option value="">Default ({SHIPPING_CLASSES[options.defaultShippingClass]})</option>
              {(Object.keys(SHIPPING_CLASSES) as ShippingClass[]).map((c) => <option key={c} value={c}>{SHIPPING_CLASSES[c]}</option>)}
            </select>
          </Field>
          <Field label="Weight per unit (kg)" hint="Packed weight." error={fieldErrors.weightKg}>
            <input type="number" min="0" max="100000" step="0.1" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} className={inputCls} placeholder="85" />
          </Field>
          <Field label="Dimensions" hint="L × W × H, e.g. 120 × 80 × 95 cm." error={fieldErrors.dimensions}>
            <input value={dimensions} onChange={(e) => setDimensions(e.target.value)} maxLength={120} className={inputCls} placeholder="120 × 80 × 95 cm" />
          </Field>
        </div>
      </section>

      {/* Cover preview + fallback illustration */}
      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold">Cover image</h2>
        <p className="text-sm text-muted-foreground mt-1 mb-4">
          {images.length > 0 ? (
            <>
              The <strong>first uploaded photo</strong> below is used as the cover on the marketplace card and product page.
              Drop a different photo in the &ldquo;Real photos&rdquo; section below to change it.
            </>
          ) : (
            <>
              No real photos uploaded yet — the listing falls back to one of these generic illustrations.
              Upload a real photo in the section below to replace this with the actual instrument image.
            </>
          )}
        </p>

        <div className="grid sm:grid-cols-[260px_1fr] gap-5 items-start">
          <div>
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
              What buyers will see
            </p>
            <div className="aspect-[4/3] rounded-xl border border-border bg-muted overflow-hidden flex items-center justify-center">
              {images[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={images[0]} alt="Cover preview" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-[hsl(82_55%_95%)] to-[hsl(168_30%_94%)] p-3">
                  <InstrumentIllustration name={illustration} />
                </div>
              )}
            </div>
            <p className="text-[11px] mt-1.5 text-muted-foreground">
              {images[0] ? 'Real photo (uploaded)' : `Generic illustration · ${illustration}`}
            </p>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
              Fallback illustration {images.length > 0 && <span className="text-amber-700 dark:text-amber-300 normal-case font-normal">(only used if no photos)</span>}
            </p>
            <div className={`grid grid-cols-3 sm:grid-cols-4 gap-2 ${images.length > 0 ? 'opacity-60' : ''}`}>
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

      {/* Images */}
      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold">Real photos (optional)</h2>
        <p className="text-sm text-muted-foreground mt-1 mb-4">Adds real photography to the product page. JPG/PNG/WebP, up to 8&nbsp;MB each.</p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {images.map((url) => (
            <div key={url} className="relative aspect-[4/3] rounded-xl border border-border overflow-hidden bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((u) => u !== url))}
                className="absolute top-1 right-1 h-7 w-7 rounded-full bg-foreground/80 text-background flex items-center justify-center hover:bg-foreground"
                aria-label="Remove image"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <label className="aspect-[4/3] rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-primary hover:bg-foreground/[0.02] transition-colors">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleFile} disabled={uploading} className="sr-only" />
            {uploading ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : <Upload className="h-5 w-5 text-muted-foreground" />}
            <span className="text-xs font-medium text-muted-foreground">{uploading ? 'Uploading…' : 'Add image'}</span>
          </label>
        </div>
        {fieldErrors.images && (
          <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">{fieldErrors.images}</p>
        )}
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-4 py-3 text-sm">{error}</div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 items-center">
        <Button type="submit" size="lg" disabled={pending} className="rounded-2xl font-semibold w-full sm:w-auto">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} className="rounded-2xl font-semibold">
          Cancel
        </Button>
      </div>
    </form>
  );
}

const inputCls =
  'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-50';

function Field({
  label,
  hint,
  error,
  plain,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  /** Render a <div>, not a <label>: a label forwards clicks on its text to its
   *  first button, which in the rich-text editor is the Bold toolbar button. */
  plain?: boolean;
  children: React.ReactNode;
}) {
  const Wrapper = plain ? 'div' : 'label';
  return (
    <Wrapper className="block">
      <span className="block text-sm font-semibold mb-1">{label}</span>
      {hint && <span className="block text-xs text-muted-foreground mb-1.5">{hint}</span>}
      {children}
      {error && <span className="block text-xs font-medium text-red-600 dark:text-red-400 mt-1">{error}</span>}
    </Wrapper>
  );
}
