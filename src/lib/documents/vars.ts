import type { Vars } from '@/lib/cms/text';
import { fmtRateBp } from '@/lib/tax/vat';
import type { DocKind, DocSnapshot, Lang } from './types';

/**
 * The fields ("placeholders") a document text may use. The editor's "Insert
 * field" menu is built from this list; anything else is refused on save.
 */
export interface FieldDef {
  name: string;
  label: string;
  example: string;
  kinds?: DocKind[];
}

export const DOC_FIELDS: FieldDef[] = [
  { name: 'customer.name', label: "Customer's name", example: 'Dr. Anna de Vries' },
  { name: 'customer.company', label: "Customer's company", example: 'Utrecht Bioanalytics B.V.' },
  { name: 'customer.email', label: "Customer's e-mail", example: 'anna@utrecht-bio.nl' },
  { name: 'customer.vat_id', label: "Customer's VAT ID", example: 'DE123456789' },
  { name: 'customer.country', label: "Customer's country", example: 'NL' },
  { name: 'customer.number', label: 'Customer number', example: 'C-1042' },
  { name: 'document.number', label: 'Document number', example: 'PRO-2026-0007' },
  { name: 'document.date', label: 'Document date', example: '5 November 2026' },
  { name: 'document.valid_until', label: 'Valid until (quote)', example: '19 November 2026', kinds: ['QUOTE'] },
  { name: 'document.valid_days', label: 'Validity in days (quote)', example: '14', kinds: ['QUOTE'] },
  { name: 'document.due_date', label: 'Due date (invoice)', example: '10 November 2026', kinds: ['INVOICE'] },
  { name: 'document.payment_days', label: 'Payment term in days (invoice)', example: '5', kinds: ['INVOICE'] },
  { name: 'document.total', label: 'Total amount', example: '€ 1,452.00' },
  { name: 'document.currency', label: 'Currency', example: 'EUR' },
  { name: 'order.number', label: 'Order number', example: 'L2D-2026-7KQ2XF' },
  { name: 'quote.number', label: 'Quote number', example: 'PRO-2026-0007' },
  { name: 'invoice.number', label: 'Invoice number', example: 'INV-2026-00012', kinds: ['INVOICE', 'RECEIPT'] },
  { name: 'payment.date', label: 'Payment date', example: '6 November 2026', kinds: ['INVOICE', 'RECEIPT'] },
  { name: 'payment.method', label: 'Payment method', example: 'Bank transfer', kinds: ['INVOICE', 'RECEIPT'] },
  { name: 'company.name', label: 'Our legal name', example: 'Labtodate B.V.' },
  { name: 'company.address', label: 'Our address (one line)', example: 'Stationsplein 1, 3511 ED Utrecht, Netherlands' },
  { name: 'company.city', label: 'Our city', example: 'Utrecht' },
  { name: 'company.email', label: 'Our e-mail', example: 'billing@labtodate.com' },
  { name: 'company.phone', label: 'Our phone', example: '+31 30 000 0000' },
  { name: 'company.website', label: 'Our website', example: 'labtodate.com' },
  { name: 'company.kvk', label: 'Our KvK number', example: '12345678' },
  { name: 'company.vat', label: 'Our VAT number', example: 'NL123456789B01' },
  { name: 'company.iban', label: 'Our IBAN', example: 'NL00 BANK 0123 4567 89' },
  { name: 'company.bic', label: 'Our BIC', example: 'BANKNL2A' },
  { name: 'company.bank', label: 'Our bank', example: 'ING Bank' },
  { name: 'site.name', label: 'Site name', example: 'Labtodate' },
  { name: 'site.url', label: 'Site address', example: 'https://labtodate.com' },
];

export function fieldsFor(kind?: DocKind): FieldDef[] {
  return DOC_FIELDS.filter((f) => !kind || !f.kinds || f.kinds.includes(kind));
}

/** The VAT row label may also use {{vat.rate}}. */
export const LABEL_EXTRA_FIELDS = ['vat.rate'];

const MONEY_LOCALE: Record<Lang, string> = { en: 'en-IE', nl: 'nl-NL' };
const DATE_LOCALE: Record<Lang, string> = { en: 'en-GB', nl: 'nl-NL' };

export function fmtMoney(cents: number, currency: string, lang: Lang): string {
  try {
    return new Intl.NumberFormat(MONEY_LOCALE[lang], { style: 'currency', currency: currency || 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function fmtNumber(n: number, lang: Lang): string {
  return new Intl.NumberFormat(MONEY_LOCALE[lang], { maximumFractionDigits: 2 }).format(n);
}

/** "5 November 2026" / "5 november 2026" in the business time zone. */
export function fmtDate(iso: string | Date | null | undefined, lang: Lang, timeZone = 'Europe/Amsterdam'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(DATE_LOCALE[lang], { day: 'numeric', month: 'long', year: 'numeric', timeZone });
}

export function methodLabel(snap: DocSnapshot): string {
  const m = (snap.paymentMethod || '').toUpperCase();
  if (!m) return '';
  if (m === 'BANK_TRANSFER' || m === 'RECEIPT') return snap.labels.methodBankTransfer;
  if (m === 'CARD' || m === 'STRIPE') return snap.labels.methodCard;
  return snap.labels.methodOther;
}

/** Placeholder values for one snapshot. */
export function docVars(snap: DocSnapshot): Vars {
  const L = snap.lang;
  const c = snap.company;
  const site = (process.env.BETTER_AUTH_URL || 'https://labtodate.com').replace(/\/+$/, '');
  return {
    'customer.name': snap.customer.name,
    'customer.company': snap.customer.company ?? '',
    'customer.email': snap.customer.email ?? '',
    'customer.vat_id': snap.customer.vatId ?? '',
    'customer.country': snap.customer.country ?? '',
    'customer.number': snap.customer.number ?? '',
    'document.number': snap.number,
    'document.date': fmtDate(snap.issuedAt, L, snap.timeZone),
    'document.valid_until': fmtDate(snap.validUntil, L, 'UTC'),
    'document.valid_days': snap.kind === 'QUOTE' ? String(snap.options.days) : '',
    'document.due_date': fmtDate(snap.dueDate, L, 'UTC'),
    'document.payment_days': snap.kind === 'INVOICE' ? String(snap.options.days) : '',
    'document.total': fmtMoney(snap.totalCents, snap.currency, L),
    'document.currency': snap.currency,
    'order.number': snap.refs.orderNumber ?? '',
    'quote.number': snap.refs.quoteNumber ?? '',
    'invoice.number': snap.refs.invoiceNumber ?? (snap.kind === 'INVOICE' ? snap.number : ''),
    'payment.date': fmtDate(snap.paidAt, L, snap.timeZone),
    'payment.method': methodLabel(snap),
    'company.name': c.name,
    'company.address': c.addressLines.join(', '),
    'company.city': c.city,
    'company.email': c.email,
    'company.phone': c.phone,
    'company.website': c.web,
    'company.kvk': c.kvk,
    'company.vat': c.vat,
    'company.iban': c.iban,
    'company.bic': c.bic,
    'company.bank': c.bank,
    'site.name': process.env.SITE_NAME || 'Labtodate',
    'site.url': site,
    'vat.rate': fmtRateBp(snap.vat.rateBp),
  };
}
