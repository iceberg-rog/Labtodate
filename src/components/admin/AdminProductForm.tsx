'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, X, Loader2, Save, Star, Trash2, ArrowUp, ShieldCheck, FileText, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InstrumentIllustration, type IllustrationName } from '@/components/illustrations/instruments';
import { TiptapEditor } from '@/components/editor/TiptapEditor';
import type { AdminProductInputType } from '@/app/admin/actions';
import { MAX_ADMIN_PRODUCT_IMAGES, MAX_PRICE_CENTS } from '@/lib/products/validation';
import { resolveWarranty, resolveInspection } from '@/lib/catalog/warranty';
import { NoPhoto, type MissingPhotoMode } from '@/components/marketplace/NoPhoto';

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

/** Condition grade data the form previews the warranty with (Admin → Catalog → Conditions). */
export interface FormConditionGrade {
  label: string;
  defaultWarrantyMonths: number | null;
  warrantyScope: string | null;
}

interface Props {
  initial?: Partial<AdminProductInputType> & { slug?: string };
  categories: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  companies: { id: string; name: string }[];
  /** For the "what buyers will read" preview. */
  grades?: Record<'NEW' | 'REFURBISHED' | 'USED', FormConditionGrade>;
  warrantyFallbackText?: string;
  warrantyMonthsFormat?: string;
  inspectionRequiresReport?: boolean;
  /** Settings → Tax & VAT → margin scheme on (hint on the VAT scheme field). */
  marginSchemeEnabled?: boolean;
  /** Settings → Catalog & claims: what a listing without photos shows buyers. */
  photoMode?: MissingPhotoMode;
  photoLabels?: { noPhoto?: string; illustration?: string };
  /** Stored photo URL → the path buyers get it from (null = not ours: hidden from buyers). */
  publicPaths?: Record<string, string | null>;
  /** Labels of the condition grades (Admin → Catalog → Conditions & warranty). */
  onSubmit: (
    input: AdminProductInputType,
  ) => Promise<{ ok: true; slug?: string } | { ok: boolean; message: string; fieldErrors?: Record<string, string> } | void>;
  submitLabel?: string;
}

export function AdminProductForm({
  initial,
  categories,
  brands,
  companies,
  grades,
  warrantyFallbackText,
  warrantyMonthsFormat,
  inspectionRequiresReport = true,
  marginSchemeEnabled = false,
  photoMode = 'PLACEHOLDER',
  photoLabels,
  publicPaths = {},
  onSubmit,
  submitLabel = 'Save product',
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [title, setTitle] = useState(initial?.title ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? categories[0]?.id ?? '');
  const [brandId, setBrandId] = useState(initial?.brandId ?? '');
  const [companyId, setCompanyId] = useState(initial?.companyId ?? '');
  // A new product has no condition until the admin chooses one (never a silent “Refurbished”).
  const [condition, setCondition] = useState<'NEW' | 'REFURBISHED' | 'USED' | ''>(initial?.condition ?? '');
  const [mode, setMode] = useState<'BUY_NOW' | 'QUOTE_ONLY' | 'HYBRID'>(initial?.mode ?? 'HYBRID');
  const [priceEur, setPriceEur] = useState<string>(initial?.priceCents != null ? String(initial.priceCents / 100) : '');
  const [quantity, setQuantity] = useState<string>(initial?.quantity != null ? String(initial.quantity) : '1');
  const [yearMade, setYearMade] = useState<string>(initial?.yearMade ? String(initial.yearMade) : '');
  const [illustration, setIllustration] = useState<IllustrationName | null>(initial?.illustration ?? null);
  const [images, setImages] = useState<string[]>(initial?.images ?? []);
  // New products start as drafts: publishing is a deliberate step.
  const [status, setStatus] = useState<'PUBLISHED' | 'DRAFT' | 'PENDING_REVIEW' | 'ARCHIVED'>(initial?.status ?? 'DRAFT');
  // Uploaded in this session: our own store (the upload API returns the /media path).
  const [uploadedPaths, setUploadedPaths] = useState<Record<string, string>>({});
  /** The path buyers load a stored photo from, or null when it is not ours (never loaded here either). */
  const publicSrc = (u: string): string | null =>
    uploadedPaths[u] ?? (u in publicPaths ? publicPaths[u] : /^\/media\/[^/]/.test(u) ? u : null);
  const buyerPhotos = images.map(publicSrc).filter((x): x is string => !!x);
  const [specs, setSpecs] = useState<Array<{ k: string; v: string }>>(
    initial?.specs
      ? Object.entries(initial.specs as Record<string, string>).map(([k, v]) => ({ k, v }))
      : [{ k: '', v: '' }],
  );
  const [uploading, setUploading] = useState(false);
  const [coverReplaceMode, setCoverReplaceMode] = useState(false);
  // ── What we promise about this unit ──
  const initialMonths = initial?.warrantyMonths ?? null;
  const [warrantyMode, setWarrantyMode] = useState<'DEFAULT' | 'NONE' | 'MONTHS'>(
    initialMonths === null ? 'DEFAULT' : initialMonths === 0 ? 'NONE' : 'MONTHS',
  );
  const [warrantyMonthsStr, setWarrantyMonthsStr] = useState<string>(initialMonths && initialMonths > 0 ? String(initialMonths) : '12');
  const [warrantyText, setWarrantyText] = useState(initial?.warrantyText ?? '');
  const [conditionNotes, setConditionNotes] = useState(initial?.conditionNotes ?? '');
  const [inspectedAt, setInspectedAt] = useState(initial?.inspectedAt ?? '');
  const [inspectionReportUrl, setInspectionReportUrl] = useState(initial?.inspectionReportUrl ?? '');
  const [inspectionNotes, setInspectionNotes] = useState(initial?.inspectionNotes ?? '');
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [mpn, setMpn] = useState(initial?.mpn ?? '');
  const [vatScheme, setVatScheme] = useState<'STANDARD' | 'MARGIN'>(initial?.vatScheme ?? 'STANDARD');
  const [purchaseCost, setPurchaseCost] = useState<string>(initial?.purchaseCostCents != null ? (initial.purchaseCostCents / 100).toFixed(2) : '');
  const [reportUploading, setReportUploading] = useState(false);

  const warrantyMonthsValue: number | null =
    warrantyMode === 'DEFAULT' ? null : warrantyMode === 'NONE' ? 0 : Math.max(1, parseInt(warrantyMonthsStr, 10) || 0);
  const grade = condition ? grades?.[condition] : undefined;
  const warrantyPreview = resolveWarranty(
    { warrantyMonths: warrantyMonthsValue, warrantyText },
    grade ?? { label: condition || 'No condition', defaultWarrantyMonths: null, warrantyScope: null },
    warrantyFallbackText,
    warrantyMonthsFormat,
  );
  const inspectionPreview = resolveInspection({ inspectedAt: inspectedAt || null, inspectionReportUrl }, inspectionRequiresReport);

  async function handleReport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setReportUploading(true);
    setError(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/admin/inspection-report', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setInspectionReportUrl(data.url);
    } catch (err) {
      setError(err instanceof Error ? `Inspection report not uploaded: ${err.message}` : 'Inspection report not uploaded.');
    } finally {
      setReportUploading(false);
      e.target.value = '';
    }
  }

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
      // Store the host-relative /media path (survives a domain / IP change).
      const stored: string = data.path || data.url;
      setUploadedPaths((m) => ({ ...m, [stored]: data.path || data.url }));
      setImages((prev) => {
        if (coverReplaceMode && prev.length > 0) {
          // bust browser cache of the cover by replacing index 0
          return [stored, ...prev.slice(1)];
        }
        return [...prev, stored];
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
    setFieldErrors({});

    const specsObj: Record<string, string> = {};
    for (const { k, v } of specs) if (k.trim() && v.trim()) specsObj[k.trim()] = v.trim();
    if (!condition) {
      setError('Choose the condition of this unit. Nothing was saved.');
      setFieldErrors({ condition: 'Choose a condition.' });
      return;
    }

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
      warrantyMonths: warrantyMonthsValue,
      warrantyText: warrantyText.trim() || null,
      conditionNotes: conditionNotes.trim() || null,
      inspectedAt: inspectedAt || null,
      inspectionReportUrl: inspectionReportUrl || null,
      inspectionNotes: inspectionNotes.trim() || null,
      sku: sku.trim() || null,
      mpn: mpn.trim() || null,
      vatScheme,
      purchaseCostCents: purchaseCost.trim() ? Math.round(parseFloat(purchaseCost.replace(',', '.')) * 100) : null,
    };

    startTransition(async () => {
      try {
        const r = await onSubmit(input);
        if (r && 'ok' in r && r.ok === false) {
          setError('message' in r ? r.message : 'Save failed.');
          setFieldErrors(('fieldErrors' in r && r.fieldErrors) || {});
        } else {
          // Persistent success badge — stays until next save or navigation.
          // Tested operator habit: they expect a confirmation to linger.
          // The server may say more than "saved" (e.g. which fields are now
          // locked against supplier syncs) — show its message.
          const serverMsg = r && 'message' in r && typeof r.message === 'string' ? r.message.replace(/\.$/, '') : 'Saved';
          setSavedMsg(`✓ ${serverMsg} (${new Date().toLocaleTimeString()})`);
          router.refresh();
        }
      } catch {
        // Thrown server errors are redacted in production builds.
        setError('Saving failed. Please check your connection and try again.');
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8 max-w-4xl">
      {/* Basics + ownership */}
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-bold">Basics</h2>
        <Field label="Title (required)" hint="Brand + model + form factor." error={fieldErrors.title}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={2} maxLength={200} className={inputCls} placeholder="Beckman Allegra X-30R Refrigerated Benchtop Centrifuge" />
        </Field>
        <Field label="Short summary" hint="One sentence shown on listing cards (max 300 characters)." error={fieldErrors.summary}>
          <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300} className={inputCls} />
        </Field>
        <Field label="Description" hint="Rich text. Renders on the public product page exactly as you see it here." error={fieldErrors.description} plain>
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
          <Field label="Condition" error={fieldErrors.condition}>
            <select value={condition} onChange={(e) => setCondition(e.target.value as typeof condition)} className={inputCls} required name="condition">
              {!condition && <option value="">— choose —</option>}
              {CONDITIONS.map((c) => <option key={c} value={c}>{grades?.[c]?.label ?? c.charAt(0) + c.slice(1).toLowerCase()}</option>)}
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
          <Field label="Price (EUR)" hint={mode === 'QUOTE_ONLY' ? 'Quote-only — leave blank.' : 'List price ex. VAT.'} error={fieldErrors.priceCents}>
            <input type="number" min="0" max={MAX_PRICE_CENTS / 100} step="0.01" value={priceEur} onChange={(e) => setPriceEur(e.target.value)} className={inputCls} placeholder="12800" disabled={mode === 'QUOTE_ONLY'} />
          </Field>
          <Field label="Quantity in stock" error={fieldErrors.quantity}>
            <input type="number" min="0" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Year made" error={fieldErrors.yearMade}>
            <input type="number" min="1900" max="2100" value={yearMade} onChange={(e) => setYearMade(e.target.value)} className={inputCls} placeholder="2020" />
          </Field>
        </div>
      </section>

      {/* What we promise about THIS unit — never a site-wide claim */}
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4" data-testid="truth-section">
        <div>
          <h2 className="text-lg font-bold inline-flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" /> Warranty, inspection &amp; identity
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            The product page, the order and the invoice state exactly what is set here for this unit.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Warranty" error={fieldErrors.warrantyMonths}>
            <select value={warrantyMode} onChange={(e) => setWarrantyMode(e.target.value as typeof warrantyMode)} className={inputCls} name="warrantyMode">
              <option value="DEFAULT">
                Condition default ({grade?.defaultWarrantyMonths ? `${grade.defaultWarrantyMonths} months` : 'none set'})
              </option>
              <option value="NONE">No warranty (sold as-is)</option>
              <option value="MONTHS">Warranty of …</option>
            </select>
          </Field>
          {warrantyMode === 'MONTHS' && (
            <Field label="Months" error={fieldErrors.warrantyMonths}>
              <input type="number" min={1} max={120} step={1} value={warrantyMonthsStr} onChange={(e) => setWarrantyMonthsStr(e.target.value)} className={inputCls} name="warrantyMonths" />
            </Field>
          )}
          <Field label="Warranty terms / notes" hint="Scope, e.g. “parts and labour, functional defects”." error={fieldErrors.warrantyText}>
            <input value={warrantyText} onChange={(e) => setWarrantyText(e.target.value)} maxLength={500} className={inputCls} name="warrantyText" />
          </Field>
        </div>
        <p className="text-xs rounded-lg bg-foreground/[0.03] border border-border px-3 py-2" data-testid="warranty-preview">
          Buyers read: <strong>{warrantyPreview.full}</strong>
        </p>
        <Field label="Condition notes" hint="Cosmetic marks, missing accessories, hours run… shown on the product page." error={fieldErrors.conditionNotes}>
          <input value={conditionNotes} onChange={(e) => setConditionNotes(e.target.value)} maxLength={1000} className={inputCls} name="conditionNotes" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Inspected on" hint="Only if this unit was really inspected." error={fieldErrors.inspectedAt}>
            <input type="date" value={inspectedAt} onChange={(e) => setInspectedAt(e.target.value)} className={inputCls} name="inspectedAt" />
          </Field>
          <div className="sm:col-span-2">
            <span className="block text-sm font-semibold mb-1">Inspection report</span>
            <span className="block text-xs text-muted-foreground mb-1.5">PDF or photo, max 15 MB. Shown to buyers while the item is published.</span>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-input bg-background text-sm font-medium cursor-pointer hover:bg-foreground/[0.03]">
                <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" onChange={handleReport} disabled={reportUploading} />
                {reportUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {inspectionReportUrl ? 'Replace report' : 'Upload report'}
              </label>
              {inspectionReportUrl && (
                <>
                  <a href={inspectionReportUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
                    <FileText className="h-4 w-4" /> Open report
                  </a>
                  <button type="button" onClick={() => setInspectionReportUrl('')} className="text-xs text-red-700 dark:text-red-300 hover:underline">
                    Remove
                  </button>
                </>
              )}
            </div>
            {fieldErrors.inspectionReportUrl && <span className="block text-xs font-medium text-red-600 dark:text-red-400 mt-1">{fieldErrors.inspectionReportUrl}</span>}
          </div>
        </div>
        <Field label="Inspection notes" hint="What was checked (optional)." error={fieldErrors.inspectionNotes}>
          <input value={inspectionNotes} onChange={(e) => setInspectionNotes(e.target.value)} maxLength={1000} className={inputCls} name="inspectionNotes" />
        </Field>
        <p className="text-xs rounded-lg bg-foreground/[0.03] border border-border px-3 py-2" data-testid="inspection-preview">
          {inspectionPreview.claim
            ? 'Buyers read: “This unit was inspected on …” with the report link.'
            : inspectionPreview.reason === 'NO_REPORT'
              ? 'No inspection claim is shown: upload the report first (Settings → Catalog & claims requires one).'
              : 'No inspection claim is shown for this unit.'}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Stock number (SKU)" hint="Your own stock number. Used in search-engine data." error={fieldErrors.sku}>
            <input value={sku} onChange={(e) => setSku(e.target.value)} maxLength={64} className={inputCls} name="sku" />
          </Field>
          <Field label="Manufacturer part number (MPN)" hint="e.g. G1311-60001." error={fieldErrors.mpn}>
            <input value={mpn} onChange={(e) => setMpn(e.target.value)} maxLength={64} className={inputCls} name="mpn" />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" data-testid="vat-scheme-fields">
          <Field
            label="VAT scheme"
            hint={marginSchemeEnabled
              ? 'Margin scheme: second-hand goods bought without deductible VAT (from a private person / under the margin scheme). Invoiced without separate VAT; VAT is due on the margin.'
              : 'The margin scheme is switched off (Settings → Tax & VAT): units marked here are invoiced with normal VAT until it is switched on.'}
            error={fieldErrors.vatScheme}
          >
            <select value={vatScheme} onChange={(e) => setVatScheme(e.target.value as 'STANDARD' | 'MARGIN')} className={inputCls} name="vatScheme">
              <option value="STANDARD">Standard VAT</option>
              <option value="MARGIN" disabled={condition === 'NEW'}>Margin scheme (second-hand){condition === 'NEW' ? ' — not for new goods' : ''}</option>
            </select>
          </Field>
          <Field label="Purchase cost (€, what you paid for this unit)" hint="Internal, never shown to buyers. Required for the margin scheme: the margin VAT is computed from it." error={fieldErrors.purchaseCostCents}>
            <input value={purchaseCost} onChange={(e) => setPurchaseCost(e.target.value)} inputMode="decimal" placeholder={vatScheme === 'MARGIN' ? 'e.g. 4200.00' : 'optional'} className={inputCls} name="purchaseCost" />
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
            <div className="aspect-[4/3] rounded-xl border border-border bg-muted overflow-hidden flex items-center justify-center" data-testid="buyer-preview">
              {buyerPhotos[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={buyerPhotos[0]} alt="Cover preview" className="w-full h-full object-cover" key={buyerPhotos[0]} />
              ) : (
                <NoPhoto mode={photoMode} illustration={illustration} labels={photoLabels} />
              )}
            </div>
            <p className="text-[11px] mt-1.5 text-muted-foreground">
              {buyerPhotos[0]
                ? 'Our own photo of this unit — shown to buyers.'
                : images.length
                  ? `The ${images.length === 1 ? 'photo is' : `${images.length} photos are`} not in our media store yet, so buyers see this instead. Use “Copy supplier photos to our store” on the products list.`
                  : photoMode === 'LABELLED_ILLUSTRATION' && illustration
                    ? 'No photo: buyers see this drawing with its “not the actual item” label (Settings → Catalog & claims).'
                    : 'No photo: buyers see this placeholder (Settings → Catalog & claims).'}
            </p>
            {buyerPhotos[0] && (
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
              All photos ({images.length}/{MAX_ADMIN_PRODUCT_IMAGES})
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
              {images.map((url, idx) => (
                <div key={url} className="relative aspect-[4/3] rounded-xl border border-border overflow-hidden bg-muted group">
                  {publicSrc(url) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={publicSrc(url)!} alt="" className="w-full h-full object-cover" />
                  ) : (
                    // Not in our store: never loaded from the supplier's server (privacy, referrer leak).
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1 p-2 text-center text-[10px] font-semibold text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40" title={url}>
                      <EyeOff className="h-4 w-4" />
                      Not copied yet — hidden from buyers
                    </div>
                  )}
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
              {images.length < MAX_ADMIN_PRODUCT_IMAGES && (
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

            {buyerPhotos.length === 0 && (
              <>
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
                  Drawing shown without photos (only with “Instrument drawing” in Settings → Catalog & claims)
                </p>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  <button
                    type="button"
                    onClick={() => setIllustration(null)}
                    className={`relative rounded-xl border-2 p-2 aspect-[4/3] bg-muted text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors ${
                      illustration === null ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/40'
                    }`}
                    aria-pressed={illustration === null}
                  >
                    None
                  </button>
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
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-4 py-3 text-sm">{error}</div>
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
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-300 text-sm font-bold">
            {savedMsg}
          </span>
        )}
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
