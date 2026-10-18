import type { SettingDefinitionInput } from '@/lib/settings/defs';

/**
 * Admin settings owned by the quotes / offers / payment-page area (wave 2,
 * team s2b). Registered in the typed settings registry (src/lib/settings/defs.ts)
 * so they show in Admin → Settings → "Quotes & offers" with validation, the
 * .env fallback and the Change history. Read them through the getters in
 * ./policy.ts (after ensureSettingsLoaded), never from process.env directly.
 */

const ON_OFF = [
  { value: 'true', label: 'On' },
  { value: 'false', label: 'Off' },
] as const;

const intList = (min: number, max: number) => (v: string): string | null => {
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !/^\d+$/.test(p) || Number(p) < min || Number(p) > max);
  return bad.length ? `use whole numbers between ${min} and ${max}, separated by commas (e.g. 7,3,1).` : null;
};

const textList = (v: string): string | null => {
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return 'add at least one entry.';
  return parts.some((p) => p.length > 80) ? 'each entry may have at most 80 characters.' : null;
};

/** A site path ("/legal/terms", not "//host") or an https:// link. */
export const termsLink = (v: string): string | null =>
  /^(\/(?!\/)[^\s]*|https:\/\/[^\s/]+[^\s]*)$/.test(v.trim()) ? null : 'a site path such as /legal/terms or a full https:// link.';

export const QUOTE_SETTING_DEFS: readonly SettingDefinitionInput[] = [
  {
    key: 'QUOTE_REFERENCE_PREFIX', label: 'Quote reference prefix', group: 'Quotes & offers', type: 'string', default: 'RFQ',
    validate: (v) => (/^[A-Za-z0-9]{1,8}$/.test(v.trim()) ? null : 'use 1–8 letters or digits, e.g. RFQ.'),
    hint: 'Quotes are referred to as <prefix>-XXXXXX (last 6 characters of the request) until a proforma number exists — in e-mails, on the quote pages and on proformas.',
  },
  {
    key: 'OFFER_MAX_AMOUNT_CENTS', label: 'Largest offer amount', group: 'Quotes & offers', type: 'money', default: '100000000', min: 100,
    hint: 'Safety limit for the goods price of one offer (typing errors such as an extra zero). Default 1,000,000.00.',
  },
  // ── Offer defaults ─────────────────────────────────────────────────────
  {
    key: 'OFFER_VALID_DAYS', label: 'Offer validity (days)', group: 'Quotes & offers', type: 'int', default: '14', min: 1, max: 365,
    hint: 'How long a new offer can be accepted (prefilled “valid until” = today + this many days; staff can change it per offer). Separate from the payment term after acceptance.',
  },
  {
    key: 'OFFER_CURRENCIES', label: 'Currencies staff can quote in', group: 'Quotes & offers', type: 'list', default: 'EUR,USD,GBP,CHF',
    validate: (v) => (v.split(',').map((s) => s.trim()).filter(Boolean).every((c) => /^[A-Z]{3}$/.test(c)) ? null : 'comma-separated 3-letter ISO codes, e.g. EUR,USD.'),
    hint: 'The first currency is the default in the offer form. Every offer, proforma and invoice keeps the currency it was sent in.',
  },
  {
    key: 'OFFER_DEFAULT_SHIPPING_CENTS', label: 'Freight prefilled in a new offer', group: 'Quotes & offers', type: 'money', default: '0', min: 0,
    hint: 'Freight / crating / insurance is quoted per deal; this only prefills the field. It is taxed like the goods it delivers.',
  },
  {
    key: 'OFFER_INCOTERMS', label: 'Incoterms staff can choose', group: 'Quotes & offers', type: 'list', default: 'EXW,FCA,CPT,CIP,DAP,DPU,DDP',
    validate: (v) => (v.split(',').map((s) => s.trim()).filter(Boolean).every((c) => /^[A-Z]{3}$/.test(c)) ? null : 'comma-separated 3-letter Incoterms, e.g. EXW,DAP,DDP.'),
    hint: 'Incoterms® 2020 rules offered in the offer form. The chosen rule and named place are printed on the offer, the proforma and the invoice.',
  },
  {
    key: 'OFFER_DEFAULT_INCOTERM', label: 'Default Incoterm', group: 'Quotes & offers', type: 'string', default: 'EXW',
    validate: (v) => (/^[A-Z]{3}$/.test(v) ? null : 'a 3-letter Incoterm such as EXW or DAP.'),
    hint: 'Prefilled in a new offer. Must be one of the Incoterms above (otherwise the first one is used).',
  },
  {
    key: 'OFFER_DEFAULT_INCOTERM_PLACE', label: 'Default named place', group: 'Quotes & offers', type: 'string', optional: true,
    hint: 'e.g. “Zoetermeer, NL” for EXW. Empty = the issuing city from Settings → Company (or the city on the registered address), plus the VAT home country.',
  },
  {
    key: 'OFFER_DEFAULT_LEAD_TIME', label: 'Lead time prefilled in a new offer', group: 'Quotes & offers', type: 'string', optional: true,
    hint: 'e.g. “Ready to ship within 10 business days after payment”. Empty = staff type it per offer (it is then not printed when left empty).',
  },
  {
    key: 'OFFER_DEFAULT_WARRANTY', label: 'Warranty prefilled when the item has none', group: 'Quotes & offers', type: 'string', optional: true,
    hint: 'Used only when the quoted item has no warranty of its own (item → condition default, Admin → Catalog). Empty = the catalog “no warranty” text.',
  },
  {
    key: 'OFFER_PAYMENT_TERMS_TEXT', label: 'Payment terms printed on offers', group: 'Quotes & offers', type: 'string',
    default: 'Payment in full by bank transfer within {DAYS} days of acceptance, before dispatch.',
    hint: '{DAYS} is replaced by the offer’s payment term (Settings → Payments & credit terms → Payment term, editable per offer).',
  },
  {
    key: 'OFFER_REQUIRE_TERMS_ACCEPTANCE', label: 'Buyer must accept the Terms of Sale', group: 'Quotes & offers', type: 'bool', default: 'true', options: ON_OFF,
    hint: 'On: the buyer ticks “I accept this offer and the General Terms of Sale” before accepting. The acceptance is recorded with time, IP and browser.',
  },
  {
    key: 'TERMS_OF_SALE_URL', label: 'Terms of Sale link', group: 'Quotes & offers', type: 'string', default: '/legal/terms',
    validate: termsLink,
    hint: 'Linked as “General Terms of Sale” from the acceptance step and the offer email. Default /legal/terms (the Terms text under Documents & legal texts); the version the buyer accepted is stored on the order.',
  },
  {
    key: 'PROFORMA_REVISION_EMAIL', label: 'Email a revised proforma when the buyer changes details', group: 'Quotes & offers', type: 'bool', default: 'true', options: ON_OFF,
    hint: 'When the buyer changes billing or delivery details before paying, a new proforma revision (…-r2) replaces the old one. On: it is emailed to the buyer with the PDF.',
  },

  // ── Supplier proposals (A30) ───────────────────────────────────────────
  {
    key: 'SELLER_OFFERS_REQUIRE_APPROVAL', label: 'Supplier prices need staff review', group: 'Quotes & offers', type: 'bool', default: 'true', options: ON_OFF,
    hint: 'On (recommended): a supplier’s price is a proposal to your team; staff review it, add the margin and send the offer to the buyer. Off: the supplier’s price plus the margin below goes to the buyer immediately (the supplier is told only their own price).',
  },
  {
    key: 'SELLER_OFFER_MARKUP_PCT', label: 'Your margin on supplier prices (%)', group: 'Quotes & offers', type: 'percent', default: '15', min: 0, max: 100,
    hint: 'Added to a supplier’s price to get the buyer price (prefilled for review, or applied automatically when review is off).',
  },
  {
    key: 'SELLER_OFFER_PRICE_ROUNDING', label: 'Round the buyer price up to', group: 'Quotes & offers', type: 'enum', default: 'WHOLE',
    options: [
      { value: 'NONE', label: 'No rounding (cents)' },
      { value: 'WHOLE', label: 'Whole euros' },
      { value: 'TEN', label: 'Tens (e.g. 11,510)' },
      { value: 'HUNDRED', label: 'Hundreds (e.g. 11,600)' },
    ],
    hint: 'Applied after the margin.',
  },
  {
    key: 'SELLER_SEES_SELL_PRICE', label: 'Suppliers see the buyer price', group: 'Quotes & offers', type: 'bool', default: 'false', options: ON_OFF,
    hint: 'Off (default): the supplier sees only their own proposal and the deal status, never your price to the buyer or your margin.',
  },

  // ── Workflow ───────────────────────────────────────────────────────────
  {
    key: 'QUOTE_SLA_HOURS', label: 'First-reply time per priority (hours)', group: 'Quotes & offers', type: 'list', default: 'VIP:2,URGENT:2,HIGH:8,NORMAL:24,LOW:72',
    validate: (v) => {
      const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
      const ok = parts.every((p) => /^(VIP|URGENT|HIGH|NORMAL|LOW):\d{1,4}$/.test(p)) && parts.some((p) => p.startsWith('NORMAL:'));
      return ok ? null : 'use PRIORITY:hours pairs, e.g. VIP:2,URGENT:2,HIGH:8,NORMAL:24,LOW:72 (NORMAL is required).';
    },
    hint: 'The SLA clock runs while a request waits for your team (new request, or the buyer wrote last). It stops when staff reply or send an offer.',
  },
  {
    key: 'QUOTE_AUTO_ARCHIVE_ON_CLOSE', label: 'Archive a quote when it is closed', group: 'Quotes & offers', type: 'bool', default: 'false', options: ON_OFF,
    hint: 'Off (default): a closed deal stays in the Lost tab. On: closing also archives it (only the Archived view shows it).',
  },
  {
    key: 'QUOTE_DECLINE_REASONS', label: 'Reasons a buyer can give when declining', group: 'Quotes & offers', type: 'list',
    default: 'Price too high,Lead time too long,Bought elsewhere,Budget not approved,No longer needed,Other',
    validate: textList,
    hint: 'Shown in the decline dialog (optional for the buyer). Staff see the reason on the quote and in the Lost tab.',
  },
  {
    key: 'QUOTE_CLOSE_REASONS', label: 'Reasons staff give when closing a request without a deal', group: 'Quotes & offers', type: 'list',
    default: 'No suitable unit found,Buyer stopped responding,Price not acceptable,Bought elsewhere,Duplicate request,Other',
    validate: textList,
    hint: 'Shown in the “Close (no deal)” dialog. The reason (and the optional note) is stored on the quote, posted in the conversation and included in the e-mail to the buyer.',
  },
  {
    key: 'QUOTE_MSG_VAT_ID_UNCHECKED', label: 'Acceptance while the EU VAT ID check (VIES) is down', group: 'Quotes & offers', type: 'string',
    default: 'We could not check your VAT ID with the EU service right now. Your order is placed; we confirm the VAT before asking for payment.',
    hint: 'Shown to the buyer on the acceptance step and in the order e-mail when VIES does not answer (Tax & VAT → VIES down policy “manual review”). The order waits on a VAT review: no proforma or payment request until staff confirm the VAT.',
  },
  {
    key: 'QUOTE_MSG_VAT_REVIEW', label: 'Acceptance when the VAT needs a staff decision', group: 'Quotes & offers', type: 'string',
    default: 'We need to confirm the VAT for these billing details. Your order is placed; we confirm the VAT before asking for payment.',
    hint: 'Shown to the buyer when the VAT rules cannot decide on their own (e.g. the VAT ID is registered to another company name). The order waits on a VAT review before the proforma is sent.',
  },
  {
    key: 'BUYER_CAN_CANCEL_UNPAID_ORDER', label: 'Buyer can cancel an unpaid order', group: 'Quotes & offers', type: 'bool', default: 'true', options: ON_OFF,
    hint: 'On: until a payment receipt is sent (or a card payment completes), the buyer can cancel an unpaid order themselves — an accepted quote order or a checkout order — with confirmation. The proforma becomes void, the reserved unit is released and staff are notified. After payment only staff cancel (with a refund and a credit note).',
  },
  {
    key: 'ORDER_CANCEL_REASONS', label: 'Reasons a buyer can give when canceling', group: 'Quotes & offers', type: 'list',
    default: 'Ordered by mistake,Found a better offer,Budget withdrawn,Delivery time too long,Other',
    validate: textList,
    hint: 'Shown in the cancel dialog.',
  },
  {
    key: 'OFFER_EXPIRY_REMINDER_DAYS', label: 'Remind the buyer before an offer expires (days before)', group: 'Quotes & offers', type: 'list', default: '3', optional: true,
    validate: intList(1, 60),
    hint: 'One reminder email per value, e.g. “7,2”. Empty = no reminders. Sent once each.',
  },
  {
    key: 'OFFER_EXPIRED_STAFF_ALERT', label: 'Tell staff when an offer expired', group: 'Quotes & offers', type: 'bool', default: 'true', options: ON_OFF,
    hint: 'One notification to the assignee (or all quote staff) when an open offer passes its validity without an answer.',
  },
];
