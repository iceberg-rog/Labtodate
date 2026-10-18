/**
 * Typed settings registry (B00) — the ONE list of admin-configurable business
 * rules. Pure data + pure validators: no DB, no process.env access, so it can
 * be imported anywhere (server, client components, unit tests).
 *
 * Resolution order for a key's effective value (see ./index.ts):
 *   DB row (Admin → Settings)  >  server .env  >  `default` below  >  ''.
 *
 * Every entry says what it does (`hint`), what it affects (`effect`), and —
 * when the code that uses it has not shipped yet — `pending`, which the admin
 * UI shows as "saved, not applied yet" instead of pretending it works.
 */

import { POLICY_DEFS, POLICY_GROUPS, type PolicyDef } from '../security/policy-defs';
import { CATALOG_SETTING_DEFS } from '../catalog/settings-defs';
import { QUOTE_SETTING_DEFS } from '../quotes/settings-defs';
import { DOC_LABEL_DEFS, DOC_LABEL_KEYS, docLabelSettingKey } from '../documents/labels';
import { FULFILMENT_SETTING_DEFS } from '../fulfilment/settings-defs';
import { SUPPORT_SETTING_DEFS } from '../support/settings-defs';
import { HOME_SETTING_DEFS } from '../home/settings-defs';
import {
  ABOUT_PAGE_TOKENS, COOKIE_POLICY_TOKENS, DEFAULT_ABOUT_PAGE_TEXT, DEFAULT_BUYER_CANCEL_DISABLED_TEXT, DEFAULT_CONSUMER_WITHDRAWAL_TEXT,
  DEFAULT_COOKIE_POLICY_TEXT, DEFAULT_FAQ_TEXT, DEFAULT_PRIVACY_POLICY_TEXT, DEFAULT_SELL_DECONTAMINATION_TEXT, DEFAULT_SELL_TERMS_TEXT,
  DEFAULT_SELLER_PAYOUT_TERMS_TEXT, DEFAULT_SELLER_TERMS_TEXT, FAQ_TOKENS, PRIVACY_POLICY_TOKENS, SELLER_TERMS_TOKENS,
} from './page-texts';

export const SETTING_GROUPS = [
  'Company',
  'Tax & VAT',
  'Invoicing & numbering',
  'Payments & credit terms',
  'Quotes & offers',
  'Shipping',
  'Fulfilment & delivery',
  'Returns & refunds',
  'Compliance & countries',
  'Stock & reservation',
  'Sales channel',
  'Checkout & customers',
  'Documents & legal texts',
  'Email texts',
  'Email',
  'Security',
  'Brand',
  'Site texts & pages',
  'Homepage',
  'Support',
  'Catalog & claims',
  'Import & suppliers',
  'Suppliers',
  'Acquisitions',
  'AI assistant',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/**
 * Groups edited by their owner's own panel instead of the generic field list
 * (the grouped settings page shows that panel in the group's tab). Their keys
 * are still registered below — one typed list, one Change history — but are
 * saved only through the owner's action:
 *   Security → saveSecurityPolicy (security:manage + a fresh authenticator code).
 */
export const PANEL_GROUPS: readonly SettingGroup[] = ['Security'];

export type SettingType =
  | 'string'   // one line of text
  | 'text'     // multi-line text (legal texts, addresses)
  | 'secret'   // never shown back; masked in history
  | 'email'
  | 'url'
  | 'image'    // URL or site-relative path of an image
  | 'int'      // whole number (min/max)
  | 'percent'  // "21" or "25.5" (0–100, max 2 decimals); typed getter returns basis points
  | 'money'    // stored in CENTS ("1250"); the admin form shows/accepts euros ("12.50")
  | 'bool'     // "true" | "false"
  | 'enum'     // one of `options`
  | 'list'     // comma-separated tokens
  | 'country'; // ISO 3166-1 alpha-2

export type SettingEffect = 'immediate' | 'new-documents';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDefinition {
  key: string;
  label: string;
  group: SettingGroup;
  type: SettingType;
  hint: string;
  /** Registry default used when neither the DB nor .env sets the key. */
  default?: string;
  options?: readonly SettingOption[];
  min?: number;
  max?: number;
  /** Allow an empty value (= "not set", e.g. "no free-shipping threshold"). */
  optional?: boolean;
  /** Once set, the value can be changed but never emptied (legal identity and
   *  bank details printed on every document): saving it empty is refused. */
  required?: boolean;
  multiline?: boolean;
  /** Old field-level check button on the settings page. */
  verify?: 'email' | 'number' | 'url' | 'image';
  preview?: string;
  /** 'new-documents': read at issue time and frozen into each document. */
  effect?: SettingEffect;
  /** Changes alert every admin (bank, identity, tax, numbering). */
  sensitive?: boolean;
  /** Saved but not applied yet: names the feature that will apply it. */
  pending?: string;
  /** Extra per-key validation (pure). Return a reason, or null when valid.
   *  `ctx` gives other keys' values as they will be after the save (absent
   *  outside a save: rules then assume those keys' registry defaults). */
  validate?: (value: string, ctx?: SettingValidationContext) => string | null;
  /** Derived: type === 'secret'. Kept for older callers. */
  secret: boolean;
}

/** Read access to the other settings while one value is validated. */
export interface SettingValidationContext {
  /** Effective value of `key` once the save being checked is applied. */
  value(key: string): string;
}

type DefInput = Omit<SettingDefinition, 'secret'>;
/** A registry entry as written by its owner (`secret` is derived from `type`). */
export type SettingDefinitionInput = DefInput;

// ── validators (pure) ────────────────────────────────────────────────────────

/** ISO 13616 IBAN check (mod-97). Spaces are ignored. */
export function isValidIban(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** Seller VAT ID: NL format checked strictly, other EU formats loosely. */
export function companyVatIdProblem(v: string): string | null {
  const id = v.replace(/[\s.-]+/g, '').toUpperCase();
  if (id.startsWith('NL')) {
    return /^NL\d{9}B\d{2}$/.test(id) ? null : 'a Dutch VAT ID (BTW-id) looks like NL123456789B01 — this is not the KvK number.';
  }
  return /^(?:[A-Z]{2}|EL)[0-9A-Z+*]{2,13}$/.test(id) ? null : 'must start with the 2-letter country code, e.g. NL123456789B01.';
}

/**
 * Company register number (COMPANY_KVK). With the VAT home country NL it is a
 * Dutch KvK number: exactly 8 digits (spaces ignored). Other home countries'
 * registers have their own formats (letters allowed), checked loosely.
 */
export function companyRegisterNumberProblem(v: string, homeCountry: string): string | null {
  const id = v.replace(/\s+/g, '');
  if (homeCountry.trim().toUpperCase() === 'NL') {
    return /^\d{8}$/.test(id) ? null : 'a Dutch KvK number is exactly 8 digits, e.g. 12345678 (no letters).';
  }
  return /^(?=.*\d)[A-Za-z0-9./-]{2,30}$/.test(id) ? null : 'use the number of your company register (letters, digits and - . / only).';
}

/** Comma-separated list of absolute https:// links (profile pages). */
function httpsLinksProblem(v: string): string | null {
  const bad = v.split(',').map((s) => s.trim()).filter(Boolean).filter((s) => {
    try {
      return new URL(s).protocol !== 'https:';
    } catch {
      return true;
    }
  });
  return bad.length ? `“${bad.slice(0, 3).join('”, “')}” — every link must be a full https:// address.` : null;
}

const NUMBER_TOKENS = /\{(PREFIX|YYYY|YY|SEQ(?::\d)?)\}/g;
export function numberFormatProblem(v: string): string | null {
  if (!/\{SEQ(?::\d)?\}/.test(v)) return 'must contain {SEQ} (or {SEQ:5} for zero-padding to 5 digits).';
  const stripped = v.replace(NUMBER_TOKENS, '');
  if (/[{}]/.test(stripped)) return 'unknown placeholder — use {PREFIX}, {YYYY}, {YY}, {SEQ} or {SEQ:n}.';
  if (!/^[A-Za-z0-9\-/_.]*$/.test(stripped)) return 'only letters, digits and - / _ . are allowed around the placeholders.';
  return null;
}

const prefixProblem = (v: string) => (/^[A-Z0-9]{1,8}$/.test(v) ? null : 'use 1–8 capital letters or digits, e.g. INV.');
const tokensHint = (tokens: readonly string[]) => ` Placeholders: ${tokens.join(', ')}.`;

const yesNo: readonly SettingOption[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];
export const BOOL_OPTIONS = yesNo;

// ── the registry ─────────────────────────────────────────────────────────────

const PAYMENT_METHOD_CODES = ['BANK_TRANSFER', 'STRIPE_CARD'] as const;
const vatTextHint = 'Shown in the checkout summary under the VAT line. {COUNTRY} = delivery country, {RATE} = VAT rate, {HOME_COUNTRY} = your VAT home country. The exact rule (for staff) is kept on the order.';
const holdTextHint = (what: string) =>
  `Shown to the buyer at checkout, on the order page and in the confirmation email when ${what}. {COUNTRY} = destination, {REASON} = the rule that needs a person.`;

/**
 * A security-policy rule (src/lib/security/policy-defs.ts) as a registry entry.
 * The policy keeps its own richer form (multi-select sets, units, cross-field
 * rules) on the Security tab; the registry gives every key its typed default,
 * validation, label and Change history entry.
 */
function securityPolicySetting(d: PolicyDef): DefInput {
  const base = {
    key: d.key,
    label: d.label,
    group: 'Security' as const,
    hint: `${POLICY_GROUPS[d.group]} — ${d.hint}`,
    sensitive: true,
  };
  switch (d.type) {
    case 'bool':
      return { ...base, type: 'bool', default: String(d.default), options: yesNo };
    case 'int':
      return { ...base, type: 'int', default: String(d.default), min: d.min, max: d.max };
    case 'set':
      return {
        ...base,
        type: 'list',
        default: d.default.join(','),
        optional: true,
        validate: (v) => {
          const bad = v.split(',').map((s) => s.trim()).filter((s) => s && !(s in d.options));
          return bad.length ? `unknown option ${bad.join(', ')} — choose from ${Object.keys(d.options).join(', ')}.` : null;
        },
      };
    case 'text':
      return {
        ...base,
        type: 'string',
        optional: true,
        ...(d.default ? { default: d.default } : {}),
        validate: (v) => (d.pattern && !d.pattern.test(v) ? `“${v}” is not valid (${d.patternHint ?? 'check the format'}).` : null),
      };
    case 'list':
      return {
        ...base,
        type: 'list',
        optional: true,
        ...(d.default.length ? { default: d.default.join(',') } : {}),
        validate: (v) => {
          const items = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
          const bad = items.filter((s) => !d.item.test(s));
          if (bad.length) return `“${bad.slice(0, 5).join('”, “')}” not valid (${d.itemHint}).`;
          return items.length > d.maxItems ? `at most ${d.maxItems} entries.` : null;
        },
      };
  }
}

const DEFS: DefInput[] = [
  // ── Company ──
  { key: 'COMPANY_LEGAL_NAME', label: 'Legal company name', group: 'Company', type: 'string', sensitive: true, effect: 'new-documents', required: true,
    hint: 'Registered name exactly as at the KvK — printed as the seller on proformas, invoices and credit notes. Once set it can be changed, not emptied.' },
  { key: 'COMPANY_ADDRESS', label: 'Registered address', group: 'Company', type: 'text', multiline: true, sensitive: true, effect: 'new-documents', required: true,
    hint: 'Street + number on the first line, postcode + city on the next. Once set it can be changed, not emptied.' },
  { key: 'COMPANY_CITY', label: 'Issuing city', group: 'Company', type: 'string', effect: 'new-documents',
    hint: 'City shown on documents (e.g. Zoetermeer).' },
  { key: 'COMPANY_COUNTRY', label: 'Country', group: 'Company', type: 'string', effect: 'new-documents',
    hint: 'Country name printed under the address, e.g. Netherlands. (The VAT home country is set under Tax & VAT.)' },
  { key: 'COMPANY_KVK', label: 'KvK number (Chamber of Commerce)', group: 'Company', type: 'string', sensitive: true, effect: 'new-documents', required: true,
    hint: 'Trade-register number: exactly 8 digits while the VAT home country (Tax & VAT) is NL. Required on Dutch invoices; once set it can be changed, not emptied.',
    validate: (v, ctx) => companyRegisterNumberProblem(v, ctx?.value('TAX_HOME_COUNTRY') || 'NL') },
  { key: 'COMPANY_VAT', label: 'VAT ID (BTW-id)', group: 'Company', type: 'string', sensitive: true, effect: 'new-documents', required: true,
    hint: 'Your own VAT identification number, e.g. NL123456789B01. Required on every invoice; once set it can be changed, not emptied.', validate: companyVatIdProblem },
  { key: 'COMPANY_EORI', label: 'EORI number', group: 'Company', type: 'string', effect: 'new-documents', optional: true,
    hint: 'Customs number for exports outside the EU (usually NL + your VAT number digits). Printed on export documents.' },
  { key: 'COMPANY_PHONE', label: 'Phone', group: 'Company', type: 'string', effect: 'new-documents', hint: 'Business phone printed on documents.' },
  { key: 'COMPANY_EMAIL', label: 'Billing email', group: 'Company', type: 'email', verify: 'email', effect: 'new-documents',
    hint: 'Accounts contact printed on documents; also receives a copy of every invoice and proforma email.' },
  { key: 'COMPANY_WEBSITE', label: 'Website', group: 'Company', type: 'string', effect: 'new-documents', hint: 'e.g. labtodate.com.' },
  { key: 'COMPANY_LOGO_URL', label: 'Company logo URL', group: 'Company', type: 'image', verify: 'image', effect: 'new-documents',
    hint: 'Auto-filled when you upload a logo (Logo tab). Embedded in documents at issue time.' },

  // ── Tax & VAT ──
  { key: 'TAX_HOME_COUNTRY', label: 'VAT home country', group: 'Tax & VAT', type: 'country', default: 'NL', sensitive: true, effect: 'new-documents',
    hint: 'Where you are VAT-registered and ship from. Domestic sales here get the standard rate.' },
  { key: 'TAX_STANDARD_RATE_PCT', label: 'Standard VAT rate (%)', group: 'Tax & VAT', type: 'percent', default: '21', min: 0, max: 50, sensitive: true, effect: 'new-documents',
    hint: 'NL: 21. Applied to domestic sales (goods AND shipping) and to EU buyers without a valid VAT ID (unless OSS is on).' },
  { key: 'TAX_SHIPPING_FOLLOWS_MAIN_SUPPLY', label: 'Shipping follows the VAT of the goods', group: 'Tax & VAT', type: 'bool', default: 'true', options: yesNo, effect: 'new-documents',
    hint: 'Yes (correct in NL): shipping is taxed at the same rate as the goods it delivers — 21% domestic, 0% for intra-EU and export.' },
  { key: 'TAX_ICS_ZERO_RATE_ENABLED', label: 'Intra-EU B2B sales at 0% (ICS)', group: 'Tax & VAT', type: 'bool', default: 'true', options: yesNo, sensitive: true, effect: 'new-documents',
    hint: 'Goods shipped to a business in another EU country with a valid VAT ID are invoiced at 0% (intracommunautaire levering). Off = charge home VAT to everyone in the EU.' },
  { key: 'TAX_ICS_REQUIRE_VIES_VALID', label: 'Require a VIES-confirmed VAT ID for 0%', group: 'Tax & VAT', type: 'bool', default: 'true', options: yesNo, effect: 'new-documents',
    hint: 'Yes: the buyer’s VAT ID must be confirmed valid by the EU VIES service before 0% applies. No: a well-formed VAT ID is enough (not recommended — the tax office can reclaim the VAT).' },
  { key: 'TAX_VIES_ENABLED', label: 'Check VAT IDs live with VIES', group: 'Tax & VAT', type: 'bool', default: 'true', options: yesNo,
    hint: 'Query the EU VIES service for every new VAT ID (results are cached and kept as evidence).' },
  { key: 'TAX_VIES_DOWN_POLICY', label: 'When VIES is unavailable', group: 'Tax & VAT', type: 'enum', default: 'MANUAL_REVIEW', sensitive: true,
    options: [
      { value: 'MANUAL_REVIEW', label: 'Hold for manual VAT review (recommended)' },
      { value: 'CHARGE_HOME_VAT', label: 'Charge home VAT (21%) — refund later if the ID is confirmed' },
      { value: 'BLOCK', label: 'Block the sale until VIES answers' },
    ],
    hint: 'VIES is regularly down for single member states. This decides what happens to an intra-EU B2B sale meanwhile.' },
  { key: 'TAX_VIES_CACHE_HOURS', label: 'Re-use a VIES result for (hours)', group: 'Tax & VAT', type: 'int', default: '24', min: 1, max: 720,
    hint: 'A VAT ID confirmed within this window is not checked again.' },
  { key: 'TAX_MANUAL_VAT_CHECK_DAYS', label: 'A VAT ID checked by hand counts for (days)', group: 'Tax & VAT', type: 'int', default: '30', min: 1, max: 365,
    hint: 'When VIES is down for days, staff can record a VAT ID check by hand on the order (with the evidence). That check is used — also while live checks are off — for this many days.' },
  { key: 'TAX_EXPORT_ZERO_RATE_ENABLED', label: 'Exports outside the EU at 0%', group: 'Tax & VAT', type: 'bool', default: 'true', options: yesNo, sensitive: true, effect: 'new-documents',
    hint: 'Goods that leave the EU are invoiced at 0% (keep the export evidence: customs declaration / carrier proof).' },
  { key: 'TAX_EU_B2C_MODE', label: 'EU buyers without a VAT ID', group: 'Tax & VAT', type: 'enum', default: 'HOME_RATE', sensitive: true, effect: 'new-documents',
    options: [
      { value: 'HOME_RATE', label: 'Charge the home rate (below the €10,000 EU distance-sales threshold, no OSS)' },
      { value: 'OSS', label: 'Charge the buyer’s country rate via OSS (you are OSS-registered)' },
    ],
    hint: 'Consumers and businesses without a valid VAT ID in another EU country. Only choose OSS when you are registered for the One-Stop-Shop.' },
  { key: 'TAX_MARGIN_SCHEME_ENABLED', label: 'Margin scheme for second-hand goods', group: 'Tax & VAT', type: 'bool', default: 'false', options: yesNo, sensitive: true, effect: 'new-documents',
    hint: 'When on, products marked “Margin scheme (second-hand)” (product page → VAT scheme, with the purchase cost of the unit) are sold and invoiced without separate VAT (bijzondere regeling gebruikte goederen); the invoice prints the margin-scheme text below. Exports stay 0%. Ask your accountant before enabling.' },
  { key: 'TAX_LEGAL_TEXT_ICS', label: 'Invoice text — intra-EU 0%', group: 'Tax & VAT', type: 'text', multiline: true, effect: 'new-documents',
    default: 'Intra-Community supply of goods, VAT 0% (Art. 138 Directive 2006/112/EC). VAT reverse-charged — intracommunautaire levering, btw verlegd.',
    hint: 'Printed on every intra-EU B2B invoice with the buyer’s VAT ID.' },
  { key: 'TAX_LEGAL_TEXT_EXPORT', label: 'Invoice text — export 0%', group: 'Tax & VAT', type: 'text', multiline: true, effect: 'new-documents',
    default: 'Export of goods outside the EU, VAT 0% (Art. 146 Directive 2006/112/EC) — uitvoer, 0% btw.',
    hint: 'Printed on every invoice for goods shipped outside the EU.' },
  { key: 'TAX_LEGAL_TEXT_MARGIN', label: 'Invoice text — margin scheme', group: 'Tax & VAT', type: 'text', multiline: true, effect: 'new-documents',
    default: 'Margin scheme — second-hand goods (Art. 313 Directive 2006/112/EC; bijzondere regeling — gebruikte goederen). VAT is not shown separately and is not deductible.',
    hint: 'Printed on invoices under the margin scheme.' },
  { key: 'TAX_LEGAL_TEXT_OSS', label: 'Invoice text — OSS', group: 'Tax & VAT', type: 'text', multiline: true, effect: 'new-documents',
    default: 'VAT charged at the rate of the customer’s member state under the One-Stop-Shop (OSS) scheme.',
    hint: 'Printed on invoices where the destination-country rate applies.' },
  { key: 'PRICE_DISPLAY_MODE', label: 'Show prices', group: 'Tax & VAT', type: 'enum', default: 'EXCL',
    options: [
      { value: 'EXCL', label: 'Excluding VAT' },
      { value: 'INCL', label: 'Including VAT (home standard rate)' },
      { value: 'BOTH', label: 'Both (excl. VAT, with the incl. VAT amount below)' },
    ],
    hint: 'How prices are shown on product cards, the product page, search, the cart and checkout. “Including VAT” uses the home standard rate; the exact VAT for the buyer’s country and VAT ID is calculated at checkout before ordering. When consumers may buy (Sales channel), “Excluding VAT” is shown as “Both” — consumer prices must include VAT.' },
  { key: 'PRICE_LABEL_EXCL_VAT', label: 'Label after a price without VAT', group: 'Tax & VAT', type: 'string', default: 'excl. VAT',
    hint: 'e.g. “excl. VAT” or “excl. btw”.' },
  { key: 'PRICE_LABEL_INCL_VAT', label: 'Label after a price with VAT', group: 'Tax & VAT', type: 'string', default: 'incl. VAT',
    hint: 'e.g. “incl. VAT” or “incl. btw”.' },
  { key: 'PRICE_LABEL_MARGIN', label: 'Label after a margin-scheme price', group: 'Tax & VAT', type: 'string', default: 'margin scheme, no VAT shown',
    hint: 'Second-hand items under the margin scheme (only when the margin scheme is on): the price is final, VAT is not shown separately.' },
  { key: 'PRICE_VAT_NOTE', label: 'VAT note next to prices', group: 'Tax & VAT', type: 'string', optional: true,
    default: 'VAT is calculated at checkout from the delivery country and your VAT ID.',
    hint: 'Short line under the price on the product page and in the cart. Empty = no note.' },
  // Buyer-facing VAT explanations at checkout (staff see the rule reasons on the order).
  { key: 'VAT_TEXT_DOMESTIC', label: 'Checkout VAT text — domestic', group: 'Tax & VAT', type: 'text', multiline: true,
    default: 'Delivery in {COUNTRY}: {RATE} VAT on the goods and the shipping.', hint: vatTextHint },
  { key: 'VAT_TEXT_ICS', label: 'Checkout VAT text — intra-EU 0%', group: 'Tax & VAT', type: 'text', multiline: true,
    default: 'Intra-EU delivery to a business with a VIES-confirmed VAT ID: 0% VAT. You account for the VAT in your own country (reverse charge).', hint: vatTextHint },
  { key: 'VAT_TEXT_EU_HOME', label: 'Checkout VAT text — EU without VAT ID', group: 'Tax & VAT', type: 'text', multiline: true,
    default: 'Delivery within the EU without a confirmed VAT ID: {HOME_COUNTRY} VAT {RATE} is charged. Add a valid EU VAT ID of your company for 0%.', hint: vatTextHint },
  { key: 'VAT_TEXT_OSS', label: 'Checkout VAT text — OSS', group: 'Tax & VAT', type: 'text', multiline: true,
    default: 'Delivery to {COUNTRY} without a VAT ID: VAT of {COUNTRY}, {RATE} (One-Stop-Shop).', hint: vatTextHint },
  { key: 'VAT_TEXT_EXPORT', label: 'Checkout VAT text — export', group: 'Tax & VAT', type: 'text', multiline: true,
    default: 'Delivery outside the EU: export without VAT (0%). Import duties and import VAT in {COUNTRY} are not included.', hint: vatTextHint },
  { key: 'VAT_TEXT_MARGIN', label: 'Checkout VAT text — margin scheme', group: 'Tax & VAT', type: 'text', multiline: true,
    default: 'Second-hand goods under the margin scheme: VAT is included in the price and not shown separately.', hint: vatTextHint },
  { key: 'VAT_TEXT_REVIEW', label: 'Checkout VAT text — to be confirmed', group: 'Tax & VAT', type: 'text', multiline: true,
    default: 'The VAT of this order is confirmed by our team before any payment is requested.', hint: vatTextHint },
  // Checkout (s2a) and quote offers (s2b) both charge VAT by the rules above now;
  // the old interim flat rate is only read to describe orders priced BEFORE the
  // VAT rules on their documents (lib/documents/issue.ts → chargedVat, legacy path).
  { key: 'DEFAULT_TAX_PERCENT', label: 'Older orders: flat VAT % they were charged', group: 'Tax & VAT', type: 'percent', default: '0', min: 0, max: 50, sensitive: true,
    hint: 'Not used for pricing any more: checkout and quote offers both charge VAT by the rules above (country, VAT ID, VIES). Only read to print orders priced before the VAT rules (the old interim flat rate) correctly on their proforma / invoice — keep it at the rate those older orders were charged. Every invoice is checked against the rules at issue time: an order charged at a rate the rules do not allow is put on “VAT review” instead of being invoiced.' },

  // ── Invoicing & numbering ──
  { key: 'INVOICE_NUMBER_FORMAT', label: 'Number format', group: 'Invoicing & numbering', type: 'string', default: '{PREFIX}-{YYYY}-{SEQ:5}', sensitive: true, effect: 'new-documents',
    validate: numberFormatProblem,
    hint: 'Used by every series. {PREFIX}, {YYYY} (fiscal year), {YY}, {SEQ} or {SEQ:5} (zero-padded). Example: INV-2026-00001. Must contain {PREFIX} and {SEQ}; with a yearly restart also the year.' },
  { key: 'INVOICE_PREFIX', label: 'Invoice prefix', group: 'Invoicing & numbering', type: 'string', default: 'INV', sensitive: true, effect: 'new-documents', validate: prefixProblem,
    hint: 'Tax invoices: one gap-free sequence per fiscal year. Must differ from the credit note and proforma prefixes.' },
  { key: 'CREDIT_NOTE_PREFIX', label: 'Credit note prefix', group: 'Invoicing & numbering', type: 'string', default: 'CN', sensitive: true, effect: 'new-documents', validate: prefixProblem,
    hint: 'Credit notes have their own gap-free sequence.' },
  { key: 'PROFORMA_PREFIX', label: 'Proforma prefix', group: 'Invoicing & numbering', type: 'string', default: 'PF', effect: 'new-documents', validate: prefixProblem,
    hint: 'Proformas are payment requests, not tax invoices — they use their own sequence and never consume an invoice number.' },
  { key: 'NUMBERING_RESET_YEARLY', label: 'Restart numbering every fiscal year', group: 'Invoicing & numbering', type: 'bool', default: 'true', options: yesNo, sensitive: true, effect: 'new-documents',
    hint: 'Yes: INV-2026-00001, INV-2027-00001… No: one continuous sequence (the year in the number still shows the fiscal year). Locked once the first document is numbered — switching later would reuse numbers.' },
  { key: 'FISCAL_YEAR_START_MONTH', label: 'Fiscal year starts in month', group: 'Invoicing & numbering', type: 'int', default: '1', min: 1, max: 12, sensitive: true, effect: 'new-documents',
    hint: '1 = January (calendar year). Locked once the first document is numbered — a change of financial year is agreed with your accountant before go-live.' },
  { key: 'BUSINESS_TIMEZONE', label: 'Business time zone', group: 'Invoicing & numbering', type: 'string', default: 'Europe/Amsterdam', sensitive: true, effect: 'new-documents',
    validate: (v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return null; } catch { return 'not a time zone name — use e.g. Europe/Amsterdam.'; } },
    hint: 'The calendar day of a document date and of the fiscal year (an invoice at 00:30 on 1 January Amsterdam time belongs to the new year). Locked once the first document is numbered.' },
  { key: 'INVOICE_START_NUMBER', label: 'First invoice number of a new series', group: 'Invoicing & numbering', type: 'int', default: '1', min: 1, max: 999999, sensitive: true, effect: 'new-documents',
    hint: 'Only used when a series/year starts. Locked once the first invoice of the current fiscal year is issued.' },
  { key: 'CREDIT_NOTE_START_NUMBER', label: 'First credit note number of a new series', group: 'Invoicing & numbering', type: 'int', default: '1', min: 1, max: 999999, sensitive: true, effect: 'new-documents',
    hint: 'Locked once the first credit note of the current fiscal year is issued.' },
  { key: 'PROFORMA_START_NUMBER', label: 'First proforma number of a new series', group: 'Invoicing & numbering', type: 'int', default: '1', min: 1, max: 999999, effect: 'new-documents',
    hint: 'Locked once the first proforma of the current fiscal year is issued.' },
  { key: 'INVOICE_VAT_MISMATCH_POLICY', label: 'When an order’s VAT does not match the rules', group: 'Invoicing & numbering', type: 'enum', default: 'BLOCK', sensitive: true,
    options: [
      { value: 'BLOCK', label: 'Do not invoice — put the order on VAT review (recommended)' },
      { value: 'ISSUE_AS_CHARGED', label: 'Invoice what was charged (treatment marked for review)' },
    ],
    hint: 'Checked when the invoice is issued (payment verified). Example: an NL buyer charged 0% while the rules require 21%.' },
  { key: 'INVOICE_REQUIRED_FIELDS_POLICY', label: 'Missing legal invoice details', group: 'Invoicing & numbering', type: 'enum', default: 'BLOCK', sensitive: true,
    options: [
      { value: 'BLOCK', label: 'Do not invoice until complete (recommended)' },
      { value: 'WARN', label: 'Invoice anyway and warn' },
    ],
    hint: 'Seller name, address, KvK, VAT ID; buyer name and billing address; buyer VAT ID for intra-EU 0%.' },
  { key: 'SUPPLY_DATE_RULE', label: 'Date of supply on invoices', group: 'Invoicing & numbering', type: 'enum', default: 'SHIPPED_OR_ADVANCE_PAYMENT', effect: 'new-documents',
    options: [
      { value: 'SHIPPED_OR_ADVANCE_PAYMENT', label: 'Ship date when shipped; paid before shipping: the date of the advance payment instead (recommended)' },
      { value: 'SHIPPED_OR_ISSUE', label: 'Ship date when shipped, otherwise the invoice date (not recommended: prints a supply date for goods not shipped yet)' },
      { value: 'ISSUE_DATE', label: 'Always the invoice date (only when you invoice on the day you ship)' },
      { value: 'OMIT', label: 'Do not print (only when it equals the invoice date)' },
    ],
    hint: 'Dutch invoices (art. 35a Wet OB) state the date of supply, or the date of an advance payment, when it differs from the invoice date. An invoice issued when a payment is verified — before the goods ship — has no supply date yet: it states the date the payment was received.' },
  { key: 'CREDIT_NOTE_AUTO_ON_REFUND', label: 'Issue a credit note on every refund', group: 'Invoicing & numbering', type: 'bool', default: 'true', options: yesNo, sensitive: true,
    hint: 'Yes (required): a refund of an invoiced order issues a credit note referencing the original invoice. The invoice itself is never changed.' },

  // ── Payments & credit terms ──
  { key: 'STRIPE_SECRET_KEY', label: 'Stripe secret key', group: 'Payments & credit terms', type: 'secret', sensitive: true,
    hint: 'sk_live_… or sk_test_… — enables card checkout.' },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook secret', group: 'Payments & credit terms', type: 'secret', sensitive: true,
    hint: 'whsec_… from the Stripe webhook endpoint.' },
  { key: 'BANK_NAME', label: 'Bank name', group: 'Payments & credit terms', type: 'string', sensitive: true, effect: 'new-documents',
    hint: 'Payee bank shown on proformas, e.g. “ING Bank”.' },
  { key: 'BANK_IBAN', label: 'Bank IBAN', group: 'Payments & credit terms', type: 'string', sensitive: true, effect: 'new-documents', required: true,
    validate: (v) => (isValidIban(v) ? null : 'not a valid IBAN (checksum failed) — check for typos.'),
    hint: 'Printed on proformas and the payment page. Each proforma keeps the IBAN it was issued with. Once set it can be changed, not emptied.' },
  { key: 'BANK_SWIFT', label: 'Bank SWIFT / BIC', group: 'Payments & credit terms', type: 'string', sensitive: true, effect: 'new-documents',
    validate: (v) => (/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v.replace(/\s+/g, '').toUpperCase()) ? null : 'a BIC has 8 or 11 letters/digits, e.g. INGBNL2A.'),
    hint: 'e.g. INGBNL2A. For international transfers.' },
  { key: 'BANK_REFERENCE_HINT', label: 'Transfer reference hint', group: 'Payments & credit terms', type: 'string',
    hint: 'Tells the buyer what to put in the transfer reference.' },
  { key: 'PAYMENT_TERM_DAYS', label: 'Payment term (days)', group: 'Payments & credit terms', type: 'int', default: '14', min: 1, max: 120, effect: 'new-documents',
    hint: 'Days a buyer has to pay a proforma: from acceptance for a quote order (staff can change it per offer), from the order date for a checkout order. The due date is printed on the proforma and shown on the payment page; reminders and auto-cancel follow it.' },
  { key: 'PAYMENT_GRACE_DAYS', label: 'Grace before auto-cancel (days)', group: 'Payments & credit terms', type: 'int', default: '3', min: 0, max: 60,
    hint: 'An unpaid order is only canceled this many days after its due date (bank transfers take 1–3 days). The buyer can still upload a receipt during the grace period.' },
  { key: 'AUTO_CANCEL_UNPAID', label: 'Auto-cancel unpaid orders', group: 'Payments & credit terms', type: 'bool', default: 'true', options: yesNo,
    hint: 'Yes: an order still unpaid (no receipt) at due date + grace is canceled, its proforma voided, its stock released, and the buyer and staff are emailed. No: it stays open and staff are told it is overdue.' },
  { key: 'PAYMENT_REMINDER_DAYS_BEFORE', label: 'Payment reminders (days before the due date)', group: 'Payments & credit terms', type: 'list', default: '3', optional: true,
    validate: (v) => (v.split(',').map((x) => x.trim()).filter(Boolean).every((x) => /^\d+$/.test(x) && Number(x) >= 1 && Number(x) <= 60) ? null : 'whole numbers 1–60, comma-separated, e.g. 7,3,1.'),
    hint: 'One reminder email per value to the buyer of an unpaid order (sent once each). Empty = no reminders before the due date.' },
  { key: 'PAYMENT_OVERDUE_NOTICE', label: 'Email the buyer when a payment is overdue', group: 'Payments & credit terms', type: 'bool', default: 'true', options: yesNo,
    hint: 'One email once the due date has passed (with the auto-cancel date when auto-cancel is on). Staff are notified too.' },
  { key: 'REQUIRE_DETAILS_BEFORE_PAYMENT', label: 'Billing & delivery details before payment', group: 'Payments & credit terms', type: 'bool', default: 'true', options: yesNo,
    hint: 'Yes (recommended): a buyer cannot upload a payment receipt — and staff cannot verify or mark an order paid — until the billing details (legal name, address, VAT ID where relevant) and the full delivery address are on the order.' },
  { key: 'DETAILS_VAT_ID_REQUIRED', label: 'Buyer VAT ID in the billing details', group: 'Payments & credit terms', type: 'enum', default: 'EU',
    options: [
      { value: 'EU', label: 'Required for EU buyers (billing address in the EU)' },
      { value: 'ALWAYS', label: 'Always required' },
      { value: 'OFF', label: 'Optional' },
    ],
    hint: 'Part of “Billing & delivery details before payment”: whether the details count as complete without the buyer’s VAT ID. Outside the EU most buyers have no EU VAT ID, so “Required for EU buyers” is the usual choice; “Optional” lets EU buyers without one pay (they are charged VAT).' },
  { key: 'PAYMENT_VERIFY_TURNAROUND', label: 'Payment verification promise', group: 'Payments & credit terms', type: 'string', default: '1 business day',
    hint: 'Shown on the payment page (“we verify within …”). Only promise what the team really does.' },
  { key: 'BUYER_CANCEL_DISABLED_TEXT', label: 'Payment page — how to cancel when buyers cannot', group: 'Payments & credit terms', type: 'text', multiline: true, pending: 'the payment page update (PKG-04)',
    default: DEFAULT_BUYER_CANCEL_DISABLED_TEXT,
    hint: 'Shown on the payment page of an unpaid order, with a link to support, while buyers cannot cancel themselves (Quotes & offers → “Buyer can cancel an unpaid order” off).' },
  { key: 'CREDIT_TERMS_ENABLED', label: 'Allow invoice payment (NET terms)', group: 'Payments & credit terms', type: 'bool', default: 'false', options: yesNo,
    hint: 'Yes: buyers you approved for credit (with a credit limit — on the order page → Credit terms) can ask to pay on invoice. Staff then approve the order on terms: an UNPAID invoice with a due date is issued — never “paid” without money. Everyone else prepays.' },
  { key: 'CREDIT_DEFAULT_TERM_DAYS', label: 'Default NET term (days)', group: 'Payments & credit terms', type: 'int', default: '30', min: 1, max: 120, effect: 'new-documents',
    hint: 'Prefilled when approving a buyer for credit (each buyer keeps their own term); the invoice due date = invoice date + the buyer’s term.' },
  { key: 'CREDIT_DEFAULT_LIMIT_CENTS', label: 'Default credit limit', group: 'Payments & credit terms', type: 'money', default: '0', min: 0,
    hint: 'Prefilled when approving a buyer for credit. An order is only allowed on terms while the buyer’s unpaid on-terms invoices plus this order stay within their limit.' },
  { key: 'PAYMENT_METHODS_ENABLED', label: 'Payment methods at checkout', group: 'Payments & credit terms', type: 'list', default: 'BANK_TRANSFER,STRIPE_CARD',
    validate: (v) => {
      const items = v.split(',').map((x) => x.trim()).filter(Boolean);
      const bad = items.filter((x) => !(PAYMENT_METHOD_CODES as readonly string[]).includes(x));
      if (bad.length) return `unknown method ${bad.join(', ')} — use BANK_TRANSFER and/or STRIPE_CARD.`;
      return items.length ? null : 'enable at least one method.';
    },
    hint: 'BANK_TRANSFER (proforma + manual verification) and/or STRIPE_CARD (card via Stripe — only offered while the Stripe keys are set). With both, the buyer chooses at checkout.' },
  { key: 'PAYMENT_REQUIRE_AMOUNT_ON_VERIFY', label: 'Record the received amount on verify', group: 'Payments & credit terms', type: 'bool', default: 'true', options: yesNo,
    hint: 'Yes: staff enter the amount and the value date from the bank statement (and the bank reference) when verifying or marking a payment; the invoice prints that date, and a short payment is never booked as paid in full. No: the order total and today are recorded.' },
  { key: 'UNDERPAYMENT_TOLERANCE_CENTS', label: 'Accept underpayment up to', group: 'Payments & credit terms', type: 'money', default: '0', min: 0,
    hint: 'Bank fees: a payment short by at most this amount still counts as paid in full (the difference is noted on the order). A bigger shortfall is booked as a part payment and the buyer is asked for the rest.' },

  // ── Shipping ──
  { key: 'DEFAULT_SHIPPING_CENTS', label: 'Flat shipping amount', group: 'Shipping', type: 'money', default: '0', min: 0,
    hint: 'Charged per order when the shipping cost method is “One flat amount” (0 = free shipping everywhere). Checkout only — quote offers prefill their freight from Quotes & offers → “Freight prefilled in a new offer”.' },
  { key: 'SHIPPING_MODE', label: 'Shipping cost method', group: 'Shipping', type: 'enum', default: 'ZONE_TABLE',
    options: [
      { value: 'ZONE_TABLE', label: 'Zones & rates table (below)' },
      { value: 'FLAT', label: 'One flat amount' },
    ],
    hint: 'How shipping is priced at checkout.' },
  { key: 'SHIPPING_UNMATCHED_POLICY', label: 'No matching rate', group: 'Shipping', type: 'enum', default: 'TO_BE_CONFIRMED',
    options: [
      { value: 'TO_BE_CONFIRMED', label: 'Accept the order, shipping “to be confirmed” (no payment request until set)' },
      { value: 'NOT_SHIPPABLE', label: 'Refuse — ask the buyer to request a quote' },
    ],
    hint: 'What happens when no zone/rate covers the destination or the product’s shipping class.' },
  { key: 'SHIPPING_DEFAULT_CLASS', label: 'Default shipping class', group: 'Shipping', type: 'enum', default: 'FREIGHT_QUOTE',
    options: [
      { value: 'PARCEL', label: 'Parcel' },
      { value: 'PALLET', label: 'Pallet' },
      { value: 'FREIGHT_QUOTE', label: 'Freight — quote per order' },
    ],
    hint: 'For products without their own shipping class (e.g. imported items).' },
  { key: 'SHIPPING_HANDLING_FEE_CENTS', label: 'Handling fee per order', group: 'Shipping', type: 'money', default: '0', min: 0,
    hint: 'Added once per shipment on top of the rate.' },
  { key: 'SHIPPING_FREE_ABOVE_CENTS', label: 'Free shipping above (order goods value)', group: 'Shipping', type: 'money', optional: true, min: 0,
    hint: 'Leave empty for never.' },
  { key: 'POST_PAYMENT_ADDRESS_CHANGE', label: 'Address change after payment', group: 'Shipping', type: 'enum', default: 'WITH_REVIEW',
    options: [
      { value: 'WITH_REVIEW', label: 'Allowed, order held for review (VAT + compliance re-checked)' },
      { value: 'SAME_COUNTRY', label: 'Only within the same country' },
      { value: 'NEVER', label: 'Never — contact support' },
    ],
    hint: 'Buyer changes of the delivery address on a paid order. A new destination can change the VAT treatment and the export checks; every change is kept old → new on the order. Staff changes are always allowed and re-checked.' },

  // ── Compliance & countries ──
  { key: 'COMPLIANCE_UNKNOWN_COUNTRY_POLICY', label: 'Countries not in the table', group: 'Compliance & countries', type: 'enum', default: 'REVIEW', sensitive: true,
    options: [
      { value: 'REVIEW', label: 'Review each order' },
      { value: 'BLOCK', label: 'Do not sell / ship' },
    ],
    hint: 'Policy for a destination that has no row in the country table below.' },
  { key: 'NO_RUSSIA_CLAUSE_ENABLED', label: 'Print the “No Russia” clause on export documents', group: 'Compliance & countries', type: 'bool', default: 'true', options: yesNo, effect: 'new-documents',
    hint: 'EU Reg. 833/2014 art. 12g: contracts for exports to non-partner countries must prohibit re-export to Russia.' },
  { key: 'NO_RUSSIA_CLAUSE_TEXT', label: '“No Russia” clause', group: 'Compliance & countries', type: 'text', multiline: true, effect: 'new-documents',
    default: 'The buyer shall not sell, export or re-export, directly or indirectly, to the Russian Federation or for use in the Russian Federation any goods supplied under this contract (Art. 12g Council Regulation (EU) No 833/2014).',
    hint: 'Printed on proformas and invoices for destinations outside the EU and outside the partner list below.' },
  { key: 'NO_RUSSIA_CLAUSE_EXEMPT_COUNTRIES', label: 'Partner countries (no clause needed)', group: 'Compliance & countries', type: 'list', default: 'US,JP,GB,KR,AU,CA,NZ,NO,CH,IS,LI', effect: 'new-documents',
    validate: (v) => (v.split(',').map((s) => s.trim()).filter(Boolean).every((c) => /^[A-Z]{2}$/.test(c)) ? null : 'comma-separated 2-letter country codes, e.g. US,JP,GB.'),
    hint: 'Annex VIII partner countries.' },

  // ── Stock & reservation ──
  { key: 'AUTO_RESTOCK_ON_REFUND', label: 'Put stock back when a paid order is canceled', group: 'Stock & reservation', type: 'enum', default: 'ONLY_IF_NOT_SHIPPED',
    options: [
      { value: 'ONLY_IF_NOT_SHIPPED', label: 'Yes — the unit never left our warehouse (recommended)' },
      { value: 'NEVER', label: 'No — staff put it back by hand after checking it' },
    ],
    hint: 'Only for an order canceled — or credited / refunded in full — BEFORE anything shipped (the refund / credit form preselects it; at most once per order). A shipped unit is still at the customer’s lab: it comes back to stock only when a return is received and inspected with the grade “resell” — never through a refund. (The earlier option “Always” was removed.)' },
  { key: 'STOCK_RESERVE_ON', label: 'Reserve the unit for a quote when', group: 'Stock & reservation', type: 'enum', default: 'OFFER_ACCEPTED',
    options: [
      { value: 'OFFER_SENT', label: 'The offer is sent' },
      { value: 'OFFER_ACCEPTED', label: 'The buyer accepts the offer (recommended)' },
      { value: 'PAYMENT_VERIFIED', label: 'The payment is verified' },
    ],
    hint: 'A reserved unit leaves the available stock: nobody else can buy it with Buy Now or accept another offer on it. An order’s hold ends when it is paid (sold) or canceled (released).' },
  { key: 'RESERVATION_HOLD_DAYS', label: 'Hold the unit for an open offer for (days)', group: 'Stock & reservation', type: 'int', optional: true, min: 1, max: 120,
    hint: 'Only with “The offer is sent”: how long the unit stays reserved for an offer nobody accepted yet. Empty = until the offer expires. Once accepted, the unit stays reserved until the order is paid or canceled.' },
  { key: 'SHOW_RESERVED_BADGE', label: 'Show “Reserved” on reserved items', group: 'Stock & reservation', type: 'bool', default: 'true', options: yesNo,
    hint: 'Yes: while a unit is held for another buyer’s accepted offer / unpaid order, the product page says “Reserved” (it may come back) instead of “Sold”.' },

  // ── Sales channel ──
  { key: 'SALES_MODE', label: 'Who can buy', group: 'Sales channel', type: 'enum', default: 'B2B_ONLY', sensitive: true,
    options: [
      { value: 'B2B_ONLY', label: 'Businesses and institutions only' },
      { value: 'B2B_AND_B2C', label: 'Businesses and consumers (14-day withdrawal right, prices incl. VAT)' },
    ],
    hint: 'Applied at checkout: “Businesses only” asks every buyer for the B2B declaration and company details; with consumers, checkout asks “business or private” and shows consumer prices incl. VAT. Selling to consumers brings consumer-law duties (withdrawal right, consumer terms).' },
  { key: 'B2B_DECLARATION_TEXT', label: 'B2B declaration at checkout', group: 'Sales channel', type: 'string', default: 'I buy on behalf of a business or institution.',
    hint: 'Business buyers tick this before ordering; the time is stored on the order.' },
  { key: 'B2B_REQUIRE_COMPANY_AND_ID', label: 'Require company name + KvK or VAT ID', group: 'Sales channel', type: 'bool', default: 'true', options: yesNo,
    hint: 'Business buyers must give their registered company name and a KvK / registration number or a VAT ID at checkout.' },
  { key: 'CONSUMER_ORDER_BUTTON_TEXT', label: 'Order button for consumers', group: 'Sales channel', type: 'string', default: 'Order with obligation to pay',
    hint: 'EU consumer law requires the final button to say the order must be paid (only used when consumers may buy).' },
  { key: 'CONSUMER_WITHDRAWAL_TEXT', label: 'Withdrawal right (consumers)', group: 'Sales channel', type: 'text', multiline: true, pending: 'the consumer checkout and order e-mail update (PKG-19, PKG-05)',
    default: DEFAULT_CONSUMER_WITHDRAWAL_TEXT,
    hint: 'EU consumer law: private buyers are told about their 14-day withdrawal right before they order and in the order confirmation. Shown next to the consumer order button and in the order e-mail (only when consumers may buy). Say who pays the return shipping.' },

  // ── Checkout & customers ──
  { key: 'CHECKOUT_PO_NUMBER', label: 'Purchase-order (PO) number', group: 'Checkout & customers', type: 'enum', default: 'OPTIONAL',
    options: [
      { value: 'HIDDEN', label: 'Do not ask' },
      { value: 'OPTIONAL', label: 'Ask, optional' },
      { value: 'REQUIRED', label: 'Required from every business buyer' },
    ],
    hint: 'Stored on the order and shown to staff and the buyer. A buyer whose saved billing profile says “PO required” must always give one.' },
  { key: 'CHECKOUT_ASK_INVOICE_EMAIL', label: 'Ask for an invoice email address', group: 'Checkout & customers', type: 'bool', default: 'true', options: yesNo,
    hint: 'Accounts-payable address that receives the invoice. Empty at checkout = the account email.' },
  { key: 'INVOICE_EMAIL_CC_ACCOUNT', label: 'Also send invoices to the account email', group: 'Checkout & customers', type: 'bool', default: 'true', options: yesNo,
    hint: 'When the buyer gave a separate invoice email, the person who ordered gets a copy too.' },
  { key: 'CHECKOUT_REQUIRE_PHONE', label: 'Phone number required', group: 'Checkout & customers', type: 'bool', default: 'true', options: yesNo,
    hint: 'Carriers usually need a phone number for freight deliveries.' },
  { key: 'CHECKOUT_TERMS_NOTE', label: 'Note above the order button', group: 'Checkout & customers', type: 'text', multiline: true, optional: true,
    default: 'By placing this order you accept our [terms and conditions](/legal/terms).',
    hint: 'Shown above the order button. [link text](/site/path) becomes a link, e.g. [terms and conditions](/legal/terms).' },
  { key: 'CHECKOUT_SUBMIT_TEXT_BANK', label: 'Order button — bank transfer', group: 'Checkout & customers', type: 'string', default: 'Place order — pay by bank transfer',
    hint: 'Business buyers, bank transfer chosen.' },
  { key: 'CHECKOUT_SUBMIT_TEXT_CARD', label: 'Order button — card', group: 'Checkout & customers', type: 'string', default: 'Place order and pay by card',
    hint: 'Business buyers, card chosen (continues to Stripe).' },
  { key: 'CHECKOUT_SUBMIT_TEXT_HOLD', label: 'Order button — total to be confirmed', group: 'Checkout & customers', type: 'string', default: 'Place order — we confirm the final total first',
    hint: 'When shipping, VAT or the destination needs our team before payment (nothing is charged at this step).' },
  { key: 'CHECKOUT_MSG_SHIPPING_PENDING', label: 'Message — shipping to be confirmed', group: 'Checkout & customers', type: 'text', multiline: true,
    default: 'Shipping to {COUNTRY} is quoted by our team for this order. We email you the final total before any payment is requested — nothing is due yet.',
    hint: holdTextHint('no shipping rate covers the order (Shipping → zones & rates)') },
  { key: 'CHECKOUT_MSG_COMPLIANCE_REVIEW', label: 'Message — export compliance review', group: 'Checkout & customers', type: 'text', multiline: true,
    default: 'Orders to {COUNTRY} are reviewed by our team (export compliance) before payment is requested. Nothing is due yet — we email you when the order is cleared.',
    hint: holdTextHint('the destination is set to “Review” in the country table') },
  { key: 'CHECKOUT_MSG_VAT_REVIEW', label: 'Message — VAT to be confirmed', group: 'Checkout & customers', type: 'text', multiline: true,
    default: 'We could not confirm the VAT for this order automatically ({REASON}). Our team checks it and emails you the final total before any payment is requested.',
    hint: holdTextHint('the VAT rules need a person (e.g. VIES unavailable)') },
  { key: 'CHECKOUT_MSG_ADDRESS_REVIEW', label: 'Message — address change under review', group: 'Checkout & customers', type: 'text', multiline: true,
    default: 'You changed the delivery address. Our team re-checks VAT, shipping and export rules for the new destination before the order continues.',
    hint: 'Shown when a buyer changes the delivery country of an order (Shipping → Address change after payment).' },
  { key: 'CHECKOUT_PREVIEW_RATE_LIMIT', label: 'Checkout price checks per visitor (per 10 min)', group: 'Checkout & customers', type: 'int', default: '120', min: 10, max: 2000,
    hint: 'Each change of country / VAT ID recalculates the total (and may ask VIES). Protects VIES and the server from abuse.' },
  { key: 'CHECKOUT_SUBMIT_RATE_LIMIT', label: 'Order attempts per visitor (per 10 min)', group: 'Checkout & customers', type: 'int', default: '20', min: 3, max: 500,
    hint: 'Limits order submissions from one address.' },

  // ── Documents & legal texts ──
  { key: 'DOC_RETENTION_YEARS', label: 'Keep financial records for (years)', group: 'Documents & legal texts', type: 'int', default: '7', min: 7, max: 30, sensitive: true,
    hint: 'Dutch fiscal retention is 7 years (10 for real estate). Paid, invoiced or refunded orders and every issued document can never be deleted; this value cannot go below 7.' },
  { key: 'PROFORMA_TERMS_TEXT', label: 'Proforma terms', group: 'Documents & legal texts', type: 'text', multiline: true, effect: 'new-documents',
    default: 'Payment in full by bank transfer before dispatch. Please quote the proforma number as payment reference.\nThis proforma invoice is not a tax invoice. The invoice is issued once your payment has been received and verified.',
    hint: 'One term per line, printed on every proforma.' },
  { key: 'INVOICE_TERMS_TEXT', label: 'Extra invoice terms', group: 'Documents & legal texts', type: 'text', multiline: true, optional: true, effect: 'new-documents',
    hint: 'Optional lines printed on every invoice (e.g. retention of title). One per line.' },
  { key: 'CREDIT_NOTE_TEXT', label: 'Credit note text', group: 'Documents & legal texts', type: 'text', multiline: true, effect: 'new-documents',
    default: 'This credit note corrects invoice {ORIGINAL_NUMBER} of {ORIGINAL_DATE}.',
    hint: 'First line of every credit note. {ORIGINAL_NUMBER} / {ORIGINAL_DATE} = the corrected invoice. What happens to the money is the next line (one of the texts below), chosen by what was really paid and refunded — a credit note never says the money “is refunded” before it was sent.' },
  { key: 'CREDIT_NOTE_TEXT_REFUND', label: 'Credit note — money to be refunded (not sent yet)', group: 'Documents & legal texts', type: 'text', multiline: true, effect: 'new-documents',
    default: 'The credited amount of {AMOUNT} will be refunded to you by {METHOD}; you receive a separate confirmation with the date and reference once it has been sent.',
    hint: 'The buyer had paid; the refund is approved but not sent yet (bank transfer). {AMOUNT} = amount refunded, {METHOD} = “bank transfer” (or “another method agreed with you”).' },
  { key: 'CREDIT_NOTE_TEXT_REFUND_CARD', label: 'Credit note — refunded to the card', group: 'Documents & legal texts', type: 'text', multiline: true, effect: 'new-documents',
    default: 'The credited amount of {AMOUNT} is refunded to the card you paid with; it may take a few business days to appear.',
    hint: 'Card payments: the refund is issued through Stripe when the credit note is made.' },
  { key: 'CREDIT_NOTE_TEXT_REFUNDED', label: 'Credit note — already refunded earlier', group: 'Documents & legal texts', type: 'text', multiline: true, effect: 'new-documents',
    default: 'The credited amount of {AMOUNT} was refunded to you.',
    hint: 'The missing credit note of a refund that was made before (e.g. an older order refunded without one).' },
  { key: 'CREDIT_NOTE_TEXT_REPLACED', label: 'Credit note — invoice replaced by a corrected one', group: 'Documents & legal texts', type: 'text', multiline: true, effect: 'new-documents',
    default: 'Invoice {ORIGINAL_NUMBER} is replaced by a corrected invoice issued today. This credit note moves no money: nothing is refunded and nothing extra is due because of it.',
    hint: 'Correcting a wrong invoice (e.g. VAT or billing details): credit note for the whole invoice + a corrected invoice.' },
  { key: 'CREDIT_NOTE_TEXT_NOT_PAID', label: 'Credit note — unpaid amount canceled (nothing refunded)', group: 'Documents & legal texts', type: 'text', multiline: true, effect: 'new-documents',
    default: 'The credited amount of {AMOUNT} on invoice {ORIGINAL_NUMBER} had not been paid: it is no longer due and no money is refunded.',
    hint: 'An invoice on payment terms that is canceled or reduced before the buyer paid it: the receivable is canceled, no money moves. (Replaces “Credit note text — invoice not paid”, CREDIT_NOTE_TEXT_UNPAID.)' },
  { key: 'CREDIT_NOTE_TEXT_PART_REFUND', label: 'Credit note — partly refunded, rest no longer due', group: 'Documents & legal texts', type: 'text', multiline: true, effect: 'new-documents',
    default: '{REFUND} of the credited amount will be refunded to you by {METHOD}; the remaining {CANCELLED} had not been paid and is no longer due.',
    hint: 'An invoice on payment terms that was partly paid and is then credited: the unpaid part is canceled first ({CANCELLED}), the rest goes back as money ({REFUND}).' },
  { key: 'DOC_FOOTER_TEXT', label: 'Extra footer line', group: 'Documents & legal texts', type: 'string', optional: true, effect: 'new-documents',
    hint: 'Optional line under the legal footer of every document.' },
  { key: 'DOC_LANGUAGE', label: 'Document language', group: 'Documents & legal texts', type: 'enum', default: 'en', effect: 'new-documents',
    options: [
      { value: 'en', label: 'English (dates “3 October 2026”, €1,210.00)' },
      { value: 'nl', label: 'Nederlands (data “3 oktober 2026”, € 1.210,00)' },
    ],
    hint: 'Language of the fixed texts, dates, amounts and country names on proformas, invoices and credit notes. Every text below can be changed one by one; an empty field uses this language’s default.' },
  ...DOC_LABEL_KEYS.map((k): DefInput => ({
    key: docLabelSettingKey(k),
    label: `Text — ${DOC_LABEL_DEFS[k].label}`,
    group: 'Documents & legal texts',
    type: 'string',
    optional: true,
    effect: 'new-documents',
    hint: `Empty = the language default — English: “${DOC_LABEL_DEFS[k].en}”, Dutch: “${DOC_LABEL_DEFS[k].nl}”.`,
  })),

  // ── Email texts (order / payment / refund e-mails) ──
  { key: 'EMAIL_INVOICE_PAID_HEADING', label: 'Invoice e-mail (paid) — heading', group: 'Email texts', type: 'string', default: 'Payment received — thank you', hint: 'E-mail with the invoice of a paid order.' },
  { key: 'EMAIL_INVOICE_PAID_BODY', label: 'Invoice e-mail (paid) — text', group: 'Email texts', type: 'text', multiline: true,
    default: 'We received your payment of {AMOUNT} for order {ORDER}.', hint: '{AMOUNT} {ORDER} {NUMBER} (invoice number).' },
  { key: 'EMAIL_INVOICE_DUE_BODY', label: 'Invoice e-mail (on payment terms) — text', group: 'Email texts', type: 'text', multiline: true,
    default: 'Here is the invoice for order {ORDER} ({AMOUNT}). Payment is due by {DUE}; please quote {NUMBER} as the transfer reference. No payment has been received yet.',
    hint: '{AMOUNT} {ORDER} {NUMBER} {DUE}.' },
  { key: 'EMAIL_INVOICE_PARTLY_PAID_BODY', label: 'Invoice e-mail (partly paid) — text', group: 'Email texts', type: 'text', multiline: true,
    default: 'Here is the invoice for order {ORDER} ({AMOUNT}). We received {PAID}; {OPEN} is still due by {DUE} — please quote {NUMBER} as the transfer reference.',
    hint: 'E.g. after a VAT correction raised the total of a paid order. {AMOUNT} {ORDER} {NUMBER} {PAID} {OPEN} {DUE}.' },
  { key: 'EMAIL_INVOICE_FOOTER', label: 'Invoice e-mail — closing line', group: 'Email texts', type: 'string', optional: true, default: 'We will let you know as soon as your order ships.', hint: 'Small print under the links. Empty = none.' },
  { key: 'EMAIL_PAYMENT_VERIFIED_BODY', label: 'Payment verified — text', group: 'Email texts', type: 'text', multiline: true,
    default: 'We verified your payment of {AMOUNT} for order {ORDER} (received {DATE}). We will prepare your order for shipping.',
    hint: 'Sent only when the invoice could not go out in the same e-mail. {AMOUNT} {ORDER} {DATE} (value date).' },
  { key: 'EMAIL_INVOICE_DELAYED_TEXT', label: 'Payment verified — invoice not issued yet', group: 'Email texts', type: 'text', multiline: true,
    default: 'Your invoice is not issued yet: our team first completes the VAT and billing details of this order. You receive it by e-mail as soon as it is issued; we contact you if we need anything from you.',
    hint: 'Told to the buyer (e-mail and order page) while a paid order waits for a VAT decision or missing invoice details.' },
  { key: 'EMAIL_PART_PAYMENT_BODY', label: 'Part payment received — text', group: 'Email texts', type: 'text', multiline: true,
    default: 'We received {PAID} for order {ORDER} on {DATE}. The order total is {TOTAL}, so {OPEN} is still due. Please transfer the remaining amount quoting {REFERENCE}.',
    hint: 'A payment that is short by more than the tolerance. {PAID} {ORDER} {DATE} {TOTAL} {OPEN} {REFERENCE}.' },
  // One set of refund e-mail texts for every refund (refund / credit form, cancel & refund, returns,
  // VAT corrections). Replaces the fulfilment keys REFUND_EMAIL_REQUESTED_TEXT / _CARD_TEXT / _SENT_TEXT
  // (values carried over by migration 8i_integration_settings).
  { key: 'EMAIL_REFUND_BANK_BODY', label: 'Refund approved (bank transfer) — text', group: 'Email texts', type: 'text', multiline: true,
    default: 'We approved a refund of {AMOUNT} for order {ORDER}. The bank transfer has not been sent yet — we e-mail you again with the date and bank reference as soon as it is sent.',
    hint: 'Sent when a bank-transfer refund is recorded. It must not say the money was sent: that is the next e-mail. {AMOUNT} {ORDER} {REASON}.' },
  { key: 'EMAIL_REFUND_CARD_BODY', label: 'Refund issued (card) — text', group: 'Email texts', type: 'text', multiline: true,
    default: 'We refunded {AMOUNT} for order {ORDER} to the card you paid with on {DATE}. It usually appears within 5–10 business days, depending on your card issuer.',
    hint: 'Sent when the refund is issued to the card through Stripe. {AMOUNT} {ORDER} {DATE} {REASON}.' },
  { key: 'EMAIL_REFUND_SENT_BODY', label: 'Refund sent (bank transfer) — text', group: 'Email texts', type: 'text', multiline: true,
    default: 'We sent the refund of {AMOUNT} for order {ORDER} on {DATE} (bank reference {REFERENCE}). Depending on your bank it can take 1–3 business days to arrive.',
    hint: 'When staff record the transfer as sent (date + bank reference). {AMOUNT} {ORDER} {DATE} {REFERENCE}.' },
  { key: 'EMAIL_CREDIT_NOT_PAID_BODY', label: 'Invoice credited, unpaid amount canceled — text', group: 'Email texts', type: 'text', multiline: true,
    default: 'Invoice {INVOICE} for order {ORDER} is credited by credit note {CREDIT_NOTE} ({AMOUNT}). This amount had not been paid, so nothing is refunded — you no longer owe it.',
    hint: 'A credit that only cancels an unpaid amount (e.g. an order on payment terms canceled before payment). {INVOICE} {ORDER} {CREDIT_NOTE} {AMOUNT}.' },

  // ── Email (unchanged keys) ──
  { key: 'RESEND_API_KEY', label: 'Resend API key', group: 'Email', type: 'secret',
    hint: 'From resend.com → API Keys. If set, this HTTP path is used and the SMTP fields below are ignored. Leave blank to send via your own SMTP server instead.' },
  { key: 'EMAIL_FROM', label: 'From address', group: 'Email', type: 'email', verify: 'email',
    hint: 'e.g. notifications@yourdomain.com. For Resend it must be a verified domain; for SMTP, an address your mail server is allowed to send as.' },
  { key: 'SMTP_HOST', label: 'SMTP host', group: 'Email', type: 'string',
    hint: 'Your mail server, e.g. smtp.gmail.com, smtp.office365.com, mail.yourdomain.com. Used only when the Resend key above is empty.' },
  { key: 'SMTP_PORT', label: 'SMTP port', group: 'Email', type: 'int', verify: 'number', min: 1, max: 65535,
    hint: '465 for SSL/TLS, 587 for STARTTLS, 25 for plain. Default 465.' },
  { key: 'SMTP_USER', label: 'SMTP username', group: 'Email', type: 'string',
    hint: 'Login for your mail server — usually the full mailbox address.' },
  { key: 'SMTP_PASS', label: 'SMTP password', group: 'Email', type: 'secret',
    hint: 'Mailbox password, or an app-specific password (Gmail / Outlook require one — normal passwords are rejected).' },
  { key: 'SMTP_SECURE', label: 'SMTP encryption', group: 'Email', type: 'string',
    validate: (v) => (/^(true|false|1|0)$/i.test(v) ? null : 'use true or false (or leave blank to auto-detect from the port).'),
    hint: 'true = implicit SSL/TLS (port 465). false = STARTTLS or none (587 / 25). Leave blank to auto-detect from the port.' },
  { key: 'SMTP_NO_AUTH', label: 'SMTP server needs no login', group: 'Email', type: 'bool', default: 'false', options: yesNo,
    hint: 'true only for a relay that accepts mail without a username/password (e.g. a mail server on your own network). Without a Resend key, an SMTP login or this switch, production sends NO email and the admin shows a red warning.' },
  { key: 'MAIL_BOUNCE_IMAP_PASS', label: 'Bounce mailbox (IMAP) password', group: 'Email', type: 'secret',
    hint: 'Password the bounce reader uses to log in to the sending mailbox over IMAP (switched on and set up in Settings → Security → “Read bounce reports from the sending mailbox”). Empty = the SMTP password above, which is right when both are the same mailbox (TransIP).' },
  { key: 'SELL_INTAKE_EMAIL', label: 'Sell submissions go to', group: 'Email', type: 'email', verify: 'email',
    hint: 'Inbox that receives “sell your equipment” submissions.' },
  { key: 'QUOTE_INTAKE_EMAIL', label: 'Quote requests go to', group: 'Email', type: 'email', verify: 'email',
    hint: 'Inbox for “Let us find it” / unassigned quote requests.' },
  { key: 'SUPPORT_INTAKE_EMAIL', label: 'Support tickets go to', group: 'Email', type: 'email', verify: 'email',
    hint: 'Inbox that receives new support tickets / contact messages.' },
  { key: 'TRANSACTIONAL_REPLY_TO', label: 'Replies to customer e-mails go to', group: 'Email', type: 'email', verify: 'email', optional: true, pending: 'the branded e-mail update (PKG-07)',
    hint: 'Reply-To of every order, quote and account e-mail, so a customer who presses Reply reaches a person. Set: those e-mails invite a reply. Empty: the Reply-To is the public support e-mail (Brand) and the e-mails point to the support page instead of asking for a reply.' },
  { key: 'PAYMENTS_INBOX_EMAIL', label: 'Payment receipts are announced to', group: 'Email', type: 'email', verify: 'email', optional: true, pending: 'the payment-receipt staff e-mail (PKG-04)',
    hint: 'Staff inbox told about every payment receipt a buyer uploads (with the amount still due and a link to the order), next to the in-app notice. Empty = the billing e-mail (Company).' },

  // ── Security (security team: src/lib/security/policy-defs.ts) ──
  // Edited on the Security tab (and /admin/settings/security): needs
  // security:manage plus a fresh authenticator code; audited old → new,
  // e-mailed to super-admins and recorded in Change history.
  ...POLICY_DEFS.map(securityPolicySetting),

  // ── Brand ──
  { key: 'SITE_NAME', label: 'Site / brand name', group: 'Brand', type: 'string', preview: '/',
    hint: 'Your brand as customers read it: the sender name of every e-mail, browser-tab titles and link previews, the footer, the legal pages and the account name in authenticator apps. Empty = “Labtodate”. The registered company name is set under Company.' },
  { key: 'SUPPORT_EMAIL', label: 'Public support email', group: 'Brand', type: 'email', verify: 'email',
    hint: 'Shown in the footer “contact us” link.' },

  // ── Site texts & pages (public pages, legal texts, sharing) ──
  { key: 'ABOUT_PAGE_TEXT', label: 'About page', group: 'Site texts & pages', type: 'text', multiline: true, default: DEFAULT_ABOUT_PAGE_TEXT, pending: 'the editable About page (PKG-15)',
    hint: 'The /about page. “## ” starts a heading, an empty line a new paragraph, [text](/path) is a link.' + tokensHint(ABOUT_PAGE_TOKENS) },
  { key: 'FAQ_TEXT', label: 'FAQ page', group: 'Site texts & pages', type: 'text', multiline: true, default: DEFAULT_FAQ_TEXT, pending: 'the editable FAQ page (PKG-15)',
    hint: 'The /faq page: each “## ” line is a question, the paragraphs under it the answer; [text](/path) is a link.' + tokensHint(FAQ_TOKENS) },
  { key: 'PRIVACY_POLICY_TEXT', label: 'Privacy policy', group: 'Site texts & pages', type: 'text', multiline: true, default: DEFAULT_PRIVACY_POLICY_TEXT, preview: '/legal/privacy',
    hint: 'The /legal/privacy page. Name every provider that processes customer data for you (e-mail, hosting and storage, VAT checks, payments, carriers) and keep it true when you add one. {MARKETING_BASIS} says who gets offer e-mails and why, following Security → “E-mail offers to existing customers … (soft opt-in)”; {CARD_PAYMENTS} names the card payment provider while card payment is offered (Payments & credit terms), else it is left out; {TEAM_NOTIFICATIONS} names the chat services (Slack, Discord, Telegram) that active Webhooks post staff notices with customer names to, else it is left out. “## ” starts a heading, an empty line a new paragraph, [text](/path) is a link.' + tokensHint(PRIVACY_POLICY_TOKENS) },
  { key: 'COOKIE_POLICY_TEXT', label: 'Cookie policy', group: 'Site texts & pages', type: 'text', multiline: true, default: DEFAULT_COOKIE_POLICY_TEXT, preview: '/legal/cookies',
    hint: 'The /legal/cookies page. List every cookie the site sets; analytics or marketing cookies would also need a consent banner. {CARD_PAYMENT_COOKIES} mentions the cookies of the card payment page while card payment is offered. “## ” starts a heading, an empty line a new paragraph, [text](/path) is a link.' + tokensHint(COOKIE_POLICY_TOKENS) },
  { key: 'SOCIAL_LINKS', label: 'Company profiles on other sites', group: 'Site texts & pages', type: 'list', optional: true, validate: httpsLinksProblem, pending: 'the homepage company data for search engines (PKG-13)',
    hint: 'Full https:// links of your own company pages (LinkedIn, YouTube, X …), comma-separated. Search engines are told these profiles belong to your company. Empty = none.' },
  { key: 'OG_DEFAULT_IMAGE_URL', label: 'Link-preview image', group: 'Site texts & pages', type: 'image', verify: 'image', optional: true, pending: 'the link-preview update (PKG-14)',
    hint: 'Picture shown when a page without its own image is shared (chat apps, social media, search previews); 1200 × 630 px works everywhere. Empty = no preview picture.' },
  { key: 'OG_LOCALE', label: 'Language of the site for link previews', group: 'Site texts & pages', type: 'string', default: 'en_US', pending: 'the link-preview update (PKG-14)',
    validate: (v) => (/^[a-z]{2}_[A-Z]{2}$/.test(v) ? null : 'use language_COUNTRY, e.g. en_US, en_GB or nl_NL.'),
    hint: 'Told to social media and search engines with every page (og:locale), e.g. en_US, en_GB, nl_NL. Match the language the site is written in.' },

  // ── Suppliers (companies that sell their stock through you) ──
  { key: 'SELLER_PROGRAMME_PUBLIC', label: 'Public supplier programme page', group: 'Suppliers', type: 'bool', default: 'false', options: yesNo, pending: 'the supplier programme page (PKG-12)',
    hint: 'Yes: /seller/pricing explains to suppliers how selling through you works (the two texts below) and search engines may list it. No (default): that page does not exist for visitors — suppliers join by agreement with your team.' },
  { key: 'SELLER_TERMS_TEXT', label: 'Supplier programme — how it works', group: 'Suppliers', type: 'text', multiline: true, default: DEFAULT_SELLER_TERMS_TEXT, pending: 'the supplier programme page (PKG-12)',
    hint: 'First part of /seller/pricing. Describe the real deal — by default a supplier receives their own price and never sees your sell price (Quotes & offers → “Suppliers see the buyer price”). “## ” starts a heading, an empty line a new paragraph.' + tokensHint(SELLER_TERMS_TOKENS) },
  { key: 'SELLER_PAYOUT_TERMS_TEXT', label: 'Supplier programme — how suppliers are paid', group: 'Suppliers', type: 'text', multiline: true, default: DEFAULT_SELLER_PAYOUT_TERMS_TEXT, pending: 'the supplier programme page (PKG-12)',
    hint: 'Payout part of /seller/pricing: when and how a supplier is paid for a sold unit. Only state terms your supplier agreements really contain.' + tokensHint(SELLER_TERMS_TOKENS) },
  { key: 'MESSAGE_MEDIATION_MODE', label: 'Messages between buyers and suppliers', group: 'Suppliers', type: 'enum', default: 'MASK_CONTACTS', sensitive: true, pending: 'buyer–supplier message mediation (PKG-01, PKG-16)',
    options: [
      { value: 'MASK_CONTACTS', label: 'Remove contact details (e-mail addresses, phone numbers, links, IBANs) and notify staff (recommended)' },
      { value: 'STAFF_REVIEW', label: 'Staff release every supplier message before the buyer sees it' },
      { value: 'OFF', label: 'Deliver messages as written (buyers and suppliers can deal around you)' },
    ],
    hint: 'Applies to quote threads and “Message seller” conversations between a buyer and a supplier. Removed details show as “[contact details removed]”. Messages written by your own staff are never changed.' },

  // ── Acquisitions ──
  { key: 'COMPANY_RECEIVING_ADDRESS', label: 'Receiving warehouse address', group: 'Acquisitions', type: 'text', multiline: true,
    hint: 'Full address sellers ship accepted equipment to. Multi-line OK. Shown in their shipping form once we accept their offer.' },
  { key: 'EMAIL_THROTTLE_HOURS', label: 'Email throttle (hours)', group: 'Acquisitions', type: 'int', verify: 'number', min: 0, max: 168,
    hint: 'When we reply to a seller/buyer, skip the email if we already emailed them in the last N hours (the in-app notification still fires). Stops chat-rapid-fire spam. Default: 2.' },
  { key: 'SELL_TERMS_TEXT', label: 'Sell form — terms the seller accepts', group: 'Acquisitions', type: 'text', multiline: true, default: DEFAULT_SELL_TERMS_TEXT, pending: 'the sell-form terms and declarations (PKG-17)',
    hint: 'Shown above the “I accept” tick-box of the “Sell equipment” form; the time of acceptance is kept with the submission. Keep it in line with “How you acquire equipment”. An empty line starts a new paragraph.' },
  { key: 'SELL_DECONTAMINATION_TEXT', label: 'Sell form — decontamination declaration', group: 'Acquisitions', type: 'text', multiline: true, default: DEFAULT_SELL_DECONTAMINATION_TEXT, pending: 'the sell-form terms and declarations (PKG-17)',
    hint: 'The declaration a seller ticks before shipping equipment to you (with a field for remaining residues or hazards); the time is kept with the submission.' },

  // ── Catalog & claims / Import & suppliers / Acquisitions (/sell copy) ──
  // Owned by the catalog area (src/lib/catalog/settings-defs.ts), read through
  // getCatalogPolicy(). Every claim defaults to "no claim".
  ...CATALOG_SETTING_DEFS,

  // ── Quotes & offers (quotes / payment area: src/lib/quotes/settings-defs.ts) ──
  ...QUOTE_SETTING_DEFS,

  // ── Fulfilment & delivery / Returns & refunds / payout-bank lock
  // (fulfilment area: src/lib/fulfilment/settings-defs.ts) ──
  ...FULFILMENT_SETTING_DEFS,

  // ── Support (support tickets: src/lib/support/settings-defs.ts) ──
  ...SUPPORT_SETTING_DEFS,

  // ── Homepage (stations, items and texts: src/lib/home/settings-defs.ts) ──
  ...HOME_SETTING_DEFS,

  // ── AI assistant (admin AI tools; the on-site chat was removed) ──
  { key: 'AI_API_KEY', label: 'AI API key', group: 'AI assistant', type: 'secret',
    hint: 'OpenAI-compatible (sk-…) or Anthropic (sk-ant-…) key for the admin AI tools: supplier-shop suggestions and shop risk checks (Shops & suppliers). Empty = those tools are off.' },
  { key: 'AI_BASE_URL', label: 'AI base URL', group: 'AI assistant', type: 'url', verify: 'url',
    hint: 'Empty = https://api.openai.com/v1 (or https://api.anthropic.com for an Anthropic key) — change for any OpenAI-compatible provider.' },
  { key: 'AI_MODEL', label: 'AI model', group: 'AI assistant', type: 'string',
    hint: 'Empty = gpt-4o-mini (or claude-haiku-4-5 for an Anthropic key).' },
];

export const SETTING_DEFS: readonly SettingDefinition[] = DEFS.map((d) => ({ ...d, secret: d.type === 'secret' }));

const BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

export function settingDef(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

/** Keys of the security policy (src/lib/security/policy-defs.ts). */
export function isSecurityPolicyKey(key: string): boolean {
  return BY_KEY.get(key)?.group === 'Security';
}

export type SettingKey = string;

// ── value parsing / validation (pure) ─────────────────────────────────────────

/** Convert what the admin typed into the stored representation (money: € → cents). */
export function normaliseInput(d: SettingDefinition, raw: string): string {
  const v = raw.replace(/\r\n/g, '\n').trim();
  if (!v) return '';
  switch (d.type) {
    case 'money': {
      const n = Number(v.replace(/[€\s]/g, '').replace(',', '.'));
      return Number.isFinite(n) ? String(Math.round(n * 100)) : v;
    }
    case 'country':
      return v.toUpperCase();
    case 'list':
      return v.split(',').map((s) => s.trim()).filter(Boolean).join(',');
    case 'percent':
      return v.replace(',', '.').replace(/%$/, '').trim();
    case 'bool':
      return /^(true|1|yes|on)$/i.test(v) ? 'true' : /^(false|0|no|off)$/i.test(v) ? 'false' : v;
    default:
      return v;
  }
}

/** The stored value in the unit the admin form shows (money: cents → €). */
export function displayValue(d: SettingDefinition, stored: string): string {
  if (d.type === 'money' && /^-?\d+$/.test(stored)) return (Number(stored) / 100).toFixed(2);
  return stored;
}

/** Validate a NORMALISED value. Returns a reason, or null. Empty = "unset" (allowed here;
 *  saveSettings refuses emptying a `required` key). `ctx`: see SettingDefinition.validate. */
export function validateSettingValue(d: SettingDefinition, value: string, ctx?: SettingValidationContext): string | null {
  if (value === '') return null;
  switch (d.type) {
    case 'int': {
      if (!/^-?\d+$/.test(value)) return `“${value}” is not a whole number.`;
      const n = Number(value);
      if (d.min !== undefined && n < d.min) return `must be at least ${d.min}.`;
      if (d.max !== undefined && n > d.max) return `must be at most ${d.max}.`;
      break;
    }
    case 'percent': {
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) return `“${value}” is not a percentage (e.g. 21 or 25.5).`;
      const n = Number(value);
      if (n < (d.min ?? 0) || n > (d.max ?? 100)) return `must be between ${d.min ?? 0} and ${d.max ?? 100}.`;
      break;
    }
    case 'money': {
      if (!/^-?\d+$/.test(value)) return `“${value}” is not an amount (e.g. 12.50).`;
      if (d.min !== undefined && Number(value) < d.min) return 'must not be negative.';
      break;
    }
    case 'bool':
      if (value !== 'true' && value !== 'false') return 'choose Yes or No.';
      break;
    case 'enum':
      if (!d.options?.some((o) => o.value === value)) return `“${value}” is not one of the allowed choices.`;
      break;
    case 'country':
      if (!/^[A-Z]{2}$/.test(value)) return 'use a 2-letter country code, e.g. NL.';
      break;
    case 'email': {
      const addr = value.match(/<([^>]+)>\s*$/)?.[1] ?? value;
      if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(addr.trim())) return `“${value}” is not a valid email address.`;
      break;
    }
    case 'url':
    case 'image': {
      if (d.type === 'image' && /^\/(?![/\\])/.test(value)) break; // site-relative upload path
      try {
        const u = new URL(value);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'must start with https:// (or http://).';
      } catch {
        return `“${value}” is not a valid URL (include https://).`;
      }
      break;
    }
    case 'string':
    case 'text':
      if (value.length > 5000) return 'is too long (max 5000 characters).';
      break;
    default:
      break;
  }
  return d.validate ? d.validate(value, ctx) : null;
}

/** Mask a secret for the change history: never the plaintext. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 10 ? `•••• ${value.slice(-4)}` : '••••';
}
