'use client';

import Link from 'next/link';
import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, Info, Loader2, Lock, ShoppingBag, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatPrice } from '@/lib/utils';
import { placeOrder, previewCheckout } from '@/lib/checkout/actions';
import type { CheckoutFormValues, CheckoutRules, CustomerTypeCode } from '@/lib/checkout/input';
import { vatIdRequiredFor } from '@/lib/orders/details';
import type { CheckoutQuoteView, PlaceOrderState } from '@/lib/checkout/view';

export interface CheckoutFormProps {
  source: 'single' | 'cart';
  slug: string;
  initial: CheckoutFormValues;
  initialQuote: CheckoutQuoteView;
  countries: Array<{ code: string; name: string; review: boolean }>;
  rules: Omit<CheckoutRules, 'paymentMethods'>;
  declarationText: string;
  termsNote: string;
  accountEmail: string;
  images: Record<string, string | null>;
  /** Banner from the URL (?payment=error / ?canceled=1). */
  banner: string | null;
  backHref: string;
  backLabel: string;
}

const pct = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

function toRecord(v: CheckoutFormValues): Record<string, string> {
  return {
    source: v.source, slug: v.slug, name: v.name, phone: v.phone, line1: v.line1, line2: v.line2, city: v.city,
    postal: v.postal, state: v.state, country: v.country, customerType: v.customerType, company: v.company, kvk: v.kvk,
    vatId: v.vatId, billingSame: v.billingSame ? 'on' : 'off', b_name: v.billing.name, b_line1: v.billing.line1,
    b_line2: v.billing.line2, b_city: v.billing.city, b_postal: v.billing.postal, b_state: v.billing.state,
    b_country: v.billing.country, invoiceEmail: v.invoiceEmail, poNumber: v.poNumber, paymentMethod: v.paymentMethod,
  };
}

/** "… our [terms and conditions](/legal/terms)." → text with a link (site paths only). */
function TermsNote({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]{1,80}\]\(\/[a-z0-9\-/]*\))/i);
  return (
    <p className="text-xs text-muted-foreground leading-relaxed">
      {parts.map((p, i) => {
        const m = /^\[([^\]]{1,80})\]\((\/[a-z0-9\-/]*)\)$/i.exec(p);
        return m ? (
          <Link key={i} href={m[2]} prefetch={false} className="underline hover:text-foreground" target="_blank">
            {m[1]}
          </Link>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </p>
  );
}

export function CheckoutForm(props: CheckoutFormProps) {
  const { rules, countries } = props;
  const [v, setV] = useState<CheckoutFormValues>({ ...props.initial, source: props.source, slug: props.slug });
  const [quote, setQuote] = useState<CheckoutQuoteView>(props.initialQuote);
  const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [state, formAction, submitting] = useActionState<PlaceOrderState, FormData>(placeOrder, { status: 'idle' });
  const seq = useRef(0);
  const [vatCommitted, setVatCommitted] = useState(props.initial.vatId);

  const business = v.customerType !== 'CONSUMER';
  const fieldErrors = state.status === 'error' ? state.fieldErrors : {};
  const err = (k: string) => fieldErrors[k] ?? null;

  // A failed submit returns the latest quote: show it (e.g. "the total changed").
  useEffect(() => {
    if (state.status !== 'error') return;
    if (state.quote) setQuote(state.quote);
    // Bring the problem into view (the button may be far from the field).
    const el = document.querySelector('[data-testid="checkout-form"] [aria-invalid="true"]') ?? document.querySelector('[data-testid="checkout-error"]');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [state]);

  const refresh = useCallback(async (values: CheckoutFormValues) => {
    const my = ++seq.current;
    setBusy(true);
    try {
      const r = await previewCheckout(toRecord(values));
      if (my !== seq.current) return;
      if (r.ok) {
        setQuote(r.quote);
        setPreviewError(null);
      } else {
        setPreviewError(r.message);
      }
    } catch {
      if (my === seq.current) setPreviewError('The total could not be updated — check your connection and change a field again.');
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, []);

  // Re-price when something that changes the total changes.
  const pricingKey = [v.country, v.billingSame ? '' : v.billing.country, v.customerType, business ? vatCommitted : ''].join('|');
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (v.country === '__OTHER') return; // not orderable here — the request-a-quote link is shown
    const t = setTimeout(() => refresh({ ...v, vatId: vatCommitted }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricingKey]);

  const set = <K extends keyof CheckoutFormValues>(k: K, val: CheckoutFormValues[K]) => setV((o) => ({ ...o, [k]: val }));
  const setB = (k: keyof CheckoutFormValues['billing'], val: string) => setV((o) => ({ ...o, billing: { ...o.billing, [k]: val } }));

  const holds = quote.holds;
  const onHold = holds.length > 0;
  const submitLabel = onHold
    ? quote.submitLabels.hold
    : !business
      ? quote.submitLabels.consumer
      : v.paymentMethod === 'STRIPE_CARD'
        ? quote.submitLabels.card
        : quote.submitLabels.bank;
  const vatPending = quote.vat.review;
  const margin = quote.vat.treatment === 'MARGIN_SCHEME';
  const shipPending = quote.shipping.status === 'TO_BE_CONFIRMED';
  const incl = quote.displayMode === 'INCL';
  const cur = quote.currency;

  const vatIdChanged = business && v.vatId.trim() !== vatCommitted.trim();
  const showPo = business && rules.poMode !== 'HIDDEN';
  const poRequired = rules.poMode === 'REQUIRED' || rules.poRequiredByProfile;
  const consumerAllowed = rules.salesMode === 'B2B_AND_B2C';

  const lineAmount = (net: number, tax: number) => (incl ? net + tax : net);
  const shippingTax = useMemo(() => {
    const goodsTax = quote.lines.reduce((s, l) => s + l.taxCents, 0);
    return Math.max(0, quote.taxCents - goodsTax);
  }, [quote]);

  return (
    <form action={formAction} className="grid lg:grid-cols-[1fr_380px] gap-6 items-start" data-testid="checkout-form" noValidate>
      <input type="hidden" name="source" value={props.source} />
      <input type="hidden" name="slug" value={props.slug} />
      <input type="hidden" name="expectedTotal" value={String(quote.totalCents)} />
      <input type="hidden" name="expectedTax" value={String(quote.taxCents)} />
      <input type="hidden" name="expectedShipping" value={String(quote.shipping.cents)} />
      <input type="hidden" name="billingSame" value={v.billingSame ? 'on' : 'off'} />

      <div className="space-y-5 min-w-0">
        <div>
          <Link href={props.backHref} className="text-sm text-muted-foreground hover:text-foreground">← {props.backLabel}</Link>
          <h1 className="text-3xl font-bold tracking-tight mt-3">Checkout</h1>
          <p className="text-muted-foreground mt-1">Delivery, billing and payment. The summary shows the exact total for your address and VAT ID before you order.</p>
        </div>

        {props.banner && (
          <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-200" role="status">
            {props.banner}
          </div>
        )}
        {state.status === 'error' && (
          <div
            className={`rounded-xl border p-3 text-sm ${state.changed ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200' : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}
            role="alert"
            data-testid="checkout-error"
          >
            {state.message}
          </div>
        )}

        <Section title="Contact">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Full name" name="name" required value={v.name} onChange={(x) => set('name', x)} autoComplete="name" error={err('name')} />
            <Field label="Phone" hint="for the carrier" name="phone" required={rules.requirePhone} type="tel" value={v.phone} onChange={(x) => set('phone', x)} autoComplete="tel" placeholder="+31 6 12345678" error={err('phone')} />
          </div>
          <Field label="Account email" name="_email" value={props.accountEmail} onChange={() => {}} disabled />
        </Section>

        <Section title="Delivery address">
          <Field label="Address line 1" name="line1" required value={v.line1} onChange={(x) => set('line1', x)} autoComplete="address-line1" placeholder="Street and number" error={err('line1')} />
          <Field label="Address line 2" name="line2" value={v.line2} onChange={(x) => set('line2', x)} autoComplete="address-line2" placeholder="Department, building, dock, attention-to" />
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Postal code" name="postal" required value={v.postal} onChange={(x) => set('postal', x)} autoComplete="postal-code" error={err('postal')} />
            <Field label="City" name="city" required value={v.city} onChange={(x) => set('city', x)} autoComplete="address-level2" error={err('city')} />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="State / region" name="state" value={v.state} onChange={(x) => set('state', x)} autoComplete="address-level1" />
            <CountrySelect label="Country" name="country" value={v.country} onChange={(x) => set('country', x)} countries={countries} error={err('country')} withOther />
          </div>
          {v.country === '__OTHER' && (
            <p className="text-sm rounded-lg border border-border bg-muted/40 p-3">
              Your country is not in the list. <Link className="underline font-semibold" href={`/let-us-find-it${props.source === 'single' ? `?product=${encodeURIComponent(props.slug)}&reason=shipping` : '?reason=shipping'}`}>Request a quote</Link> — we arrange delivery and send you an offer. No order is created here.
            </p>
          )}
        </Section>

        <Section title="Buyer & billing">
          <fieldset>
            <legend className="text-sm font-semibold mb-1.5">I buy as</legend>
            <div className="flex flex-wrap gap-2">
              {(['BUSINESS', 'INSTITUTION', ...(consumerAllowed ? ['CONSUMER'] : [])] as CustomerTypeCode[]).map((t) => (
                <label key={t} className={`inline-flex items-center gap-2 h-10 px-3 rounded-lg border text-sm cursor-pointer ${v.customerType === t ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border'}`}>
                  <input type="radio" name="customerType" value={t} checked={v.customerType === t} onChange={() => set('customerType', t)} />
                  {t === 'BUSINESS' ? 'Company' : t === 'INSTITUTION' ? 'University / institution' : 'Private person'}
                </label>
              ))}
            </div>
            {err('customerType') && <p className="text-xs text-red-600 dark:text-red-400 mt-1">{err('customerType')}</p>}
          </fieldset>

          {business && (
            <>
              <Field label={v.customerType === 'INSTITUTION' ? 'Institution name' : 'Company name'} name="company" required={rules.requireCompanyAndId} value={v.company} onChange={(x) => set('company', x)} autoComplete="organization" error={err('company')} />
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="KvK / registration number" name="kvk" value={v.kvk} onChange={(x) => set('kvk', x)} error={err('kvk')} hint={rules.requireCompanyAndId ? 'or a VAT ID' : undefined} />
                <div>
                  <Field
                    label="EU VAT ID"
                    name="vatId"
                    required={vatIdRequiredFor(rules.vatIdRule, v.billingSame ? v.country : v.billing.country)}
                    value={v.vatId}
                    onChange={(x) => set('vatId', x.toUpperCase())}
                    onBlur={() => setVatCommitted(v.vatId)}
                    placeholder="e.g. DE123456789"
                    error={err('vatId')}
                  />
                  {vatIdChanged && (
                    <button type="button" onClick={() => setVatCommitted(v.vatId)} className="mt-1.5 text-xs font-semibold text-primary underline">
                      Check VAT ID
                    </button>
                  )}
                </div>
              </div>
              {quote.vatId && !vatIdChanged && (
                <p
                  data-testid="vies-result"
                  className={`text-xs rounded-lg p-2.5 flex items-start gap-2 ${quote.vatId.status === 'VALID' ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200' : quote.vatId.status === 'INVALID' ? 'bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'}`}
                >
                  {quote.vatId.status === 'VALID' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : quote.vatId.status === 'INVALID' ? <XCircle className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
                  <span><strong>{quote.vatId.input}:</strong> {quote.vatId.message}</span>
                </p>
              )}
            </>
          )}

          <label className="flex items-start gap-2 text-sm pt-1">
            <input type="checkbox" checked={v.billingSame} onChange={(e) => set('billingSame', e.target.checked)} className="mt-0.5" />
            <span>The billing address is the same as the delivery address</span>
          </label>
          {!v.billingSame && (
            <div className="space-y-4 rounded-xl border border-border p-4">
              <p className="text-sm font-semibold">Billing address (printed on the invoice)</p>
              <Field label="Attention of / accounts department" name="b_name" value={v.billing.name} onChange={(x) => setB('name', x)} />
              <Field label="Address line 1" name="b_line1" required value={v.billing.line1} onChange={(x) => setB('line1', x)} error={err('b_line1')} />
              <Field label="Address line 2" name="b_line2" value={v.billing.line2} onChange={(x) => setB('line2', x)} />
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Postal code" name="b_postal" required value={v.billing.postal} onChange={(x) => setB('postal', x)} error={err('b_postal')} />
                <Field label="City" name="b_city" required value={v.billing.city} onChange={(x) => setB('city', x)} error={err('b_city')} />
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="State / region" name="b_state" value={v.billing.state} onChange={(x) => setB('state', x)} />
                <CountrySelect label="Country" name="b_country" value={v.billing.country} onChange={(x) => setB('country', x)} countries={countries} error={err('b_country')} />
              </div>
            </div>
          )}

          {rules.askInvoiceEmail && (
            <Field label="Invoice email" hint="accounts payable — empty = your account email" name="invoiceEmail" type="email" value={v.invoiceEmail} onChange={(x) => set('invoiceEmail', x)} placeholder={props.accountEmail} error={err('invoiceEmail')} />
          )}
          {showPo && (
            <Field label="Purchase-order (PO) number" name="poNumber" required={poRequired} value={v.poNumber} onChange={(x) => set('poNumber', x)} error={err('poNumber')} />
          )}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="saveProfile" checked={v.saveProfile} onChange={(e) => set('saveProfile', e.target.checked)} className="mt-0.5" />
            <span>Save these billing details for my next orders</span>
          </label>
        </Section>

        <Section title="Payment">
          {quote.paymentMethods.length === 0 ? (
            <p className="text-sm text-red-700 dark:text-red-300">No payment method is available right now.</p>
          ) : (
            <div className="space-y-2">
              {quote.paymentMethods.map((m) => (
                <label key={m.code} className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer ${v.paymentMethod === m.code ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border'}`}>
                  <input type="radio" name="paymentMethod" value={m.code} checked={v.paymentMethod === m.code} onChange={() => set('paymentMethod', m.code)} className="mt-1" />
                  <span>
                    <span className="text-sm font-semibold flex items-center gap-1.5">{m.code === 'BANK_TRANSFER' ? <Building2 className="h-4 w-4" /> : <Lock className="h-4 w-4" />}{m.label}</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">{m.note}</span>
                  </span>
                </label>
              ))}
              {err('paymentMethod') && <p className="text-xs text-red-600 dark:text-red-400">{err('paymentMethod')}</p>}
              {onHold && <p className="text-xs text-muted-foreground">No payment is taken now: we send the final total and the payment details once the open point{holds.length > 1 ? 's are' : ' is'} confirmed.</p>}
            </div>
          )}
        </Section>

      </div>

      <aside className="min-w-0 lg:sticky lg:top-20 rounded-2xl border border-border bg-card overflow-hidden" data-testid="checkout-summary">
        <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
          <ShoppingBag className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-bold">Order summary</h2>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground ml-auto" aria-label="Updating" />}
        </div>
        <div className="p-5 space-y-4">
          <ul className="space-y-3">
            {quote.lines.map((l) => (
              <li key={l.productId} className="flex items-start gap-3">
                <div className="h-12 w-12 rounded-lg bg-foreground/5 border border-border overflow-hidden flex-shrink-0">
                  {props.images[l.productId] && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={props.images[l.productId]!} alt="" className="w-full h-full object-cover" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold leading-tight line-clamp-2">{l.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5" data-testid="line-qty">
                    {l.qty} × {formatPrice(incl ? l.unitNetCents + Math.round(l.taxCents / l.qty) : l.unitNetCents, cur)}
                    {l.conditionLabel ? ` · ${l.conditionLabel}` : ''}
                  </p>
                  {l.warranty && (
                    <p className="text-[11px] text-muted-foreground mt-0.5" data-testid="line-warranty">
                      Warranty: {l.warranty}
                    </p>
                  )}
                </div>
                <p className="text-sm font-bold tabular-nums" data-testid="line-total">{formatPrice(lineAmount(l.lineNetCents, l.taxCents), cur)}</p>
              </li>
            ))}
          </ul>

          <dl className="space-y-1.5 text-sm border-t border-border pt-3" data-testid="totals">
            <Row label={margin ? 'Subtotal' : incl ? `Subtotal (${quote.labels.incl})` : `Subtotal (${quote.labels.excl})`} value={formatPrice(incl ? quote.goodsCents + quote.lines.reduce((s, l) => s + l.taxCents, 0) : quote.goodsCents, cur)} />
            <Row
              label={`Shipping${quote.shipping.zone ? ` · ${quote.shipping.zone}` : ''}`}
              value={shipPending ? 'to be confirmed' : quote.shipping.cents === 0 ? 'free' : formatPrice(incl ? quote.shipping.cents + shippingTax : quote.shipping.cents, cur)}
              warn={shipPending}
              testid="row-shipping"
            />
            {vatPending ? (
              <Row label="VAT" value="to be confirmed" warn testid="row-vat" />
            ) : incl ? (
              <Row label={`of which VAT`} value={formatPrice(quote.taxCents, cur)} muted testid="row-vat" />
            ) : (
              <>
                {/* Margin scheme: the second-hand goods carry no separate VAT (it is in the price). */}
                {quote.vat.rows.filter((r) => !(margin && r.rateBp === 0)).map((r) => (
                  <Row key={r.rateBp} label={`VAT ${pct(r.rateBp)}${r.rateBp === 0 ? '' : ` on ${formatPrice(r.baseCents, cur)}`}`} value={formatPrice(r.taxCents, cur)} testid="row-vat" />
                ))}
                {margin && <Row label="Margin scheme: VAT included in the price, not shown separately" value="" muted testid="row-margin" />}
              </>
            )}
            <div className="pt-2 border-t border-border" />
            <Row label={shipPending || vatPending ? 'Total so far' : 'Total'} value={formatPrice(quote.totalCents, cur)} bold testid="row-total" />
          </dl>

          <div className="text-xs text-muted-foreground space-y-1" data-testid="vat-explanation">
            <p><span className="font-semibold text-foreground">{quote.vat.label}.</span> {quote.vat.explanation}</p>
            {quote.vat.legalText && <p className="italic">{quote.vat.legalText}</p>}
            {quote.shipping.leadTime && !shipPending && <p>Delivery: {quote.shipping.leadTime}</p>}
          </div>

          {previewError && <p className="text-xs rounded-lg bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200 p-2.5">{previewError}</p>}

          {quote.refusal && v.country !== '__OTHER' && (
            <div className="rounded-xl border border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200 p-3 text-sm" data-testid="checkout-refusal" role="alert">
              <p className="font-semibold flex items-center gap-1.5"><XCircle className="h-4 w-4" /> This order cannot be placed</p>
              <p className="mt-1">{quote.refusal.message}</p>
            </div>
          )}
          {onHold && !quote.refusal && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 p-3 text-sm space-y-1.5" data-testid="checkout-holds">
              <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Total confirmed by our team before payment</p>
              {holds.map((h) => <p key={h.code}>{h.message}</p>)}
            </div>
          )}
          {quote.hints.map((h) => (
            <p key={h} className="text-xs rounded-lg bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200 p-2.5 flex items-start gap-2" data-testid="checkout-hint">
              <Info className="h-4 w-4 shrink-0" /> {h}
            </p>
          ))}

          {business && (
            <label className={`flex items-start gap-2 text-sm rounded-xl border p-3 ${err('b2bDeclaration') ? 'border-red-400 bg-red-50/60 dark:bg-red-950/30' : 'border-border'}`} data-testid="b2b-declaration">
              <input type="checkbox" name="b2bDeclaration" checked={v.b2bDeclaration} onChange={(e) => set('b2bDeclaration', e.target.checked)} className="mt-0.5" />
              <span>
                {props.declarationText}
                {err('b2bDeclaration') && <span className="block text-xs text-red-600 dark:text-red-400 mt-1">{err('b2bDeclaration')}</span>}
              </span>
            </label>
          )}
          {props.termsNote && <TermsNote text={props.termsNote} />}
          {state.status === 'error' && (
            <p className={`text-xs font-semibold ${state.changed ? 'text-amber-800 dark:text-amber-300' : 'text-red-700 dark:text-red-300'}`} role="status" data-testid="checkout-error-near-button">
              {state.message}
            </p>
          )}
          <Button
            type="submit"
            size="lg"
            disabled={submitting || busy || !quote.canOrder || vatIdChanged || v.country === '__OTHER'}
            className="rounded-2xl font-semibold w-full whitespace-normal h-auto min-h-12 py-3"
            data-testid="place-order"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {submitLabel}
          </Button>
          {vatIdChanged && <p className="text-xs text-muted-foreground">Check the VAT ID first — it can change the VAT.</p>}
        </div>
      </aside>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 space-y-4">
      <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label, name, value, onChange, onBlur, required, type, placeholder, autoComplete, error, hint, disabled,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  error?: string | null;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1.5">
        {label} {required && <span className="text-red-600 dark:text-red-400">*</span>}
        {hint && <span className="font-normal text-xs text-muted-foreground"> — {hint}</span>}
      </span>
      <input
        type={type ?? 'text'}
        name={disabled ? undefined : name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-invalid={!!error}
        className={`w-full h-10 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 ${error ? 'border-red-500' : 'border-input focus:border-primary'}`}
      />
      {error && <span className="block text-xs text-red-600 dark:text-red-400 mt-1">{error}</span>}
    </label>
  );
}

function CountrySelect({
  label, name, value, onChange, countries, error, withOther,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  countries: Array<{ code: string; name: string; review: boolean }>;
  error?: string | null;
  withOther?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1.5">{label} <span className="text-red-600 dark:text-red-400">*</span></span>
      <select
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        className={`w-full h-10 px-3 rounded-lg border bg-background text-sm ${error ? 'border-red-500' : 'border-input'}`}
      >
        {!countries.some((c) => c.code === value) && value !== '__OTHER' && <option value="">Choose…</option>}
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}{c.review ? ' — orders reviewed first' : ''}
          </option>
        ))}
        {withOther && <option value="__OTHER">Other country — request a quote</option>}
      </select>
      {error && <span className="block text-xs text-red-600 dark:text-red-400 mt-1">{error}</span>}
    </label>
  );
}

function Row({ label, value, muted, bold, warn, testid }: { label: string; value: string; muted?: boolean; bold?: boolean; warn?: boolean; testid?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3" data-testid={testid}>
      <dt className={muted ? 'text-xs text-muted-foreground' : 'text-sm'}>{label}</dt>
      <dd className={`tabular-nums text-right ${bold ? 'font-bold text-base' : warn ? 'text-amber-700 dark:text-amber-300 font-semibold' : muted ? 'text-xs text-muted-foreground' : 'font-semibold'}`}>{value}</dd>
    </div>
  );
}
