'use client';

import { useState, useTransition } from 'react';
import { Loader2, ArrowRight, User, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { submitSellAndRedirect, type SellInputType } from '@/lib/sell/actions';

export function SellForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sellerType, setSellerType] = useState<'INDIVIDUAL' | 'COMPANY'>('COMPANY');
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const f of files) {
        if (images.length >= 8) break;
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/sell-upload', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error || 'Image upload failed.');
          continue;
        }
        if (data.url) setImages((prev) => (prev.length < 8 ? [...prev, data.url] : prev));
      }
    } finally {
      setUploading(false);
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const num = (v: FormDataEntryValue | null) => {
      const n = parseInt(String(v ?? ''), 10);
      return Number.isFinite(n) ? n : null;
    };

    const input: SellInputType = {
      sellerType,
      contactName: String(fd.get('contactName') ?? ''),
      email: String(fd.get('email') ?? ''),
      phone: (fd.get('phone') as string) || null,
      companyName: (fd.get('companyName') as string) || null,
      country: (fd.get('country') as string) || null,
      itemTitle: String(fd.get('itemTitle') ?? ''),
      brand: (fd.get('brand') as string) || null,
      model: (fd.get('model') as string) || null,
      category: (fd.get('category') as string) || null,
      condition: (String(fd.get('condition') ?? 'USED') as 'NEW' | 'REFURBISHED' | 'USED'),
      yearMade: num(fd.get('yearMade')),
      quantity: num(fd.get('quantity')) ?? 1,
      askingPrice: (fd.get('askingPrice') as string) || null,
      location: (fd.get('location') as string) || null,
      description: String(fd.get('description') ?? ''),
      accessories: (fd.get('accessories') as string) || null,
      reason: (fd.get('reason') as string) || null,
      availability: (fd.get('availability') as string) || null,
      photosUrl: (fd.get('photosUrl') as string) || null,
      images,
    };

    startTransition(async () => {
      try {
        const res = await submitSellAndRedirect(input);
        if (res && !res.ok) setError(res.error);
      } catch (err) {
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        setError(err instanceof Error ? err.message : 'Failed to submit');
      }
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-border bg-card p-6 md:p-8 space-y-8 shadow-sm"
    >
      {/* Seller type */}
      <div>
        <SectionTitle step="01" title="Who is selling?" />
        <div className="grid grid-cols-2 gap-3 mt-4">
          <TypeToggle
            active={sellerType === 'COMPANY'}
            onClick={() => setSellerType('COMPANY')}
            icon={Building2}
            label="Company / Lab"
            sub="Institution, dealer, or facility"
          />
          <TypeToggle
            active={sellerType === 'INDIVIDUAL'}
            onClick={() => setSellerType('INDIVIDUAL')}
            icon={User}
            label="Individual"
            sub="Private seller"
          />
        </div>
      </div>

      {/* Contact */}
      <div className="space-y-4">
        <SectionTitle step="02" title="Your contact details" />
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Full name" name="contactName" placeholder="Dr. Jane Doe" required />
          <Field label="Email" name="email" type="email" placeholder="you@lab.com" required />
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Phone" name="phone" placeholder="+31 6 1234 5678" />
          <Field label="Country" name="country" placeholder="Netherlands" />
        </div>
        {sellerType === 'COMPANY' && (
          <Field label="Company / Institution" name="companyName" placeholder="Pivot Park B.V." />
        )}
      </div>

      {/* Equipment */}
      <div className="space-y-4">
        <SectionTitle step="03" title="What are you selling?" />
        <Field
          label="Item title"
          name="itemTitle"
          placeholder="Agilent 1260 Infinity II HPLC system"
          required
        />
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Brand" name="brand" placeholder="Agilent" />
          <Field label="Model" name="model" placeholder="1260 Infinity II" />
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Category" name="category" placeholder="HPLC / Chromatography" />
          <SelectField
            label="Condition"
            name="condition"
            options={[
              ['USED', 'Used — working'],
              ['REFURBISHED', 'Refurbished'],
              ['NEW', 'New / unused'],
            ]}
          />
        </div>
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Year made" name="yearMade" type="number" placeholder="2018" />
          <Field label="Quantity" name="quantity" type="number" placeholder="1" defaultValue="1" />
          <Field label="Asking price" name="askingPrice" placeholder="€18,000 or offer" />
        </div>
        <Field label="Location of the item" name="location" placeholder="Oss, Netherlands" />
        <Field
          label="Description"
          name="description"
          textarea
          minLength={20}
          required
          placeholder="Specs, configuration, service history, known issues, run hours, decommission reason — the more detail, the faster and more accurate our valuation."
        />
      </div>

      {/* Extra details */}
      <div className="space-y-4">
        <SectionTitle step="04" title="A few more details" />
        <Field
          label="Accessories & extras included"
          name="accessories"
          textarea
          placeholder="Columns, autosampler trays, software licence, manuals, spare parts…"
        />
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Reason for selling" name="reason" placeholder="Lab upgrade" />
          <Field label="Availability" name="availability" placeholder="Ready to ship now" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1.5">Photos (optional)</label>
          <p className="text-xs text-muted-foreground mb-2">
            Upload up to 8 images, or paste a link below. Clear photos get a faster, better valuation.
          </p>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={onFiles}
            disabled={uploading || images.length >= 8}
            className="text-sm"
          />
          {uploading && (
            <p className="text-xs text-muted-foreground mt-2 inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Uploading…
            </p>
          )}
          {images.length > 0 && (
            <div className="mt-3 flex gap-2 flex-wrap">
              {images.map((src, i) => (
                <div key={src} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="h-20 w-20 rounded-lg object-cover border border-border" />
                  <button
                    type="button"
                    onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-foreground text-background text-xs font-bold flex items-center justify-center"
                    aria-label="Remove image"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <Field
          label="Or link to photos (optional)"
          name="photosUrl"
          type="url"
          placeholder="https://drive.google.com/…"
        />
      </div>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
          {error}
        </p>
      )}

      <div>
        <Button
          type="submit"
          size="lg"
          disabled={pending}
          className="rounded-2xl font-semibold w-full"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              Submit for valuation <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
        <p className="text-xs text-muted-foreground text-center mt-3">
          Free valuation · No obligation · We reply within 2 business days
        </p>
      </div>
    </form>
  );
}

function SectionTitle({ step, title }: { step: string; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="data text-xs font-bold text-primary/60 tracking-[0.2em]">{step}</span>
      <h3 className="text-base font-bold tracking-tight">{title}</h3>
      <span className="flex-1 h-px bg-border" />
    </div>
  );
}

function TypeToggle({
  active,
  onClick,
  icon: Icon,
  label,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border-2 p-4 transition-all ${
        active
          ? 'border-primary bg-primary/[0.04] ring-1 ring-primary/20'
          : 'border-border hover:border-primary/30'
      }`}
    >
      <Icon className={`h-5 w-5 mb-2 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
      <p className="font-bold text-sm">{label}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
    </button>
  );
}

function Field({
  label,
  name,
  type = 'text',
  placeholder,
  required,
  textarea,
  minLength,
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  textarea?: boolean;
  minLength?: number;
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1.5">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      {textarea ? (
        <textarea
          name={name}
          placeholder={placeholder}
          required={required}
          minLength={minLength}
          rows={5}
          className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-y"
        />
      ) : (
        <input
          name={name}
          type={type}
          placeholder={placeholder}
          required={required}
          defaultValue={defaultValue}
          className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
        />
      )}
    </label>
  );
}

function SelectField({
  label,
  name,
  options,
}: {
  label: string;
  name: string;
  options: [string, string][];
}) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1.5">{label}</span>
      <select
        name={name}
        defaultValue={options[0][0]}
        className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
