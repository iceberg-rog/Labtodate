'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, ArrowLeft, AlertTriangle } from 'lucide-react';
import { acceptOffer, previewOfferAcceptance, type AcceptancePreview } from '@/lib/quotes/actions';
import { formatPrice } from '@/lib/utils';
import type { DetailsPrefill, VatIdRule } from '@/lib/orders/details';
import { OrderDetailsFields, type CountryOption } from '@/components/orders/OrderDetailsFields';

const pct = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/**
 * Acceptance in two steps: (1) the buyer confirms billing + delivery details
 * (prefilled from their saved billing profile / the request), the server
 * checks them (country policy, VIES, VAT rules) and returns the EXACT total;
 * (2) the buyer confirms that total (and the Terms of Sale). Only then are the
 * order and the proforma created. Nothing typed is lost when a check fails.
 */
export function AcceptOfferPanel(p: {
  quoteId: string;
  revision: number;
  offerVersion: string | null;
  currency: string;
  offerTotalLabel: string;
  prefill: DetailsPrefill;
  countries: CountryOption[];
  homeCountry: string;
  vatIdRule?: VatIdRule;
  requireTerms: boolean;
  termsUrl: string;
  onCancel: () => void;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [step, setStep] = useState<'details' | 'confirm'>('details');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AcceptancePreview | null>(null);
  const [terms, setTerms] = useState(false);
  const [save, setSave] = useState(true);
  const money = (c: number) => formatPrice(c, p.currency);
  // The VAT needs our decision first (VIES unavailable, VAT ID of another
  // company …): read defensively — not every server version sends it.
  const vatReview = (preview as (AcceptancePreview & { vatReview?: string | null }) | null)?.vatReview ?? null;
  // Nothing is payable yet while a check is open: no "payable within" promise.
  const onReview = !!preview?.complianceReview || !!vatReview;

  function readDetails(): Record<string, string> {
    const fd = new FormData(formRef.current!);
    const out: Record<string, string> = {};
    fd.forEach((v, k) => { if (typeof v === 'string') out[k] = v; });
    return out;
  }

  const base = () => ({
    sourcingRequestId: p.quoteId,
    offerRevision: p.revision > 0 ? p.revision : undefined,
    offerVersion: p.revision > 0 ? undefined : p.offerVersion ?? undefined,
    expectedCurrency: p.currency,
    details: readDetails(),
  });

  function check(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      try {
        const r = await previewOfferAcceptance(base());
        setErrors(r.fieldErrors ?? {});
        if (r.error) { setError(r.error); return; }
        if (r.notice) { setError(r.notice); router.refresh(); return; }
        if (r.preview) { setPreview(r.preview); setStep('confirm'); }
      } catch {
        setError('Your details could not be checked — the request failed. Try again in a moment.');
      }
    });
  }

  function confirm() {
    if (!preview) return;
    setError(null);
    start(async () => {
      try {
        const r = await acceptOffer({ ...base(), expectedTotalCents: preview.totalCents, acceptTerms: terms, saveProfile: save });
        // Success redirects to the payment page; only refusals come back.
        if (r?.fieldErrors) { setErrors(r.fieldErrors); setStep('details'); }
        if (r?.preview) setPreview(r.preview);
        if (r?.error) setError(r.error);
        if (r?.error && !r.preview && !r.fieldErrors) router.refresh();
      } catch (err) {
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        setError('Your acceptance could not be confirmed. Reload the page — if the offer shows as accepted, your order exists.');
      }
    });
  }

  return (
    <div role="region" aria-label="Accept the offer" className="mt-5 rounded-xl border-2 border-primary bg-background p-4 space-y-4 min-w-0" data-testid="accept-panel">
      <form ref={formRef} onSubmit={check} noValidate className={step === 'details' ? 'space-y-4' : 'hidden'}>
        <div>
          <p className="font-bold">Accept the offer — step 1 of 2: your details</p>
          <p className="text-sm text-muted-foreground mt-0.5">We need the legal billing details for the proforma and invoice, and the full delivery address before you pay. The VAT follows from these details.</p>
        </div>
        <OrderDetailsFields prefill={p.prefill} countries={p.countries} errors={errors} homeCountry={p.homeCountry} vatIdRule={p.vatIdRule} idPrefix={`acc-${p.quoteId.slice(-6)}`} />
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="mt-1 h-4 w-4" />
          <span>Save these billing details for my next orders</span>
        </label>
        {error && step === 'details' && <ErrorBox text={error} />}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending} className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-60">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Continue — show my total
          </button>
          <button type="button" onClick={p.onCancel} disabled={pending} className="inline-flex items-center rounded-full border border-border px-5 py-2.5 text-sm font-semibold hover:bg-foreground/5 disabled:opacity-60">
            Cancel
          </button>
        </div>
      </form>

      {step === 'confirm' && preview && (
        <div className="space-y-3" data-testid="accept-confirm">
          <p className="font-bold">Accept the offer — step 2 of 2: confirm</p>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 sm:gap-x-6 gap-y-1 text-sm max-w-md">
            <dt className="text-muted-foreground">{preview.qty > 1 ? `Price (${preview.qty} × ${money(preview.unitCents)})` : 'Price'}</dt>
            <dd className="text-right tabular-nums">{money(preview.goodsCents)}</dd>
            {preview.shippingCents > 0 && (<><dt className="text-muted-foreground">Freight / shipping</dt><dd className="text-right tabular-nums">{money(preview.shippingCents)}</dd></>)}
            <dt className="text-muted-foreground">VAT {pct(preview.vatRateBp)}<span className="block text-[11px]">{preview.vatLabel}</span></dt>
            <dd className="text-right tabular-nums">{money(preview.vatCents)}</dd>
            <dt className="font-bold border-t border-border pt-1">Total to pay</dt>
            <dd className="text-right tabular-nums font-bold border-t border-border pt-1" data-testid="accept-total">{money(preview.totalCents)}</dd>
          </dl>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{preview.vatExplanation}</p>
          {preview.legalText && <p className="text-xs text-muted-foreground italic [overflow-wrap:anywhere]">{preview.legalText}</p>}
          {preview.differsFromOffer && (
            <p className="text-xs rounded-lg border border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300 px-3 py-2">
              {preview.offerTotalCents == null
                ? `The offer was ${p.offerTotalLabel}; the VAT above follows from your details.`
                : `The emailed offer showed ${money(preview.offerTotalCents)}; with these details the VAT is as shown above.`}
            </p>
          )}
          {preview.complianceReview && (
            <p className="text-xs rounded-lg border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 px-3 py-2 flex gap-2 [overflow-wrap:anywhere]" data-testid="accept-compliance-review">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>{preview.complianceReview} Your order is created, but please do not pay until we confirm — we email you.</span>
            </p>
          )}
          {vatReview && (
            <p className="text-xs rounded-lg border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 px-3 py-2 flex gap-2 [overflow-wrap:anywhere]" data-testid="accept-vat-review">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>{vatReview}</span>
            </p>
          )}
          {onReview ? (
            <p className="text-sm" data-testid="accept-on-review">
              Accepting creates your <strong>order</strong> for <strong>{money(preview.totalCents)}</strong>. Nothing is payable yet: we email you as soon as our check is done.
            </p>
          ) : (
            <p className="text-sm">
              Accepting creates your <strong>order</strong> and a <strong>proforma invoice</strong> for <strong>{money(preview.totalCents)}</strong>, payable by bank transfer within <strong>{preview.dueDays} days</strong>. We email you the proforma (PDF) and take you to the payment page.
            </p>
          )}
          {p.requireTerms && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-1 h-4 w-4" data-testid="accept-terms" />
              <span>I accept this offer and the <a href={p.termsUrl} target="_blank" rel="noopener" className="underline font-semibold">General Terms of Sale</a>, on behalf of the company named above.</span>
            </label>
          )}
          {error && <ErrorBox text={error} />}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirm}
              disabled={pending || (p.requireTerms && !terms)}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirm and accept — {money(preview.totalCents)}
            </button>
            <button type="button" onClick={() => { setError(null); setStep('details'); }} disabled={pending} className="inline-flex items-center gap-1 rounded-full border border-border px-5 py-2.5 text-sm font-semibold hover:bg-foreground/5 disabled:opacity-60">
              <ArrowLeft className="h-4 w-4" /> Change details
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 dark:text-red-300 dark:bg-red-950/40 dark:border-red-800 [overflow-wrap:anywhere]">
      {text}
    </p>
  );
}
