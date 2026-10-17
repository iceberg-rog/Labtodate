'use client';

import { useState } from 'react';
import type { DetailsPrefill, VatIdRule } from '@/lib/orders/details';

export interface CountryOption {
  code: string;
  name: string;
  /** Orders to this country are checked by staff before payment (export compliance). */
  review?: boolean;
}

const OTHER = '__OTHER';

/**
 * Billing + delivery inputs (names b_* / d_* / d_same), shared by the offer
 * acceptance step, the payment page and the admin order page. Uncontrolled
 * inputs: the parent reads them with `new FormData(form)`. `errors` holds the
 * server's field messages (keys b_legalName, d_phone, …).
 */
export function OrderDetailsFields({
  prefill,
  countries,
  errors = {},
  homeCountry,
  idPrefix = 'od',
  showPo = true,
  vatIdRule = 'OFF',
}: {
  prefill: DetailsPrefill;
  countries: CountryOption[];
  errors?: Record<string, string>;
  homeCountry?: string;
  idPrefix?: string;
  showPo?: boolean;
  /** Settings → DETAILS_VAT_ID_REQUIRED. */
  vatIdRule?: VatIdRule;
}) {
  const [same, setSame] = useState(prefill.same);
  return (
    <div className="space-y-5" data-testid="order-details-fields">
      <fieldset className="space-y-3 min-w-0">
        <legend className="text-sm font-bold">Billing details <span className="font-normal text-muted-foreground">— the invoice is addressed to this</span></legend>
        <div className="grid sm:grid-cols-2 gap-3">
          <Input id={`${idPrefix}-b_legalName`} name="b_legalName" label="Company / institution" required defaultValue={prefill.b.legalName} error={errors.b_legalName} autoComplete="organization" />
          <Input id={`${idPrefix}-b_contactName`} name="b_contactName" label="Contact person" optional defaultValue={prefill.b.contactName} error={errors.b_contactName} autoComplete="name" />
        </div>
        <Input
          id={`${idPrefix}-b_vatId`}
          name="b_vatId"
          label={vatIdRule === 'EU' ? 'VAT ID (required for buyers in the EU)' : 'VAT ID'}
          optional={vatIdRule === 'OFF'}
          required={vatIdRule === 'ALWAYS'}
          defaultValue={prefill.b.vatId}
          error={errors.b_vatId}
          placeholder="e.g. DE123456789"
          hint={`Printed on the proforma and the invoice. EU businesses${homeCountry ? ` outside ${homeCountry}` : ''}: needed for 0% VAT (reverse charge) — we check it with the EU VIES service; without it, VAT is charged.`}
        />
        <Input id={`${idPrefix}-b_line1`} name="b_line1" label="Street and number" required defaultValue={prefill.b.line1} error={errors.b_line1} autoComplete="address-line1" />
        <Input id={`${idPrefix}-b_line2`} name="b_line2" label="Address line 2" optional defaultValue={prefill.b.line2} error={errors.b_line2} autoComplete="address-line2" />
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
          <Input id={`${idPrefix}-b_postalCode`} name="b_postalCode" label="Postal code" required defaultValue={prefill.b.postalCode} error={errors.b_postalCode} autoComplete="postal-code" />
          <Input id={`${idPrefix}-b_city`} name="b_city" label="City" required defaultValue={prefill.b.city} error={errors.b_city} autoComplete="address-level2" />
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <CountrySelect id={`${idPrefix}-b_country`} name="b_country" label="Country" value={prefill.b.country} countries={countries} error={errors.b_country} />
          <Input id={`${idPrefix}-b_region`} name="b_region" label="Region / state" optional defaultValue={prefill.b.region} error={errors.b_region} />
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Input id={`${idPrefix}-b_phone`} name="b_phone" label="Phone" optional defaultValue={prefill.b.phone} error={errors.b_phone} autoComplete="tel" />
          <Input id={`${idPrefix}-b_invoiceEmail`} name="b_invoiceEmail" label="Invoice email (accounts payable)" optional defaultValue={prefill.b.invoiceEmail} error={errors.b_invoiceEmail} type="email" />
        </div>
        {showPo && (
          <Input id={`${idPrefix}-b_poNumber`} name="b_poNumber" label="Your purchase-order (PO) number" optional defaultValue={prefill.b.poNumber} error={errors.b_poNumber} hint="Printed on the proforma and the invoice." />
        )}
      </fieldset>

      <fieldset className="space-y-3 min-w-0">
        <legend className="text-sm font-bold">Delivery</legend>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input type="checkbox" name="d_same" checked={same} onChange={(e) => setSame(e.target.checked)} className="mt-1 h-4 w-4" />
          <span>Deliver to the billing address</span>
        </label>
        <div className="grid sm:grid-cols-2 gap-3">
          <Input id={`${idPrefix}-d_name`} name="d_name" label="Recipient (attention of)" required defaultValue={prefill.d.name} error={errors.d_name} autoComplete="name" />
          <Input id={`${idPrefix}-d_phone`} name="d_phone" label="Phone for the carrier" required defaultValue={prefill.d.phone} error={errors.d_phone} autoComplete="tel" />
        </div>
        {!same && (
          <div className="space-y-3 rounded-xl border border-border p-3">
            <Input id={`${idPrefix}-d_company`} name="d_company" label="Company / site" optional defaultValue={prefill.d.company} error={errors.d_company} />
            <Input id={`${idPrefix}-d_line1`} name="d_line1" label="Street and number" required defaultValue={prefill.d.line1} error={errors.d_line1} autoComplete="shipping address-line1" />
            <Input id={`${idPrefix}-d_line2`} name="d_line2" label="Address line 2" optional defaultValue={prefill.d.line2} error={errors.d_line2} autoComplete="shipping address-line2" />
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
              <Input id={`${idPrefix}-d_postalCode`} name="d_postalCode" label="Postal code" required defaultValue={prefill.d.postalCode} error={errors.d_postalCode} autoComplete="shipping postal-code" />
              <Input id={`${idPrefix}-d_city`} name="d_city" label="City" required defaultValue={prefill.d.city} error={errors.d_city} autoComplete="shipping address-level2" />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <CountrySelect id={`${idPrefix}-d_country`} name="d_country" label="Country" value={prefill.d.country} countries={countries} error={errors.d_country} />
              <Input id={`${idPrefix}-d_region`} name="d_region" label="Region / state" optional defaultValue={prefill.d.region} error={errors.d_region} />
            </div>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">The delivery country decides the VAT (e.g. 0% for exports outside the EU) and the export checks.</p>
      </fieldset>
    </div>
  );
}

function Input({
  id, name, label, defaultValue, error, optional, required, placeholder, hint, type = 'text', autoComplete,
}: {
  id: string; name: string; label: string; defaultValue?: string; error?: string; optional?: boolean; required?: boolean;
  placeholder?: string; hint?: string; type?: string; autoComplete?: string;
}) {
  return (
    <label htmlFor={id} className="block min-w-0">
      <span className="block text-xs font-semibold mb-1">
        {label}
        {required && <span className="text-red-600" aria-hidden> *</span>}
        {optional && <span className="text-muted-foreground font-normal"> (optional)</span>}
      </span>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        dir="auto"
        className={`w-full h-10 px-3 rounded-lg border bg-background text-sm min-w-0 ${error ? 'border-red-500 ring-1 ring-red-300' : 'border-input'}`}
      />
      {hint && !error && <span className="block text-[11px] text-muted-foreground mt-1">{hint}</span>}
      {error && <span id={`${id}-err`} role="alert" className="block text-[11px] text-red-700 dark:text-red-400 mt-1">{error}</span>}
    </label>
  );
}

function CountrySelect({ id, name, label, value, countries, error }: { id: string; name: string; label: string; value: string; countries: CountryOption[]; error?: string }) {
  const known = countries.some((c) => c.code === value);
  const [sel, setSel] = useState(value ? (known ? value : OTHER) : '');
  const reviewNote = countries.find((c) => c.code === sel)?.review;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs font-semibold mb-1">
        {label}<span className="text-red-600" aria-hidden> *</span>
      </label>
      <select
        id={id}
        name={sel === OTHER ? undefined : name}
        value={sel}
        onChange={(e) => setSel(e.target.value)}
        aria-invalid={error ? true : undefined}
        className={`w-full h-10 px-2 rounded-lg border bg-background text-sm ${error ? 'border-red-500 ring-1 ring-red-300' : 'border-input'}`}
      >
        <option value="">Choose…</option>
        {countries.map((c) => (
          <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
        ))}
        <option value={OTHER}>Other country…</option>
      </select>
      {sel === OTHER && (
        <input
          name={name}
          defaultValue={known ? '' : value}
          maxLength={2}
          placeholder="2-letter code, e.g. JP"
          aria-label={`${label} (2-letter code)`}
          className="mt-2 w-full h-10 px-3 rounded-lg border border-input bg-background text-sm uppercase"
        />
      )}
      {reviewNote && <span className="block text-[11px] text-amber-700 dark:text-amber-400 mt-1">Orders to this country are checked by our team (export compliance) before payment.</span>}
      {error && <span role="alert" className="block text-[11px] text-red-700 dark:text-red-400 mt-1">{error}</span>}
    </div>
  );
}
