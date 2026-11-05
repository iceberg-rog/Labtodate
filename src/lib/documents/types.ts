import type { VatTreatment } from '@/lib/tax/vat';

export type Lang = 'en' | 'nl';
export const LANGS: Lang[] = ['en', 'nl'];
export const LANG_LABEL: Record<Lang, string> = { en: 'English', nl: 'Dutch' };

export type DocKind = 'QUOTE' | 'INVOICE' | 'RECEIPT';
export const DOC_KINDS: DocKind[] = ['QUOTE', 'INVOICE', 'RECEIPT'];
export const DOC_KIND_LABEL: Record<DocKind, string> = { QUOTE: 'Quote / proforma', INVOICE: 'Invoice', RECEIPT: 'Receipt' };

export function asLang(v: unknown, fallback: Lang = 'en'): Lang {
  return v === 'nl' || v === 'en' ? v : fallback;
}

/** Texts of one document in one language (Admin → Documents → Templates). */
export interface DocTexts {
  title: string;
  /** Title while an invoice is not paid yet (INVOICE only). */
  titleUnpaid?: string;
  numberLabel: string;
  greeting: string;
  greetingFallback: string;
  intro: string;
  paymentTerms: string;
  closing: string;
  footer: string;
  /** Stamp next to the title ("Paid", "Payment due"); empty = no stamp. */
  stamp: string;
  stampUnpaid?: string;
}

/** Labels shared by all documents in one language. */
export interface CommonLabels {
  date: string;
  validUntil: string;
  dueDate: string;
  customerNo: string;
  orderNo: string;
  quoteRef: string;
  invoiceRef: string;
  preparedFor: string;
  billTo: string;
  shipTo: string;
  customerVat: string;
  colDescription: string;
  colQty: string;
  colUnit: string;
  colAmount: string;
  shipping: string;
  subtotal: string;
  vatRow: string;
  vatRowZero: string;
  total: string;
  totalDue: string;
  paymentDetails: string;
  amountDue: string;
  payBefore: string;
  iban: string;
  bic: string;
  bank: string;
  beneficiary: string;
  reference: string;
  noBankDetails: string;
  paidBox: string;
  paidOn: string;
  amountPaid: string;
  paymentMethod: string;
  companyPhone: string;
  companyEmail: string;
  companyWeb: string;
  companyKvk: string;
  companyVat: string;
  signGreeting: string;
  signAgreed: string;
  signName: string;
  signDate: string;
  signSignature: string;
  legalReverseCharge: string;
  legalExport: string;
  page: string;
  voidStamp: string;
  methodBankTransfer: string;
  methodCard: string;
  methodOther: string;
}

/** Language-independent options of one document. */
export interface DocOptions {
  showLogo: boolean;
  showSignature: boolean;
  showCustomerNo: boolean;
  showBankDetails: boolean;
  showGreeting: boolean;
  /** QUOTE: validity in days. INVOICE: payment term in days. RECEIPT: unused. */
  days: number;
}

export interface GeneralDocSettings {
  defaultLang: Lang;
  accent: string;
  /** What happens when a legally required company field is empty. */
  readiness: 'WARN' | 'BLOCK';
  /** Send the receipt (with its PDF) when a payment is verified. */
  receiptEnabled: boolean;
  /** Attach the invoice PDF to the payment-confirmed e-mail. */
  attachInvoice: boolean;
  /** Send a copy of every issued document to the billing address. */
  billingCopy: boolean;
}

export interface DocLine {
  title: string;
  qty: number;
  unitCents: number;
  /** Optional second line under the title (condition, serial, lead time). */
  detail?: string | null;
}

export interface DocParty {
  name: string;
  company?: string | null;
  email?: string | null;
  addressLines: string[];
  country?: string | null;
  vatId?: string | null;
  number?: string | null;
}

export interface CompanySnapshot {
  name: string;
  addressLines: string[];
  city: string;
  phone: string;
  email: string;
  web: string;
  kvk: string;
  vat: string;
  iban: string;
  bic: string;
  bank: string;
  logo: string | null;
}

/**
 * Everything a document is rendered from. Frozen into IssuedDocument.snapshot
 * when issued, so the same PDF can be re-made byte-for-byte in content and a
 * later template/company change never alters it.
 */
export interface DocSnapshot {
  v: 1;
  kind: DocKind;
  lang: Lang;
  number: string;
  revision: number;
  /** INVOICE: paid at issue (reads as settled). */
  paid: boolean;
  /** Not issued: an admin preview or an unpaid payment request. */
  preview?: boolean;
  voided?: boolean;
  issuedAt: string;
  validUntil?: string | null;
  dueDate?: string | null;
  paidAt?: string | null;
  paymentMethod?: string | null;
  currency: string;
  company: CompanySnapshot;
  customer: DocParty;
  shipTo?: string[] | null;
  lines: DocLine[];
  shippingCents: number;
  subtotalCents: number;
  vat: { treatment: VatTreatment | 'LEGACY'; rateBp: number; cents: number; reason?: string | null };
  totalCents: number;
  refs: { orderNumber?: string | null; quoteNumber?: string | null; invoiceNumber?: string | null };
  note?: string | null;
  texts: DocTexts;
  labels: CommonLabels;
  options: DocOptions;
  accent: string;
  timeZone: string;
}
