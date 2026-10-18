import type { SettingDefinitionInput } from '@/lib/settings/defs';
import { DEFAULT_WARRANTY_FALLBACK_TEXT, DEFAULT_WARRANTY_MONTHS_FORMAT } from './warranty';
import {
  DEFAULT_BRAND_ALIASES,
  DEFAULT_BRAND_NAMES,
  DEFAULT_CATEGORY_RULES,
  DEFAULT_CLAIM_PHRASES,
  DEFAULT_CONDITION_WORDS,
  DEFAULT_TAIL_SECTIONS,
  parseAliasLines,
  parseCategoryRules,
} from './import-rules';
import { CATALOG_TEXT_DEFAULTS as T, DEFAULT_TERMS_TEXT, TERMS_TOKENS } from './texts';

/**
 * Admin settings owned by the catalog / content-truthfulness area.
 *
 * Registered in the typed settings registry (src/lib/settings/defs.ts) so they
 * appear in Admin → Settings with the same validation, save/clear/.env-fallback
 * rules and Change history as every other setting. Read them through
 * getCatalogPolicy() (src/lib/catalog/policy.ts) / getImportSettings()
 * (src/lib/catalog/import-settings.ts), never straight from process.env, so the
 * defaults below apply everywhere.
 *
 * Rule for every marketing claim here: the default is "no claim". A claim
 * appears on the site only after the owner types it in.
 */

const ON_OFF = [
  { value: 'true', label: 'On' },
  { value: 'false', label: 'Off' },
] as const;

const tokenHint = (tokens: string) => ` Placeholders: ${tokens}.`;

/** Placeholders of “Search description built from the facts” (filled by fillMetaFormat in jsonld.ts). */
export const PDP_META_TOKENS = ['{CONDITION}', '{BRAND}', '{TITLE}', '{CATEGORY}', '{YEAR}', '{SITE}'] as const;

/** Defaults of the search / not-found texts below (read through getCatalogPolicy()). */
export const SEO_TEXT_DEFAULTS = {
  soldPriceLabel: 'Last price',
  metaDescriptionFormat: '{CONDITION} {BRAND} {TITLE} ({CATEGORY}, {YEAR}) at {SITE}. See the condition, warranty and details of this unit.',
  notFoundTitle: 'Page not found',
  notFoundText: 'The page you are looking for does not exist or is no longer available. Search the marketplace or continue with one of the pages below.',
} as const;

function metaFormatProblem(v: string): string | null {
  if (!v.includes('{TITLE}')) return 'must contain {TITLE}.';
  const unknown = (v.match(/\{[A-Z_]+\}/g) ?? []).filter((t) => !(PDP_META_TOKENS as readonly string[]).includes(t));
  return unknown.length ? `unknown placeholder ${unknown[0]}.` : null;
}

export const CATALOG_SETTING_DEFS: readonly SettingDefinitionInput[] = [
  // ── Catalog & claims ───────────────────────────────────────────────────
  {
    key: 'WARRANTY_FALLBACK_TEXT', label: 'Text when an item has no warranty', group: 'Catalog & claims',
    type: 'string', default: DEFAULT_WARRANTY_FALLBACK_TEXT,
    hint: 'Shown on the product page, order and invoice line when neither the item nor its condition (Admin → Catalog → Conditions & warranty) gives a warranty. Default: “No warranty (sold as-is)”.',
  },
  {
    key: 'WARRANTY_MONTHS_FORMAT', label: 'How a warranty length is written', group: 'Catalog & claims',
    type: 'string', default: DEFAULT_WARRANTY_MONTHS_FORMAT,
    validate: (v) => (v.includes('{MONTHS}') ? null : 'must contain {MONTHS}, e.g. “{MONTHS}-month warranty”.'),
    hint: 'Badge, fact tile, order line and invoice line, e.g. “12-month warranty”.' + tokenHint('{MONTHS}'),
  },
  {
    key: 'INSPECTION_CLAIM_REQUIRES_REPORT', label: 'Claim “inspected” only with a report', group: 'Catalog & claims',
    type: 'bool', default: 'true',
    options: ON_OFF,
    hint: 'On (default): a product page says the unit was inspected only when an inspection date AND a report are recorded on the item. Off: an inspection date alone is enough.',
  },
  {
    key: 'INSPECTION_NONE_TEXT', label: 'Text when a unit has no inspection report', group: 'Catalog & claims',
    type: 'text', multiline: true, default: T.inspectionNone,
    hint: 'Shown under “Inspection & warranty” on a product page without a recorded inspection.',
  },
  {
    key: 'MISSING_PHOTO_MODE', label: 'Listings without photos show', group: 'Catalog & claims',
    type: 'enum', default: 'PLACEHOLDER',
    options: [
      { value: 'PLACEHOLDER', label: '“Photo on request” placeholder' },
      { value: 'LABELLED_ILLUSTRATION', label: 'Instrument drawing labelled “Illustration – not the actual item”' },
    ],
    hint: 'Product cards, product page, homepage and search suggestions. A stock photo of another instrument is never shown as if it were the item; a drawing is only used when one fits the item’s category. Default: placeholder.',
  },
  {
    key: 'NO_PHOTO_LABEL', label: 'Placeholder text (no photo)', group: 'Catalog & claims',
    type: 'string', default: T.noPhotoLabel, hint: 'On the placeholder tile of a listing without photos.',
  },
  {
    key: 'ILLUSTRATION_LABEL', label: 'Label on an instrument drawing', group: 'Catalog & claims',
    type: 'string', default: T.illustrationLabel, hint: 'Always shown on a drawing, so nobody takes it for a photo of the unit.',
  },
  {
    key: 'TRUST_SHIPPING_CLAIM', label: 'Shipping promise (product pages)', group: 'Catalog & claims',
    type: 'string', optional: true,
    hint: 'e.g. “Worldwide shipping · crated & insured”. Only enter what you really do on EVERY order — it is shown on every product page, the About page and the FAQ. Blank (default) = no shipping promise anywhere.',
  },
  {
    key: 'TRUST_RETURNS_CLAIM', label: 'Returns / buyer-protection promise', group: 'Catalog & claims',
    type: 'string', optional: true,
    hint: 'e.g. “Refund if not as described”. Must match your terms. Blank (default) = not shown.',
  },
  // The return window itself (RETURN_WINDOW_DAYS) is ONE setting shared with the return
  // requests on the order page: Settings → Returns & refunds (lib/fulfilment/settings-defs.ts).
  {
    key: 'SEO_ADVERTISE_RETURN_POLICY', label: 'Tell search engines about the return window', group: 'Catalog & claims',
    type: 'bool', default: 'false', options: ON_OFF,
    hint: 'On: the structured data of priced listings includes a return policy — the days of the return window (Settings → Returns & refunds), your VAT home country, return by post, and who pays the return shipping when that is fixed — but only while the Terms of Service text states that window ({RETURN_DAYS}). Off (default): no return policy is advertised. Only switch it on if buyers can really return an item within that window, not only one that differs from its description.',
  },
  {
    key: 'ARCHIVED_LISTING_RESPONSE', label: 'Address of an archived listing', group: 'Catalog & claims',
    type: 'enum', default: 'GONE',
    options: [
      { value: 'GONE', label: 'A “page not found” page with search and links; search engines drop the address' },
      { value: 'REDIRECT_CATEGORY', label: 'Send visitors and search engines to its category (permanent redirect)' },
    ],
    hint: 'What a link to a listing you archived opens. A rule for that address in Admin → SEO → Redirects wins over this. Drafts and listings waiting for review always answer “page not found” (they were never public).',
  },
  {
    key: 'PDP_SOLD_PRICE', label: 'Price of a sold unit', group: 'Catalog & claims',
    type: 'enum', default: 'LAST_PRICE',
    options: [
      { value: 'LAST_PRICE', label: 'Show it, with the label below' },
      { value: 'HIDE', label: 'Hide it' },
    ],
    hint: 'Product page and search-engine data of a sold or no longer available unit (a reserved one keeps its price). A sold unit never shows “Buy now” or “Request a quote”: it offers to source a similar one.',
  },
  {
    key: 'PDP_SOLD_PRICE_LABEL', label: 'Label of a sold unit’s price', group: 'Catalog & claims', type: 'string', default: SEO_TEXT_DEFAULTS.soldPriceLabel,
    hint: 'Above the price of a sold or no longer available unit (when it is shown).',
  },
  {
    key: 'PDP_META_DESCRIPTION_FORMAT', label: 'Search description built from the facts', group: 'Catalog & claims',
    type: 'string', default: SEO_TEXT_DEFAULTS.metaDescriptionFormat, validate: metaFormatProblem,
    hint: 'Search results and link previews of a listing. Order used: the listing’s own search description (product form → Search engines), else its summary or description (first ~155 characters), else this text. The brand or condition is left out when the title already says it, and an empty year or category drops its brackets.' + tokenHint(PDP_META_TOKENS.join(', ')),
  },
  {
    key: 'REQUIRE_CONSENT_TO_PUBLISH', label: 'Testimonials & case studies need recorded consent', group: 'Catalog & claims',
    type: 'bool', default: 'true',
    options: ON_OFF,
    hint: 'On (default): a testimonial or case study can only be published once you record who approved it and when. Endorsements without proof of consent are illegal under the EU Omnibus rules.',
  },
  {
    key: 'CONDITION_TEXT_WORDS', label: 'Words that state a condition', group: 'Catalog & claims',
    type: 'text', multiline: true, default: DEFAULT_CONDITION_WORDS,
    validate: (v) => (/^(?:\s*(?:NEW|REFURBISHED|USED)\s*:.+\n?)+\s*$/i.test(v) ? null : 'one line per condition: “NEW: brand new, unused”, “REFURBISHED: …”, “USED: …”.'),
    hint: 'Used to flag listings whose condition grade contradicts their own title or text (Admin → Catalog → Audit) and new imports that say another condition. One line per condition; `*` = any word ending.',
  },
  {
    key: 'PDP_SOLD_TITLE', label: 'Product page — sold: title', group: 'Catalog & claims', type: 'string', default: T.soldTitle,
    hint: 'When the unit was sold here.',
  },
  {
    key: 'PDP_SOLD_TEXT', label: 'Product page — sold: explanation', group: 'Catalog & claims', type: 'text', multiline: true, default: T.soldText,
    hint: 'Under the title above.',
  },
  {
    key: 'PDP_UNAVAILABLE_TITLE', label: 'Product page — not available: title', group: 'Catalog & claims', type: 'string', default: T.unavailableTitle,
    hint: 'When the source no longer has the unit (out of stock or removed there). Never “Sold”: it was not sold here.',
  },
  {
    key: 'PDP_UNAVAILABLE_TEXT', label: 'Product page — not available: explanation', group: 'Catalog & claims', type: 'text', multiline: true, default: T.unavailableText,
    hint: 'Under the title above.',
  },
  {
    key: 'PDP_BACKORDER_TITLE', label: 'Product page — on backorder: title', group: 'Catalog & claims', type: 'string', default: T.backorderTitle,
    hint: 'When the supplier has the item on backorder and Settings → Import & suppliers says backorders cannot be bought.',
  },
  {
    key: 'PDP_BACKORDER_TEXT', label: 'Product page — on backorder: explanation', group: 'Catalog & claims', type: 'text', multiline: true, default: T.backorderText,
    hint: 'Under the title above.',
  },
  {
    key: 'BACKORDER_LEAD_TIME_TEXT', label: 'Lead time shown for a sellable backorder', group: 'Catalog & claims', type: 'string', default: T.backorderLeadTime,
    hint: 'Shown next to the price when backorders can be bought (Settings → Import & suppliers).',
  },
  {
    key: 'PDP_RESERVED_TEXT', label: 'Product page — reserved: explanation', group: 'Catalog & claims', type: 'text', multiline: true, default: T.reservedText,
    hint: 'When the unit is held for another buyer’s accepted offer or unpaid order.',
  },
  {
    key: 'PRICE_REVIEW_BUYER_TEXT', label: 'Product page — price being confirmed', group: 'Catalog & claims', type: 'text', multiline: true, default: T.priceReview,
    hint: 'While a large supplier price change waits for your approval (Admin → Catalog → Price review) and the listing cannot be bought.',
  },
  {
    key: 'PDP_NO_DESCRIPTION_TEXT', label: 'Product page — no description', group: 'Catalog & claims', type: 'string', default: T.noDescription,
    hint: 'When a listing has neither a description nor a summary.',
  },
  {
    key: 'PDP_ASK_PHOTOS_LABEL', label: 'Button — request photos', group: 'Catalog & claims', type: 'string', default: T.askPhotosLabel,
    hint: 'Shown under a listing without photos. It sends a photo request to your support inbox (a support ticket), never a quote request.',
  },
  {
    key: 'PDP_ASK_PHOTOS_MESSAGE', label: 'Prefilled photo request', group: 'Catalog & claims', type: 'text', multiline: true, default: T.askPhotosMessage,
    hint: 'The buyer can edit it before sending.' + tokenHint('{TITLE}'),
  },
  {
    key: 'PRODUCT_QUESTION_MIN_CHARS', label: 'Shortest product question (characters)', group: 'Catalog & claims', type: 'int', default: '10', min: 2, max: 200,
    hint: 'The question / photo-request box and the server use the same minimum.',
  },
  {
    key: 'SELLER_BOX_SHOW_LISTINGS', label: 'Show the number of live listings in “Sold by”', group: 'Catalog & claims',
    type: 'bool', default: 'true', options: ON_OFF,
    hint: 'The “Sold by” box on a product page shows the seller of record (Settings → Company). On: with its total number of live listings (never a supplier’s own count).',
  },
  {
    key: 'REVIEWS_EMPTY_TEXT', label: 'Product page — no reviews yet', group: 'Catalog & claims', type: 'string', default: T.reviewsEmpty,
    hint: 'Only buyers who bought the item can review it, so the default does not invite everyone to “be the first”.',
  },
  // ── Import & suppliers ─────────────────────────────────────────────────
  {
    key: 'IMPORT_REQUIRE_SIGNED_AGREEMENT', label: 'Import only from shops with an agreement', group: 'Import & suppliers',
    type: 'bool', default: 'true',
    options: ON_OFF,
    hint: 'On (default): a shop can be imported/synced only after you mark its supplier agreement as signed, or the shop as your own (Admin → Shops → Sync settings). Reselling and copying photos/texts needs the owner’s permission.',
  },
  {
    key: 'AGREEMENT_END_ACTION', label: 'When a supplier agreement is terminated', group: 'Import & suppliers',
    type: 'enum', default: 'ARCHIVE_LISTINGS',
    options: [
      { value: 'ARCHIVE_LISTINGS', label: 'Stop selling: archive the shop’s live listings' },
      { value: 'WARN_ONLY', label: 'Only warn me (listings stay on sale)' },
    ],
    hint: 'Without an agreement you may no longer resell the supplier’s items. Archived listings are never re-published automatically; open orders and quotes are listed so you can handle them.',
  },
  {
    key: 'SYNC_PRICE_DROP_REVIEW_PCT', label: 'Hold price drops larger than (%)', group: 'Import & suppliers',
    type: 'percent', default: '30', min: 1, max: 100,
    hint: 'A supplier price that falls by more than this goes to Admin → Catalog → Price review instead of going live (a typo like €12,500 → €125 never becomes a sale).',
  },
  {
    key: 'SYNC_PRICE_RISE_REVIEW_PCT', label: 'Hold price rises larger than (%)', group: 'Import & suppliers',
    type: 'percent', default: '50', min: 1, max: 900,
    hint: 'A supplier price that rises by more than this also waits for your approval.',
  },
  {
    key: 'SYNC_PRICE_REVIEW_HOLD', label: 'While a price change waits for review', group: 'Import & suppliers',
    type: 'enum', default: 'HOLD',
    options: [
      { value: 'HOLD', label: 'The listing cannot be bought online (quote only, no price shown)' },
      { value: 'KEEP', label: 'Keep selling at the current price' },
    ],
    hint: 'Applies to price changes queued from now on. Default: not buyable until you approve or reject the new price.',
  },
  {
    key: 'SYNC_ARCHIVE_STOP_PCT', label: 'Safety stop: more than … % of a shop missing', group: 'Import & suppliers',
    type: 'percent', default: '10', min: 1, max: 100,
    hint: 'When more of a shop’s imported items than this disappear from the source in one run, nothing is archived (a broken or truncated source must not take your catalogue offline). Proportional for every shop size.',
  },
  {
    key: 'SYNC_ARCHIVE_STOP_ALLOW', label: 'Safety stop: always allow up to … items', group: 'Import & suppliers',
    type: 'int', default: '3', min: 0, max: 1000,
    hint: 'This many items may always be archived in one run, so a small shop that sold one or two units is not stopped.',
  },
  {
    key: 'SYNC_BACKORDER_MODE', label: 'Items on backorder at the source', group: 'Import & suppliers',
    type: 'enum', default: 'UNAVAILABLE',
    options: [
      { value: 'UNAVAILABLE', label: 'Not available (shown as “on backorder at our supplier”, never “Sold”)' },
      { value: 'SELLABLE', label: 'Can be bought, with the lead time from Catalog & claims' },
    ],
    hint: 'Default: not available until the supplier has the unit again.',
  },
  {
    key: 'IMPORT_CLAIM_MODE', label: 'Supplier claims in imported texts', group: 'Import & suppliers',
    type: 'enum', default: 'REMOVE',
    options: [
      { value: 'REMOVE', label: 'Remove the sentences (the rest of the text is kept)' },
      { value: 'REVIEW', label: 'Keep them, hold new items for review and list them in the audit' },
    ],
    hint: 'A listing states ONE warranty — yours. Supplier promises (“tested by our engineers”, “3 months warranty”) would contradict it. Every removed sentence is listed in the sync report.',
  },
  {
    key: 'IMPORT_CLAIM_PHRASES', label: 'Phrases that make a sentence a supplier claim', group: 'Import & suppliers',
    type: 'text', multiline: true, default: DEFAULT_CLAIM_PHRASES,
    hint: 'Comma-separated, whole words, any case; `*` = any word ending (warrant* = warranty, warranties).',
  },
  {
    key: 'IMPORT_STRIP_PRICES', label: 'Remove other prices from imported texts', group: 'Import & suppliers',
    type: 'bool', default: 'true', options: ON_OFF,
    hint: 'On (default): sentences with an amount in a currency (“€ 4,500.00”, “Prices from: 17.500 euro”) are removed, so only your price — after markup, force-quote or hidden price — is ever shown or indexed.',
  },
  {
    key: 'IMPORT_TAIL_SECTIONS', label: 'Cross-sell headings (removed with what follows)', group: 'Import & suppliers',
    type: 'list', default: DEFAULT_TAIL_SECTIONS,
    hint: 'A line that starts with one of these (e.g. “Also available:”) is removed with everything after it — those are the supplier’s other products, not this unit.',
  },
  {
    key: 'IMPORT_BRAND_NAMES', label: 'Brands recognised in titles', group: 'Import & suppliers',
    type: 'text', multiline: true, default: DEFAULT_BRAND_NAMES,
    hint: 'Comma-separated. Used when the source gives no brand: the brand named first in the title, as a whole word (“ThermoMixer” is not “Thermo”).',
  },
  {
    key: 'IMPORT_BRAND_ALIASES', label: 'Brand spellings', group: 'Import & suppliers',
    type: 'text', multiline: true, default: DEFAULT_BRAND_ALIASES,
    validate: (v) => {
      const e = parseAliasLines(v).errors;
      return e.length ? e.slice(0, 2).join('; ') + '.' : null;
    },
    hint: 'One per line: “alias => Brand” (e.g. “HP => Hewlett-Packard”). Applies to the source’s brand field and to titles.',
  },
  {
    key: 'IMPORT_CATEGORY_RULES', label: 'Category rules', group: 'Import & suppliers',
    type: 'text', multiline: true, default: DEFAULT_CATEGORY_RULES,
    validate: (v) => {
      const e = parseCategoryRules(v).errors;
      return e.length ? e.slice(0, 2).join('; ') + '.' : null;
    },
    hint: 'One per line: “category-slug: keyword, keyword*”, checked top to bottom against the title and the source’s categories; the first match wins. Slugs are on Admin → Categories.',
  },
  {
    key: 'IMPORT_UNMAPPED_ACTION', label: 'New item without a recognised brand or category', group: 'Import & suppliers',
    type: 'enum', default: 'REVIEW',
    options: [
      { value: 'REVIEW', label: 'Hold it for review (Pending review) with the reason' },
      { value: 'ALLOW', label: 'Follow the shop’s publish setting (no brand / fallback category)' },
    ],
    hint: 'Never a silent guess: the run report and Admin → Catalog → Audit name every item that needs a brand or category.',
  },
  {
    key: 'IMPORT_FALLBACK_CATEGORY', label: 'Category for items no rule matches', group: 'Import & suppliers',
    type: 'string', optional: true,
    validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : 'use a category slug, e.g. “parts-modules”.'),
    hint: 'A category slug. Blank (default) = the first category — such items are always held for review while the setting above says so.',
  },
  {
    key: 'IMPORT_CONDITION_TEXT_ACTION', label: 'New item whose text states another condition', group: 'Import & suppliers',
    type: 'enum', default: 'REVIEW',
    options: [
      { value: 'REVIEW', label: 'Keep the shop’s condition, hold it for review' },
      { value: 'USE_TEXT', label: 'Use the condition the text states' },
      { value: 'IGNORE', label: 'Keep the shop’s condition (listed in the audit only)' },
    ],
    hint: 'e.g. a shop imported as “Used” with an item titled “… Brand New”. Words: Catalog & claims → Words that state a condition.',
  },
  {
    key: 'PLACEHOLDER_BRAND_NAMES', label: 'Brand names that are placeholders', group: 'Import & suppliers',
    type: 'list', default: 'Other,Others,Generic,Unknown,Misc,Various,N/A,NA',
    hint: 'Never shown as a brand: not on product pages, cards, filters, search or structured data.',
  },
  {
    key: 'SYNC_SOURCE_TIMEOUT_SECONDS', label: 'Source page timeout (seconds)', group: 'Import & suppliers',
    type: 'int', default: '45', min: 5, max: 300, hint: 'A source page that takes longer fails the run (nothing is changed).',
  },
  {
    key: 'SYNC_RUN_LOCK_MINUTES', label: 'A sync counts as still running for (minutes)', group: 'Import & suppliers',
    type: 'int', default: '30', min: 5, max: 720, hint: 'A second sync of the same shop is refused while one started less than this long ago is still running.',
  },
  {
    key: 'SYNC_REPORTS_KEEP', label: 'Sync reports kept per shop', group: 'Import & suppliers',
    type: 'int', default: '100', min: 10, max: 2000, hint: 'Older run reports are deleted after each run.',
  },
  {
    key: 'IMPORT_PHOTO_MAX_MB', label: 'Largest photo copied from a source (MB)', group: 'Import & suppliers',
    type: 'int', default: '20', min: 1, max: 100, hint: 'A larger photo is not copied (it stays hidden from buyers and the report says so).',
  },
  // ── Acquisitions (/sell page copy follows the real process) ────────────
  {
    key: 'SELL_ACQUISITION_MODEL', label: 'How you acquire equipment', group: 'Acquisitions',
    type: 'enum', default: 'OUTRIGHT_PURCHASE',
    options: [
      { value: 'OUTRIGHT_PURCHASE', label: 'We buy it outright (pay after it arrives and passes our check)' },
      { value: 'CONSIGNMENT', label: 'Consignment (we sell it for you; you are paid after the buyer confirms)' },
    ],
    hint: 'Drives the promises on the public “Sell equipment” page. Default: outright purchase — the flow the site actually runs.',
  },
  {
    key: 'SELL_LOGISTICS_MODE', label: 'Who ships equipment to you', group: 'Acquisitions',
    type: 'enum', default: 'SELLER_SHIPS',
    options: [
      { value: 'SELLER_SHIPS', label: 'The seller ships it to our warehouse' },
      { value: 'WE_ARRANGE_PICKUP', label: 'We arrange collection (crating, freight, insurance)' },
    ],
    hint: 'Drives the logistics promise on the “Sell equipment” page. Default: the seller ships (what the seller dashboard asks them to do).',
  },
  {
    key: 'SELL_VALUATION_TURNAROUND', label: 'Valuation reply time (Sell page)', group: 'Acquisitions',
    type: 'string', optional: true,
    hint: 'e.g. “2 business days”. Blank (default) = no reply-time promise.',
  },
  // ── Site texts & pages ─────────────────────────────────────────────────
  {
    key: 'SITE_TITLE_SUFFIX', label: 'Page title after the site name', group: 'Site texts & pages', type: 'string', default: T.siteTitleSuffix,
    hint: 'Browser tab and search results of the homepage: “<site name> — <this>”. Describe what you really sell.',
  },
  {
    key: 'SITE_META_DESCRIPTION', label: 'Search-engine description of the site', group: 'Site texts & pages', type: 'text', multiline: true, default: T.siteMetaDescription,
    hint: 'Shown under your homepage in search results and link previews.',
  },
  {
    key: 'FOOTER_TAGLINE', label: 'Footer line under the logo', group: 'Site texts & pages', type: 'string', default: T.footerTagline,
    hint: 'Short description of the business.',
  },
  {
    key: 'FOOTER_SIGNOFF', label: 'Footer closing line', group: 'Site texts & pages', type: 'string', optional: true,
    hint: 'e.g. a slogan. Blank (default) = none.',
  },
  {
    key: 'QUOTE_TURNAROUND', label: 'Quote reply time promise', group: 'Site texts & pages', type: 'string', optional: true,
    hint: 'e.g. “2 business days”. Used on product pages, the quote pages and the sourcing call-to-action. Blank (default) = no reply-time promise.',
  },
  {
    key: 'FINANCING_TEXT', label: 'Financing note under prices', group: 'Site texts & pages', type: 'string', optional: true,
    hint: 'Only if you really offer financing. Blank (default) = none.',
  },
  {
    key: 'STAT_LISTINGS', label: 'Fixed “listings” number (instead of the live count)', group: 'Site texts & pages', type: 'string', optional: true,
    hint: 'Blank (default) = the live number of listings a buyer can browse. A fixed number must stay true.',
  },
  {
    key: 'SOURCING_NO_OBLIGATION_TEXT', label: 'Sourcing request — what it commits the buyer to', group: 'Site texts & pages', type: 'string', default: T.sourcingNoObligation,
    hint: 'On the “Let us find it” page and the homepage call-to-action.',
  },
  {
    key: 'CASE_STUDIES_INTRO', label: 'Case studies page — introduction', group: 'Site texts & pages', type: 'text', multiline: true, default: T.caseStudiesIntro,
    hint: 'Shown above the list (also when it is empty).',
  },
  {
    key: 'LAB_RENTAL_INTRO', label: 'Lab rental page — introduction', group: 'Site texts & pages', type: 'text', multiline: true, default: T.labRentalIntro,
    hint: 'Shown above the list of facilities (also when it is empty).',
  },
  {
    key: 'BLOG_INTRO', label: 'Blog page — introduction', group: 'Site texts & pages', type: 'text', multiline: true, default: T.blogIntro,
    hint: 'Shown above the articles.',
  },
  {
    key: 'WIKI_INTRO', label: 'Wiki page — introduction', group: 'Site texts & pages', type: 'text', multiline: true, default: T.wikiIntro,
    hint: 'Shown above the articles.',
  },
  {
    key: 'NOT_FOUND_TITLE', label: '“Page not found” page — heading', group: 'Site texts & pages', type: 'string', default: SEO_TEXT_DEFAULTS.notFoundTitle,
    hint: 'Shown for an address that does not exist (or a listing that is no longer available), above a search box and links to the main pages.',
  },
  {
    key: 'NOT_FOUND_TEXT', label: '“Page not found” page — text', group: 'Site texts & pages', type: 'text', multiline: true, default: SEO_TEXT_DEFAULTS.notFoundText,
    hint: 'Under the heading above.',
  },
  // ── Documents & legal texts ────────────────────────────────────────────
  {
    key: 'LEGAL_TERMS_TEXT', label: 'Terms of Service (public page)', group: 'Documents & legal texts', type: 'text', multiline: true, default: DEFAULT_TERMS_TEXT,
    hint: 'The /legal/terms page. “## ” starts a heading, an empty line a new paragraph. The placeholders are filled from the other settings, so numbers never disagree:' + tokenHint(TERMS_TOKENS.join(', ')),
  },
];
