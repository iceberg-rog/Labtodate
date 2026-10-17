/**
 * Checkout form values — parsing and field validation. Pure and client-safe:
 * the same rules run in the browser (instant feedback) and on the server
 * (authoritative, before any order is created).
 */
import { parseVatId, VIES_PREFIXES } from '@/lib/tax/vatid';
import { vatIdRequiredFor, type VatIdRule } from '@/lib/orders/details';

export type CustomerTypeCode = 'BUSINESS' | 'INSTITUTION' | 'CONSUMER';
export type PaymentMethodCode = 'BANK_TRANSFER' | 'STRIPE_CARD';

export interface AddressValues {
  name: string;
  line1: string;
  line2: string;
  city: string;
  postal: string;
  state: string;
  country: string;
}

export interface CheckoutFormValues {
  source: 'single' | 'cart';
  slug: string;
  name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  postal: string;
  state: string;
  country: string;
  customerType: CustomerTypeCode;
  company: string;
  kvk: string;
  vatId: string;
  billingSame: boolean;
  billing: AddressValues;
  invoiceEmail: string;
  poNumber: string;
  paymentMethod: string;
  b2bDeclaration: boolean;
  saveProfile: boolean;
  /** Totals the buyer was shown when submitting (cents); the server refuses if they changed. */
  expected: { total: number | null; tax: number | null; shipping: number | null };
}

export interface CheckoutRules {
  salesMode: 'B2B_ONLY' | 'B2B_AND_B2C';
  requireCompanyAndId: boolean;
  poMode: 'HIDDEN' | 'OPTIONAL' | 'REQUIRED';
  /** The buyer's saved billing profile demands a PO number. */
  poRequiredByProfile: boolean;
  askInvoiceEmail: boolean;
  requirePhone: boolean;
  /** Methods the buyer can choose from right now. */
  paymentMethods: PaymentMethodCode[];
  /**
   * Settings → Payments & credit terms → DETAILS_VAT_ID_REQUIRED (s2b): when the
   * buyer's VAT ID is part of complete billing details. The payment page refuses
   * a receipt / card payment without it, so checkout asks for it up front.
   */
  vatIdRule?: VatIdRule;
}

const clip = (v: string | null | undefined, n: number) => (v ?? '').trim().slice(0, n);
const intOrNull = (v: string | null | undefined) => (v != null && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);
const on = (v: string | null | undefined) => v === 'on' || v === 'true' || v === '1';

export function formValuesFrom(get: (key: string) => string | null | undefined): CheckoutFormValues {
  const ct = clip(get('customerType'), 20).toUpperCase();
  return {
    source: get('source') === 'cart' ? 'cart' : 'single',
    slug: clip(get('slug'), 200),
    name: clip(get('name'), 120),
    phone: clip(get('phone'), 40),
    line1: clip(get('line1'), 200),
    line2: clip(get('line2'), 200),
    city: clip(get('city'), 80),
    postal: clip(get('postal'), 24),
    state: clip(get('state'), 80),
    country: clip(get('country'), 8).toUpperCase(),
    customerType: ct === 'CONSUMER' || ct === 'INSTITUTION' ? ct : 'BUSINESS',
    company: clip(get('company'), 160),
    kvk: clip(get('kvk'), 40),
    vatId: clip(get('vatId'), 40),
    billingSame: get('billingSame') == null ? true : on(get('billingSame')),
    billing: {
      name: clip(get('b_name'), 160),
      line1: clip(get('b_line1'), 200),
      line2: clip(get('b_line2'), 200),
      city: clip(get('b_city'), 80),
      postal: clip(get('b_postal'), 24),
      state: clip(get('b_state'), 80),
      country: clip(get('b_country'), 8).toUpperCase(),
    },
    invoiceEmail: clip(get('invoiceEmail'), 200).toLowerCase(),
    poNumber: clip(get('poNumber'), 60),
    paymentMethod: clip(get('paymentMethod'), 20).toUpperCase(),
    b2bDeclaration: on(get('b2bDeclaration')),
    saveProfile: on(get('saveProfile')),
    expected: { total: intOrNull(get('expectedTotal')), tax: intOrNull(get('expectedTax')), shipping: intOrNull(get('expectedShipping')) },
  };
}

export const isBusiness = (t: CustomerTypeCode) => t !== 'CONSUMER';

/** Billing country actually used (same as shipping unless a separate address is given). */
export function billingCountryOf(v: CheckoutFormValues): string {
  return v.billingSame ? v.country : v.billing.country;
}

/** The VAT ID as the VAT engine should see it ('' for consumers). */
export function vatIdFor(v: CheckoutFormValues): string {
  return isBusiness(v.customerType) ? v.vatId : '';
}

/** Field errors (key → sentence). Empty object = valid. */
export function validateCheckoutFields(v: CheckoutFormValues, r: CheckoutRules): Record<string, string> {
  const e: Record<string, string> = {};
  const need = (key: string, val: string, label: string) => {
    if (!val.trim()) e[key] = `${label} is required.`;
  };
  need('name', v.name, 'Full name');
  if (v.name && v.name.length < 2) e.name = 'Enter your full name.';
  if (r.requirePhone) need('phone', v.phone, 'Phone');
  if (v.phone && !/^[\d\s+()\-]{6,20}$/.test(v.phone)) e.phone = 'Use digits, spaces, +, ( ) and - only (6–20 characters).';
  need('line1', v.line1, 'Address line 1');
  need('city', v.city, 'City');
  need('postal', v.postal, 'Postal code');
  if (!/^[A-Z]{2}$/.test(v.country)) e.country = 'Choose the delivery country.';
  if (!v.billingSame) {
    need('b_line1', v.billing.line1, 'Billing address line 1');
    need('b_city', v.billing.city, 'Billing city');
    need('b_postal', v.billing.postal, 'Billing postal code');
    if (!/^[A-Z]{2}$/.test(v.billing.country)) e.b_country = 'Choose the billing country.';
  }
  if (v.customerType === 'CONSUMER' && r.salesMode === 'B2B_ONLY') {
    e.customerType = 'We sell to businesses and institutions only.';
  }
  if (isBusiness(v.customerType)) {
    if (r.requireCompanyAndId) {
      need('company', v.company, 'Company / institution name');
      if (!v.kvk && !v.vatId) e.kvk = 'Enter your KvK / company registration number or your VAT ID.';
    }
    if (!v.b2bDeclaration) e.b2bDeclaration = 'Please confirm that you buy on behalf of a business or institution.';
    if (v.vatId) {
      const p = parseVatId(v.vatId);
      if (!p || !VIES_PREFIXES.includes(p.prefix)) e.vatId = 'Enter an EU VAT ID with its country prefix, e.g. DE123456789 (or leave it empty).';
    } else if (vatIdRequiredFor(r.vatIdRule, billingCountryOf(v))) {
      e.vatId = r.vatIdRule === 'ALWAYS'
        ? 'Enter your company’s VAT ID — it is printed on the invoice.'
        : 'Enter your company’s EU VAT ID (required for business buyers in the EU — it is printed on the invoice).';
    }
    if ((r.poMode === 'REQUIRED' || r.poRequiredByProfile) && !v.poNumber) e.poNumber = 'Your purchase-order (PO) number is required.';
  }
  if (r.askInvoiceEmail && v.invoiceEmail && !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(v.invoiceEmail)) {
    e.invoiceEmail = 'Enter a valid email address (or leave it empty to use your account email).';
  }
  if (r.paymentMethods.length && !r.paymentMethods.includes(v.paymentMethod as PaymentMethodCode)) {
    e.paymentMethod = 'Choose how you want to pay.';
  }
  return e;
}
