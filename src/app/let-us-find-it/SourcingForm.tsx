'use client';

import { useState, useTransition } from 'react';
import { Loader2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { submitAndRedirect } from '@/lib/quotes/actions';

export function SourcingForm({
  anchor,
  buyer,
}: {
  anchor: { slug: string; title: string; brand: string | null } | null;
  buyer: { name: string; email: string };
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const input = {
      buyerEmail: String(fd.get('buyerEmail') ?? ''),
      buyerName: String(fd.get('buyerName') ?? ''),
      companyName: (fd.get('companyName') as string) || null,
      productCategory: (fd.get('productCategory') as string) || null,
      budget: (fd.get('budget') as string) || null,
      timeframe: (fd.get('timeframe') as string) || null,
      description: String(fd.get('description') ?? ''),
      productSlug: anchor?.slug ?? null,
      company_url: String(fd.get('hp_x7') ?? ''),
    };

    startTransition(async () => {
      try {
        const res = await submitAndRedirect(input);
        if (res?.error) setError(res.error);
      } catch (err) {
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        // Network failure, or a page loaded before a site update.
        setError('Your request was not sent. Reload the page and try again.');
      }
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-border bg-card p-6 md:p-8 space-y-5 shadow-sm"
    >
      {/* Honeypot — hidden from humans (off-screen, not display:none so bots
          still see it), never focusable. Bots that fill it are silently dropped
          server-side. The name and missing label are deliberately meaningless:
          a "Company URL" field got autofilled by browsers with the user's saved
          company, so real buyers' requests were silently dropped. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
        <input type="text" name="hp_x7" tabIndex={-1} autoComplete="off" data-1p-ignore data-lpignore="true" data-bwignore />
      </div>

      {anchor && (
        <div className="rounded-xl bg-foreground/[0.03] border border-border p-4">
          <p className="text-[10px] uppercase tracking-[0.15em] font-bold text-muted-foreground mb-1">
            Quote about
          </p>
          <p className="font-semibold">{anchor.title}</p>
          {anchor.brand && <Badge variant="secondary" className="mt-2">{anchor.brand}</Badge>}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        {/* Name and email come from the signed-in account; the server ignores
            these values. An account without a name may type one. */}
        <Field label="Full name" name="buyerName" placeholder="Dr. Jane Doe" required
          defaultValue={buyer.name} readOnly={!!buyer.name.trim()} />
        <Field label="Account email" name="buyerEmail" type="email" required defaultValue={buyer.email} readOnly />
      </div>

      <Field label="Company / Institution" name="companyName" placeholder="Pivot Park" />

      {!anchor && (
        <Field label="Equipment category / type" name="productCategory" placeholder="e.g. confocal microscope" />
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Budget" name="budget" placeholder="€20k – €30k" />
        <Field label="Timeframe" name="timeframe" placeholder="Within 4 weeks" />
      </div>

      <Field label="What are you looking for?" required textarea minLength={20}
        name="description"
        placeholder={anchor
          ? `What specifically about ${anchor.title} do you want quoted? Quantity, condition preference, location, accessories…`
          : 'Make / model / specs / condition / quantity / location — anything relevant.'} />

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300 px-3 py-2 text-sm">{error}</p>
      )}

      <Button type="submit" size="lg" disabled={pending} className="rounded-2xl font-semibold w-full">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Submit request <ArrowRight className="h-4 w-4" /></>}
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        Free for buyers · No commission until you accept a quote
      </p>
    </form>
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
  readOnly,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  textarea?: boolean;
  minLength?: number;
  defaultValue?: string;
  readOnly?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1.5">
        {label}
        {required && <span className="text-red-600 dark:text-red-400"> *</span>}
      </span>
      {textarea ? (
        <textarea name={name} placeholder={placeholder} required={required} minLength={minLength} rows={6}
          className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-y" />
      ) : (
        <input name={name} type={type} placeholder={placeholder} required={required}
          defaultValue={defaultValue} readOnly={readOnly} aria-readonly={readOnly || undefined}
          className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary read-only:bg-muted read-only:text-muted-foreground read-only:cursor-not-allowed" />
      )}
    </label>
  );
}
