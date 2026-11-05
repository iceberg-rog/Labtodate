/**
 * Editable site content (Admin → Site content). Every text the site shows
 * that is a business choice — claims, promises, page texts, legal pages,
 * menu items — is a SiteTextDef with a built-in default. Pages read them
 * with siteTexts(); nothing business-relevant stays typed in a component.
 */

export type SiteTextKind = 'text' | 'rich' | 'page' | 'toggle' | 'select' | 'number';

export interface SiteTextDef {
  /** Unique dotted key, e.g. "claims.warranty". */
  key: string;
  label: string;
  kind: SiteTextKind;
  /** Built-in value (toggle: 'on' | 'off'; select: one of options). */
  default: string;
  hint?: string;
  max?: number;
  options?: { value: string; label: string }[];
  /** Number limits (kind 'number'). */
  min?: number;
  maxValue?: number;
  /** Cannot be saved empty (e.g. a time that sentences elsewhere quote). */
  required?: boolean;
  /** 'url': empty, or a full https:// address (social links). */
  format?: 'url';
  /**
   * Claims this text states without naming them as a field (e.g. “Inspected &
   * warrantied”). While one of them is switched off the text disappears, the
   * same as a text that uses {{claims.…}}.
   */
  needs?: ('claims.warranty' | 'claims.inspection' | 'claims.quote_turnaround')[];
}

export interface SiteTextGroup {
  /** Stored as ContentEntry "site:<id>". */
  id: string;
  label: string;
  /** Where it shows on the site (the admin's "Open page" link). */
  page?: string;
  description?: string;
  fields: SiteTextDef[];
}

/**
 * Fields site texts may use. They are filled from the company settings and
 * the claims group, so e.g. the Terms quote the same validity the quote
 * documents use.
 */
export const SITE_FIELDS: { name: string; label: string; example: string }[] = [
  { name: 'site.name', label: 'Site name', example: 'Labtodate' },
  { name: 'site.url', label: 'Site address', example: 'https://labtodate.com' },
  { name: 'company.name', label: 'Legal company name', example: 'Labtodate B.V.' },
  { name: 'company.address', label: 'Company address (one line)', example: 'Stationsplein 1, 3511 ED Utrecht' },
  { name: 'company.country', label: 'Company country', example: 'Netherlands' },
  { name: 'company.email', label: 'Billing e-mail', example: 'billing@labtodate.com' },
  { name: 'company.phone', label: 'Company phone', example: '+31 30 000 0000' },
  { name: 'company.vat', label: 'Company VAT number', example: 'NL123456789B01' },
  { name: 'company.kvk', label: 'Company KvK number', example: '12345678' },
  { name: 'company.name_country', label: 'Company name with its country in brackets (when set)', example: 'Labtodate B.V. (Netherlands)' },
  { name: 'company.name_address', label: 'Company name, address and country (the parts that are set)', example: 'Labtodate B.V., Stationsplein 1, 3511 ED Utrecht, Netherlands' },
  { name: 'support.email', label: 'Support e-mail', example: 'support@labtodate.com' },
  { name: 'support.contact', label: 'Contact link: the support e-mail, or the contact page when none is set', example: 'support@labtodate.com' },
  { name: 'claims.warranty', label: 'Warranty claim', example: '90-day warranty' },
  { name: 'claims.inspection', label: 'Inspection claim', example: '14-point inspection' },
  { name: 'claims.quote_turnaround', label: 'Quote response time', example: '5 business days' },
  { name: 'rules.quote_valid_days', label: 'Quote validity (days)', example: '14' },
  { name: 'rules.payment_term_days', label: 'Invoice payment term (days)', example: '5' },
  { name: 'rules.return_days', label: 'Days to report a problem', example: '7' },
  { name: 'rules.payment_verify_time', label: 'Payment check time', example: '1 business day' },
  { name: 'rules.contact_reply_time', label: 'Contact reply time', example: 'one business day' },
  { name: 'rules.sell_reply_time', label: 'Sell-offer reply time', example: '2 business days' },
  { name: 'rules.support_reply_time', label: 'Support reply time', example: '1 business day' },
  { name: 'stats.listings', label: 'Number of listings', example: '24' },
  { name: 'date.year', label: 'Current year', example: '2026' },
];
