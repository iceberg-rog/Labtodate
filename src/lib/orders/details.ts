import { z } from 'zod';

/**
 * Billing + delivery details of an order (owner report 5: "who do we ship
 * to?"). Pure — shared by the offer acceptance step, the payment page form,
 * the admin order page and the server actions. Unit tests: details.test.ts.
 *
 * Stored on Order as two separate JSON blobs in the shape every reader of
 * Order.billingAddress / shippingAddress already understands
 * ({ name, company, phone, vat, address: { line1, line2, postal_code, city, state, country } }),
 * so the documents (lib/documents/snapshot.ts partyFromAddress), the VAT
 * engine (lib/tax/order.ts) and the admin pages read them unchanged.
 */

export interface BillingDetails {
  /** Legal name of the buyer's company / institution (printed as the invoice addressee). */
  legalName: string;
  /** Attention-of / contact person (optional). */
  contactName: string | null;
  vatId: string | null;
  line1: string;
  line2: string | null;
  postalCode: string;
  city: string;
  region: string | null;
  country: string;
  phone: string | null;
  /** Where invoices go (accounts payable), optional. */
  invoiceEmail: string | null;
  /** The buyer's purchase-order number (printed on proforma and invoice). */
  poNumber: string | null;
}

export interface DeliveryDetails {
  sameAsBilling: boolean;
  name: string;
  company: string | null;
  phone: string;
  line1: string;
  line2: string | null;
  postalCode: string;
  city: string;
  region: string | null;
  country: string;
}

export interface OrderDetails {
  billing: BillingDetails;
  delivery: DeliveryDetails;
}

const t = (max: number) => z.string().trim().max(max, `at most ${max} characters`);
const opt = (max: number) => t(max).optional().transform((v) => (v ? v : null));
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'choose a country');

const BillingSchema = z.object({
  legalName: t(180).min(2, 'enter the company or institution name'),
  contactName: opt(120),
  vatId: z.string().trim().max(20, 'at most 20 characters').optional()
    .transform((v) => (v ? v.toUpperCase().replace(/[\s.\-_/]+/g, '') : null))
    .refine((v) => v == null || /^[A-Z]{2}[0-9A-Z+*]{2,13}$/.test(v), 'start with the 2-letter country code, e.g. NL859876543B01 or DE123456789'),
  line1: t(200).min(3, 'enter the street and number'),
  line2: opt(200),
  postalCode: t(24).min(2, 'enter the postal code'),
  city: t(80).min(2, 'enter the city'),
  region: opt(80),
  country,
  phone: opt(40),
  invoiceEmail: z.string().trim().max(200).optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v == null || /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(v), 'enter a valid email address'),
  poNumber: opt(60),
});

const DeliverySchema = z.object({
  sameAsBilling: z.boolean(),
  name: t(120),
  company: opt(180),
  phone: t(40),
  line1: t(200),
  line2: opt(200),
  postalCode: t(24),
  city: t(80),
  region: opt(80),
  country: z.string().trim().toUpperCase(),
});

/** Field names as the forms post them (prefix b_ = billing, d_ = delivery). */
export const DETAIL_FIELDS = {
  billing: ['legalName', 'contactName', 'vatId', 'line1', 'line2', 'postalCode', 'city', 'region', 'country', 'phone', 'invoiceEmail', 'poNumber'] as const,
  delivery: ['name', 'company', 'phone', 'line1', 'line2', 'postalCode', 'city', 'region', 'country'] as const,
};

export type DetailsFieldErrors = Record<string, string>;

export type DetailsParse =
  | { ok: true; details: OrderDetails }
  | { ok: false; message: string; fieldErrors: DetailsFieldErrors };

const LABELS: Record<string, string> = {
  b_legalName: 'Company / institution', b_contactName: 'Contact person', b_vatId: 'VAT ID', b_line1: 'Billing address',
  b_line2: 'Billing address line 2', b_postalCode: 'Billing postal code', b_city: 'Billing city', b_region: 'Billing region',
  b_country: 'Billing country', b_phone: 'Billing phone', b_invoiceEmail: 'Invoice email', b_poNumber: 'PO number',
  d_name: 'Recipient', d_company: 'Delivery company', d_phone: 'Delivery phone', d_line1: 'Delivery address',
  d_line2: 'Delivery address line 2', d_postalCode: 'Delivery postal code', d_city: 'Delivery city', d_region: 'Delivery region',
  d_country: 'Delivery country',
};

export function detailsFieldLabel(key: string): string {
  return LABELS[key] ?? key;
}

/** When the buyer's VAT ID is part of complete billing details (setting DETAILS_VAT_ID_REQUIRED). */
export type VatIdRule = 'EU' | 'ALWAYS' | 'OFF';
const EU_CODES = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
export function vatIdRequiredFor(rule: VatIdRule | undefined, billingCountry: string | null | undefined): boolean {
  if (rule === 'ALWAYS') return true;
  if (rule === 'EU') return EU_CODES.has(String(billingCountry ?? '').trim().toUpperCase());
  return false;
}

/** Parse the posted form values (`b_*`, `d_*`, `d_same`). */
export function parseDetailsInput(raw: Record<string, unknown>, opts: { vatIdRule?: VatIdRule } = {}): DetailsParse {
  const g = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : raw[k] == null ? undefined : String(raw[k]));
  const same = ['on', 'true', '1', 'yes'].includes(String(raw.d_same ?? '').toLowerCase());
  const fieldErrors: DetailsFieldErrors = {};

  const b = BillingSchema.safeParse(Object.fromEntries(DETAIL_FIELDS.billing.map((f) => [f, g(`b_${f}`) ?? ''])));
  if (!b.success) for (const i of b.error.issues) fieldErrors[`b_${String(i.path[0])}`] ??= i.message;
  if (b.success && !b.data.vatId && vatIdRequiredFor(opts.vatIdRule, b.data.country)) {
    fieldErrors.b_vatId ??= opts.vatIdRule === 'ALWAYS' ? 'enter your VAT ID' : 'enter your VAT ID (required for buyers in the EU)';
  }

  let delivery: DeliveryDetails | null = null;
  if (b.success) {
    const bd = b.data;
    const src = same
      ? {
          sameAsBilling: true,
          name: g('d_name')?.trim() || bd.contactName || bd.legalName,
          company: bd.legalName,
          phone: g('d_phone')?.trim() || bd.phone || '',
          line1: bd.line1, line2: bd.line2 ?? '', postalCode: bd.postalCode, city: bd.city, region: bd.region ?? '', country: bd.country,
        }
      : { sameAsBilling: false, ...Object.fromEntries(DETAIL_FIELDS.delivery.map((f) => [f, g(`d_${f}`) ?? ''])) };
    const d = DeliverySchema.safeParse(src);
    if (d.success) delivery = d.data as DeliveryDetails;
    else for (const i of d.error.issues) fieldErrors[`d_${String(i.path[0])}`] ??= i.message;
  }
  // Delivery must be complete for a carrier: recipient, phone, street, postcode, city, country.
  if (delivery) {
    if (delivery.name.length < 2) fieldErrors.d_name ??= 'enter the recipient’s name';
    if (delivery.phone.replace(/[^\d]/g, '').length < 6) fieldErrors.d_phone ??= 'enter a phone number the carrier can call';
    if (delivery.line1.length < 3) fieldErrors.d_line1 ??= 'enter the street and number';
    if (delivery.postalCode.length < 2) fieldErrors.d_postalCode ??= 'enter the postal code';
    if (delivery.city.length < 2) fieldErrors.d_city ??= 'enter the city';
    if (!/^[A-Z]{2}$/.test(delivery.country)) fieldErrors.d_country ??= 'choose a country';
  } else if (!same && !Object.keys(fieldErrors).some((k) => k.startsWith('d_'))) {
    fieldErrors.d_line1 = 'enter the delivery address';
  }
  if (Object.keys(fieldErrors).length || !b.success || !delivery) {
    const first = Object.entries(fieldErrors)[0];
    return {
      ok: false,
      fieldErrors,
      message: first ? `${detailsFieldLabel(first[0])}: ${first[1]}.${Object.keys(fieldErrors).length > 1 ? ` (${Object.keys(fieldErrors).length} fields need attention.)` : ''}` : 'Check the details and try again.',
    };
  }
  return { ok: true, details: { billing: b.data as BillingDetails, delivery } };
}

/** Order.billingAddress JSON. */
export function billingAddressJson(b: BillingDetails): Record<string, unknown> {
  return {
    name: b.contactName,
    company: b.legalName,
    email: b.invoiceEmail,
    phone: b.phone,
    vat: b.vatId,
    poNumber: b.poNumber,
    address: { line1: b.line1, line2: b.line2, postal_code: b.postalCode, city: b.city, state: b.region, country: b.country },
  };
}

/** Order.shippingAddress JSON. */
export function shippingAddressJson(d: DeliveryDetails, email?: string | null): Record<string, unknown> {
  return {
    name: d.name,
    company: d.company,
    phone: d.phone,
    ...(email ? { email } : {}),
    sameAsBilling: d.sameAsBilling,
    address: { line1: d.line1, line2: d.line2, postal_code: d.postalCode, city: d.city, state: d.region, country: d.country },
  };
}

type Obj = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const addrOf = (o: Obj): Obj => (o.address && typeof o.address === 'object' ? (o.address as Obj) : o);

/** Form prefill (all strings) from what is stored on the order / profile. */
export interface DetailsPrefill {
  b: Record<(typeof DETAIL_FIELDS.billing)[number], string>;
  d: Record<(typeof DETAIL_FIELDS.delivery)[number], string>;
  same: boolean;
}

export function emptyPrefill(): DetailsPrefill {
  return {
    b: Object.fromEntries(DETAIL_FIELDS.billing.map((f) => [f, ''])) as DetailsPrefill['b'],
    d: Object.fromEntries(DETAIL_FIELDS.delivery.map((f) => [f, ''])) as DetailsPrefill['d'],
    same: true,
  };
}

/**
 * Prefill from (in order of preference) the order's own details, the buyer's
 * saved billing profile, then the quote request (company) and account (name).
 */
export function prefillDetails(src: {
  billingAddress?: unknown;
  shippingAddress?: unknown;
  /** Order.poNumber / Order.invoiceEmail (checkout orders keep them in these columns). */
  poNumber?: string | null;
  invoiceEmail?: string | null;
  profile?: { legalName: string; contactName: string | null; vatId: string | null; address: unknown; country: string; phone: string | null; invoiceEmail: string | null } | null;
  companyName?: string | null;
  buyerName?: string | null;
}): DetailsPrefill {
  const p = emptyPrefill();
  const bill = src.billingAddress && typeof src.billingAddress === 'object' ? (src.billingAddress as Obj) : null;
  const ship = src.shippingAddress && typeof src.shippingAddress === 'object' ? (src.shippingAddress as Obj) : null;
  if (bill) {
    const a = addrOf(bill);
    Object.assign(p.b, {
      legalName: s(bill.company), contactName: s(bill.name), vatId: s(bill.vat) || s(bill.vatId), line1: s(a.line1), line2: s(a.line2),
      postalCode: s(a.postal_code) || s(a.postalCode), city: s(a.city), region: s(a.state) || s(a.region), country: s(a.country).toUpperCase(),
      phone: s(bill.phone), invoiceEmail: s(src.invoiceEmail) || s(bill.email), poNumber: s(bill.poNumber) || s(src.poNumber),
    });
  } else if (src.profile) {
    const a = (src.profile.address && typeof src.profile.address === 'object' ? src.profile.address : {}) as Obj;
    Object.assign(p.b, {
      legalName: src.profile.legalName, contactName: src.profile.contactName ?? '', vatId: src.profile.vatId ?? '',
      line1: s(a.line1), line2: s(a.line2), postalCode: s(a.postalCode) || s(a.postal_code), city: s(a.city), region: s(a.region) || s(a.state),
      country: (s(a.country) || src.profile.country || '').toUpperCase(), phone: src.profile.phone ?? '', invoiceEmail: src.profile.invoiceEmail ?? '',
    });
  }
  if (!p.b.poNumber && src.poNumber) p.b.poNumber = s(src.poNumber);
  if (!p.b.legalName) p.b.legalName = s(src.companyName) || s(ship?.company);
  if (!p.b.contactName && src.buyerName) p.b.contactName = s(src.buyerName);
  // A legacy / checkout order may only have a shipping address: use it for billing too.
  if (!bill && !src.profile && ship) {
    const a = addrOf(ship);
    if (!p.b.line1) Object.assign(p.b, {
      line1: s(a.line1), line2: s(a.line2), postalCode: s(a.postal_code) || s(a.postalCode), city: s(a.city), region: s(a.state), country: s(a.country).toUpperCase(),
    });
    if (!p.b.vatId) p.b.vatId = s(ship.vat);
  }
  if (ship) {
    const a = addrOf(ship);
    Object.assign(p.d, {
      name: s(ship.name), company: s(ship.company), phone: s(ship.phone), line1: s(a.line1), line2: s(a.line2),
      postalCode: s(a.postal_code) || s(a.postalCode), city: s(a.city), region: s(a.state) || s(a.region), country: s(a.country).toUpperCase(),
    });
    p.same = ship.sameAsBilling === true || (!!bill && sameAddress(bill, ship));
  } else {
    p.d.name = p.b.contactName || s(src.buyerName);
    p.d.phone = p.b.phone;
    p.same = true;
  }
  return p;
}

function sameAddress(a: Obj, b: Obj): boolean {
  const x = addrOf(a);
  const y = addrOf(b);
  return ['line1', 'postal_code', 'city', 'country'].every((k) => s(x[k]).toLowerCase() === s(y[k]).toLowerCase());
}

/**
 * What is still missing before payment can be submitted / verified (empty = complete).
 * A consumer order (checkout with SALES_MODE = B2B_AND_B2C, Order.customerType
 * CONSUMER) never needs a VAT ID — consumers have none.
 */
export function orderDetailsProblems(o: { billingAddress: unknown; shippingAddress: unknown; customerType?: string | null }, opts: { vatIdRule?: VatIdRule } = {}): string[] {
  const out: string[] = [];
  const bill = o.billingAddress && typeof o.billingAddress === 'object' ? (o.billingAddress as Obj) : null;
  const ship = o.shippingAddress && typeof o.shippingAddress === 'object' ? (o.shippingAddress as Obj) : null;
  // A checkout order without separate billing details bills to the delivery address.
  const billSrc = bill ?? ship;
  if (!billSrc) out.push('billing details');
  else {
    const a = addrOf(billSrc);
    if (!s(billSrc.company) && !s(billSrc.name)) out.push('billing name / company');
    if (!s(a.line1) || !s(a.city) || !(s(a.postal_code) || s(a.postalCode)) || !/^[A-Za-z]{2}$/.test(s(a.country))) out.push('complete billing address');
    if (!s(billSrc.vat) && !s(billSrc.vatId) && o.customerType !== 'CONSUMER' && vatIdRequiredFor(opts.vatIdRule, s(a.country))) out.push('VAT ID');
  }
  if (!ship) out.push('delivery address');
  else {
    const a = addrOf(ship);
    if (!s(ship.name)) out.push('delivery recipient');
    if (!s(ship.phone)) out.push('delivery phone');
    if (!s(a.line1) || !s(a.city) || !(s(a.postal_code) || s(a.postalCode)) || !/^[A-Za-z]{2}$/.test(s(a.country))) out.push('complete delivery address');
  }
  return out;
}

/** Country codes (ship-to, billing) of stored details. */
export function detailsCountries(o: { billingAddress: unknown; shippingAddress: unknown }): { ship: string | null; bill: string | null } {
  const c = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return null;
    const v = s(addrOf(raw as Obj).country).toUpperCase();
    return /^[A-Z]{2}$/.test(v) ? v : null;
  };
  return { ship: c(o.shippingAddress), bill: c(o.billingAddress) ?? c(o.shippingAddress) };
}

/** One-line, bidi-safe summary pieces for display ("Keizersgracht 123", "1015 CJ Amsterdam", "NL"). */
export function addressLines(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Obj;
  const a = addrOf(o);
  const cityLine = [s(a.postal_code) || s(a.postalCode), s(a.city)].filter(Boolean).join(' ');
  return [s(a.line1), s(a.line2), [cityLine, s(a.state) || s(a.region)].filter(Boolean).join(', '), s(a.country).toUpperCase()].filter(Boolean);
}

/** Do two stored detail sets differ in anything printed on a document? */
export function detailsDiffer(a: { billingAddress: unknown; shippingAddress: unknown }, b: { billingAddress: unknown; shippingAddress: unknown }): boolean {
  const norm = (v: unknown) => JSON.stringify(v ?? null, (k, val) => (k === 'sameAsBilling' ? undefined : typeof val === 'string' ? val.trim() : val));
  return norm(a.billingAddress) !== norm(b.billingAddress) || norm(a.shippingAddress) !== norm(b.shippingAddress);
}

/** Read-only display lines of the stored details (each line bidi-isolated by the UI). */
export function detailsSummary(o: { billingAddress: unknown; shippingAddress: unknown; poNumber?: string | null }): { billing: string[]; delivery: string[]; vatId: string | null; po: string | null } {
  const bill = o.billingAddress && typeof o.billingAddress === 'object' ? (o.billingAddress as Obj) : null;
  const ship = o.shippingAddress && typeof o.shippingAddress === 'object' ? (o.shippingAddress as Obj) : null;
  const billing = bill
    ? [s(bill.company) || s(bill.name), ...(s(bill.company) && s(bill.name) ? [`Attn. ${s(bill.name)}`] : []), ...addressLines(bill), ...(s(bill.email) ? [s(bill.email)] : [])].filter(Boolean)
    : [];
  const delivery = ship
    ? [s(ship.name), ...(s(ship.company) && s(ship.company) !== s(ship.name) ? [s(ship.company)] : []), ...addressLines(ship), ...(s(ship.phone) ? [`Tel. ${s(ship.phone)}`] : [])].filter(Boolean)
    : [];
  return { billing, delivery, vatId: bill ? s(bill.vat) || null : ship ? s(ship.vat) || null : null, po: (bill ? s(bill.poNumber) : '') || s(o.poNumber) || null };
}
