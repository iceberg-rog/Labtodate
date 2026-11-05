import type { SiteTextDef, SiteTextGroup } from './types';

/**
 * Built-in site content. Defaults are today's live wording, so switching to
 * the editable texts changes nothing a visitor sees until an admin edits.
 *
 * Claims default to the values the live server's .env had (WARRANTY_TEXT,
 * INSPECTION_TEXT, QUOTE_TURNAROUND); getSiteTexts() still prefers a set .env
 * value over these defaults until an admin saves the group. The footer
 * tagline and social links do the same (FOOTER_TAGLINE, SOCIAL_*).
 */

/** "Last updated" of a page whose texts were never saved in the admin: the date of these built-in texts. */
export const BUILT_IN_TEXTS_DATE = new Date(Date.UTC(2026, 10, 5, 12));

const PAGE_HINT =
  '“## Heading” starts a section, “- ” a bullet, **bold**, [label](/page) a link. {{support.contact}} is the support e-mail as a link (the contact page when no e-mail is set).';

const lines = (...l: string[]) => l.join('\n');

const TERMS = lines(
  'These terms govern use of {{site.name}}, operated by {{company.name_country}}. By using the site or placing an order you accept them.',
  '',
  '## 1. The marketplace',
  '{{site.name}} sells refurbished and surplus laboratory equipment sourced through its supply network. Listings, specifications and availability may change without notice.',
  '',
  '## 2. Quotes & proforma invoices',
  'A proforma invoice confirms a quoted price and is valid for {{rules.quote_valid_days}} days unless stated otherwise. It is not a tax invoice and not a demand for payment. An order is formed only when payment is completed or written acceptance is received.',
  '',
  '## 3. Pricing, taxes & payment',
  'Prices are shown excluding VAT unless stated. Applicable tax and shipping are added at checkout. Payment is processed by our payment provider; we do not store card details.',
  '',
  '## 4. Inspection & warranty',
  'Refurbished units are checked before shipping. Where a warranty applies, it covers functional defects for the term stated on the listing.',
  '',
  '## 5. Shipping & risk',
  'Items are crated and insured. Title and risk pass on delivery to the address you provide. Inspect on receipt and report discrepancies within {{rules.return_days}} days.',
  '',
  '## 6. Returns',
  'If an item materially differs from its description, contact {{support.contact}} within {{rules.return_days}} days of delivery for a resolution or refund under buyer protection.',
  '',
  '## 7. Liability',
  'To the extent permitted by law, liability is limited to the amount paid for the item. Equipment is sold for professional use; the buyer is responsible for safe installation, qualification and compliance.',
  '',
  '## 8. Contact',
  '{{company.name}} · {{support.contact}}',
);

const PRIVACY = lines(
  '{{company.name}} (“{{site.name}}”) is the data controller for personal data processed through this site. This policy explains what we collect and why.',
  '',
  '## Data we collect',
  '- Account data: name, email, password hash, role.',
  '- Transaction data: quotes, orders, invoices, shipping address, messages.',
  '- Technical data: minimal logs needed to operate and secure the service.',
  '',
  '## How we use it',
  'To provide the marketplace, process quotes and orders, send transactional emails and, where you have an account, service notifications and offers. We do not sell personal data.',
  '',
  '## Processors',
  'We use a payment provider (for checkout) and an email provider (for transactional and account email). They process data only to deliver these functions.',
  '',
  '## Retention',
  'Transaction and invoice records are kept as required by tax and accounting law; account data until you ask us to delete it.',
  '',
  '## Your rights',
  'You may request access, correction or deletion of your data, or object to processing, by emailing {{support.contact}}.',
  '',
  '## Contact',
  '{{company.name_address}} · {{support.contact}}',
);

const COOKIES = lines(
  '{{site.name}} uses only the cookies needed to make the site work — there is no third-party advertising or cross-site tracking.',
  '',
  '## Essential cookies',
  '- **Session / authentication** — keeps you signed in to your account.',
  '- **Security** — protects forms and sign-in against abuse.',
  '',
  'These are strictly necessary and cannot be disabled without breaking core functionality. We do not set analytics or marketing cookies by default.',
  '',
  '## Managing cookies',
  'You can clear or block cookies in your browser settings; note that sign-in will not work without the session cookie.',
  '',
  '## Contact',
  '{{support.contact}}',
);

const ABOUT = lines(
  '{{site.name}} is a marketplace for refurbished and surplus laboratory and analytical equipment — chromatography, mass spectrometry, spectroscopy and the parts that keep them running.',
  '',
  '## What we do',
  '- List refurbished and surplus instruments from a working supply network.',
  '- Ship worldwide — crated and insured.',
  '- Handle quotes, proforma invoices, payment and logistics end to end.',
  '',
  '## Why buyers transact with us',
  'You deal with {{site.name}} as a single accountable counterparty: one proforma, one invoice, one point of contact through delivery and after-sale support.',
  '',
  '## Contact',
  '{{company.name_address}}. Email {{support.contact}}.',
);

const FAQ = lines(
  '## Is the equipment tested?',
  'Yes. Each unit is checked before shipping; specific warranty terms are stated on the listing.',
  '',
  '## How does pricing work?',
  'Some items have a list price (buy now); others are quote-only. Request a quote and we send a proforma invoice with the price and terms.',
  '',
  '## Do you ship internationally?',
  'Yes — crated and insured, worldwide. Shipping and any tax are shown at checkout.',
  '',
  '## What payment methods are accepted?',
  'Card payment via our secure payment provider at checkout. For quote-based orders we issue a proforma and payment instructions.',
  '',
  '## Can I sell my equipment?',
  'Yes — submit it via [Sell equipment](/sell) for a free valuation within {{rules.sell_reply_time}}.',
  '',
  '## What if an item is not as described?',
  'Contact {{support.contact}} within {{rules.return_days}} days of delivery; buyer protection covers a resolution or refund.',
  '',
  '## How do I track my order?',
  "Sign in and open the order under [My orders](/app/orders) — you'll see the fulfillment status and tracking number once shipped.",
);

/** One legal / help page: title, optional subtitle, body. */
function pageGroup(id: string, label: string, page: string, title: string, body: string, subtitle?: string, extra: SiteTextDef[] = []): SiteTextGroup {
  return {
    id,
    label,
    page,
    description: '“Last updated” on the page shows the date this page was last saved here.',
    fields: [
      { key: `${id}.title`, label: 'Title', kind: 'text', default: title, max: 120, required: true },
      ...(subtitle !== undefined ? [{ key: `${id}.subtitle`, label: 'Subtitle', kind: 'text' as const, default: subtitle, max: 200 }] : []),
      { key: `${id}.body`, label: 'Page text', kind: 'page', default: body, hint: PAGE_HINT },
      ...extra,
    ],
  };
}

export const SITE_GROUPS: SiteTextGroup[] = [
  {
    id: 'claims',
    label: 'Claims & promises',
    page: '/marketplace',
    description: 'Promises made to every buyer. Switch a claim off and every sentence that uses it disappears — nothing is left half-written.',
    fields: [
      { key: 'claims.warranty_show', label: 'Show the warranty claim', kind: 'toggle', default: 'on' },
      { key: 'claims.warranty', label: 'Warranty claim', kind: 'text', default: '90-day warranty', max: 60, hint: 'Used in the product page, trust strip and marketplace subtitle, e.g. “90-day warranty”.' },
      { key: 'claims.inspection_show', label: 'Show the inspection claim', kind: 'toggle', default: 'on' },
      { key: 'claims.inspection', label: 'Inspection claim', kind: 'text', default: '14-point inspection', max: 60 },
      { key: 'claims.quote_turnaround_show', label: 'Show the quote response time', kind: 'toggle', default: 'on' },
      { key: 'claims.quote_turnaround', label: 'Quote response time', kind: 'text', default: '5 business days', max: 40, hint: 'e.g. “5 business days”. Shown as “Typical response within …”.' },
      { key: 'claims.quote_line', label: 'Product page: response line under “Request a quote”', kind: 'text', default: 'Typical response within {{claims.quote_turnaround}} from the supplier.', max: 160 },
      {
        key: 'claims.supplier_line',
        label: 'Product page: line under the supplier name',
        kind: 'text',
        default: 'Inspected & warrantied · ships worldwide',
        max: 120,
        needs: ['claims.inspection', 'claims.warranty'],
        hint: 'Disappears while the inspection or the warranty claim is off.',
      },
      { key: 'claims.inspection_section_show', label: 'Show the “Inspection & warranty” section on product pages', kind: 'toggle', default: 'on' },
      { key: 'claims.inspection_section_title', label: 'Section title', kind: 'text', default: 'Inspection & warranty', max: 80 },
      {
        key: 'claims.inspection_section_body',
        label: 'Section text',
        kind: 'rich',
        default: 'Every item passes a {{claims.inspection}} by qualified technicians — calibration verification, mechanical wear, and component-level diagnostics — and ships with a {{claims.warranty}} and buyer protection.',
        max: 1200,
        hint: 'A paragraph that uses a claim which is switched off is left out; with nothing left the section is hidden.',
      },
      { key: 'claims.trust_show', label: 'Show the trust strip on product pages', kind: 'toggle', default: 'on' },
      { key: 'claims.trust_1', label: 'Trust strip 1', kind: 'text', default: '{{claims.warranty}} | On all refurbished', max: 80, hint: 'Title | small line. Empty = item hidden.' },
      { key: 'claims.trust_2', label: 'Trust strip 2', kind: 'text', default: 'Worldwide shipping | Crated & insured', max: 80 },
      { key: 'claims.trust_3', label: 'Trust strip 3', kind: 'text', default: 'Buyer protection | Refund if not as described', max: 80 },
    ],
  },
  {
    id: 'rules',
    label: 'Response times & numbers',
    description: 'Numbers and promised times quoted on the site and in e-mails.',
    fields: [
      { key: 'rules.payment_verify_time', label: 'We check a payment within', kind: 'text', default: '1 business day', max: 40, required: true },
      { key: 'rules.contact_reply_time', label: 'We reply to contact messages within', kind: 'text', default: 'one business day', max: 40, required: true },
      { key: 'rules.support_reply_time', label: 'We reply to support tickets within', kind: 'text', default: '1 business day', max: 40, required: true },
      { key: 'rules.sell_reply_time', label: 'We reply to sell offers within', kind: 'text', default: '2 business days', max: 40, required: true },
      { key: 'rules.return_days', label: 'Days a buyer has to report a problem', kind: 'number', default: '7', min: 0, maxValue: 365 },
    ],
  },
  {
    id: 'nav',
    label: 'Menu & footer',
    description: '“Automatic” hides a section from the menu and footer while it has nothing published.',
    fields: (['blog', 'wiki', 'lab_rental', 'case_studies'] as const).map((k) => ({
      key: `nav.${k}`,
      label: { blog: 'Blog', wiki: 'Wiki', lab_rental: 'Lab rental', case_studies: 'Case studies' }[k],
      kind: 'select' as const,
      default: 'auto',
      options: [
        { value: 'auto', label: 'Automatic — only when something is published' },
        { value: 'show', label: 'Always show' },
        { value: 'hide', label: 'Hide' },
      ],
    })),
  },
  {
    id: 'footer',
    label: 'Footer & cookie banner',
    page: '/',
    fields: [
      { key: 'footer.tagline', label: 'Footer tagline', kind: 'text', default: 'B2B marketplace for laboratory and analytical equipment.', max: 200 },
      { key: 'footer.linkedin', label: 'LinkedIn page', kind: 'text', default: '', max: 300, format: 'url', hint: 'Full https:// address. Empty = no icon.' },
      { key: 'footer.twitter', label: 'X / Twitter page', kind: 'text', default: '', max: 300, format: 'url', hint: 'Full https:// address. Empty = no icon.' },
      { key: 'footer.github', label: 'GitHub page', kind: 'text', default: '', max: 300, format: 'url', hint: 'Full https:// address. Empty = no icon.' },
      { key: 'footer.copyright', label: 'Copyright line', kind: 'text', default: '© {{date.year}} {{site.name}}. All rights reserved.', max: 160 },
      {
        key: 'footer.cookie_text',
        label: 'Cookie banner text',
        kind: 'text',
        default: 'We use only essential cookies to keep you signed in and secure — no tracking or ads. [Cookie policy](/legal/cookies).',
        max: 400,
        required: true,
        hint: 'Shown once to every visitor. [label](/page) makes a link.',
      },
      { key: 'footer.cookie_button', label: 'Cookie banner button', kind: 'text', default: 'Got it', max: 30, required: true },
    ],
  },
  {
    id: 'marketplace',
    label: 'Marketplace',
    page: '/marketplace',
    fields: [
      { key: 'marketplace.title', label: 'Title', kind: 'text', default: 'All lab instruments', max: 80, required: true, hint: 'A selected category shows its own name instead.' },
      { key: 'marketplace.subtitle', label: 'Subtitle', kind: 'text', default: '{{stats.listings}} listings', max: 160, hint: 'Here {{stats.listings}} is the number of results for the current search and filters.' },
      {
        key: 'marketplace.subtitle_claim',
        label: 'Subtitle — claim part',
        kind: 'text',
        default: '{{claims.inspection}} on every refurbished unit',
        max: 160,
        hint: 'Added after the subtitle with “ · ”. Disappears while the inspection claim is off.',
      },
      {
        key: 'marketplace.featured_heading',
        label: 'Home page “Featured equipment” heading',
        kind: 'text',
        default: 'Hand-picked instruments. Inspected, warrantied, ready to ship.',
        max: 160,
        needs: ['claims.inspection', 'claims.warranty'],
        hint: 'Used while the inspection and warranty claims are on.',
      },
      { key: 'marketplace.featured_heading_plain', label: '… heading while the inspection or warranty claim is off', kind: 'text', default: 'Hand-picked instruments, ready to ship.', max: 160 },
    ],
  },
  {
    id: 'forms',
    label: 'Forms & sign-up',
    page: '/let-us-find-it',
    description: 'Headlines, helper texts and example placeholders of Let Us Find It, Sell, sign-up and sign-in.',
    fields: [
      { key: 'forms.find_badge', label: 'Let Us Find It — badge', kind: 'text', default: 'Concierge sourcing', max: 60 },
      { key: 'forms.find_title', label: 'Let Us Find It — headline', kind: 'text', default: 'Tell us what you need.', max: 100, required: true },
      { key: 'forms.find_title_accent', label: 'Let Us Find It — headline, coloured line', kind: 'text', default: "We'll find it.", max: 100 },
      {
        key: 'forms.find_intro',
        label: 'Let Us Find It — intro',
        kind: 'text',
        default: "Tell us the make, model or use-case and we'll come back with a quote within **{{claims.quote_turnaround}}**.",
        max: 300,
        hint: 'Used while the quote response time is on.',
      },
      { key: 'forms.find_intro_plain', label: 'Let Us Find It — intro while the quote response time is off', kind: 'text', default: "Tell us the make, model or use-case and we'll come back with a quote.", max: 300 },
      { key: 'forms.find_point1_title', label: 'Let Us Find It — point 1 title', kind: 'text', default: 'Quote turnaround', max: 60 },
      { key: 'forms.find_point1', label: 'Let Us Find It — point 1 text', kind: 'text', default: 'We come back as soon as we have something solid — within {{claims.quote_turnaround}}.', max: 200 },
      { key: 'forms.find_point1_plain', label: 'Let Us Find It — point 1 text while the quote response time is off', kind: 'text', default: 'We come back as soon as we have something solid.', max: 200 },
      { key: 'forms.find_point2_title', label: 'Let Us Find It — point 2 title', kind: 'text', default: 'Free for buyers', max: 60, hint: 'Empty title = point hidden.' },
      { key: 'forms.find_point2', label: 'Let Us Find It — point 2 text', kind: 'text', default: 'No commission until you accept a quote.', max: 200 },
      { key: 'forms.find_footer', label: 'Let Us Find It — line under the submit button', kind: 'text', default: 'Free for buyers · No commission until you accept a quote', max: 160 },
      { key: 'forms.find_ph_name', label: 'Let Us Find It — example name', kind: 'text', default: 'Dr. Jane Doe', max: 80 },
      { key: 'forms.find_ph_company', label: 'Let Us Find It — example company', kind: 'text', default: 'Pivot Park', max: 80 },
      { key: 'forms.find_ph_category', label: 'Let Us Find It — example equipment type', kind: 'text', default: 'e.g. confocal microscope', max: 80 },
      { key: 'forms.find_ph_budget', label: 'Let Us Find It — example budget', kind: 'text', default: '€20k – €30k', max: 80 },
      { key: 'forms.find_ph_timeframe', label: 'Let Us Find It — example timeframe', kind: 'text', default: 'Within 4 weeks', max: 80 },

      { key: 'forms.sell_badge', label: 'Sell — badge', kind: 'text', default: 'Sell to {{site.name}}', max: 60 },
      { key: 'forms.sell_title', label: 'Sell — headline', kind: 'text', default: 'Turn idle instruments into', max: 100, required: true },
      { key: 'forms.sell_title_accent', label: 'Sell — headline, coloured part', kind: 'text', default: 'working capital.', max: 100 },
      {
        key: 'forms.sell_intro',
        label: 'Sell — intro',
        kind: 'text',
        default: "Whether you're an individual, a lab, a dealer, or an institution clearing a facility — submit your equipment and our acquisitions team comes back with a valuation. No listing fees, no guesswork.",
        max: 400,
      },
      { key: 'forms.sell_stat1_value', label: 'Sell — figure 1', kind: 'text', default: '0%', max: 20, hint: 'Empty = figure hidden.' },
      { key: 'forms.sell_stat1_label', label: 'Sell — figure 1 caption', kind: 'text', default: 'Listing fees', max: 60 },
      { key: 'forms.sell_stat2_value', label: 'Sell — figure 2', kind: 'text', default: 'Global', max: 20 },
      { key: 'forms.sell_stat2_label', label: 'Sell — figure 2 caption', kind: 'text', default: 'Logistics handled for you', max: 60 },
      { key: 'forms.sell_stat3_value', label: 'Sell — figure 3', kind: 'text', default: 'One', max: 20 },
      { key: 'forms.sell_stat3_label', label: 'Sell — figure 3 caption', kind: 'text', default: 'Accountable counterparty', max: 60 },
      { key: 'forms.sell_step2', label: 'Sell — step 2 “Free valuation” text', kind: 'text', default: 'Our acquisitions team replies within {{rules.sell_reply_time}} with a market-based valuation.', max: 200 },
      { key: 'forms.sell_footer', label: 'Sell — line under the submit button', kind: 'text', default: 'Free valuation · No obligation · We reply within {{rules.sell_reply_time}}', max: 160 },
      {
        key: 'forms.sell_thanks',
        label: 'Sell — confirmation page text',
        kind: 'text',
        default: "We've emailed you a confirmation. Our acquisitions team will review your equipment and reply with a free valuation within **{{rules.sell_reply_time}}**.",
        max: 400,
      },

      { key: 'forms.signup_title', label: 'Sign-up — heading', kind: 'text', default: 'Create your account', max: 80, required: true },
      { key: 'forms.signup_intro', label: 'Sign-up — helper text', kind: 'text', default: 'Browse {{stats.listings}} instruments, request quotes, and track orders — all in one place.', max: 200 },
      { key: 'forms.signup_intro_empty', label: 'Sign-up — helper text while nothing is listed', kind: 'text', default: 'Browse lab instruments, request quotes, and track orders — all in one place.', max: 200 },
      { key: 'forms.signup_ph_name', label: 'Sign-up — example name', kind: 'text', default: 'Dr. Jane Doe', max: 80 },
      { key: 'forms.signup_email_label', label: 'Sign-up — e-mail label', kind: 'text', default: 'Work email', max: 40, required: true },
      { key: 'forms.signup_ph_email', label: 'Sign-up — example e-mail', kind: 'text', default: 'you@university.edu', max: 80 },
      { key: 'forms.signin_title', label: 'Sign-in — heading', kind: 'text', default: 'Welcome back', max: 80, required: true },
      { key: 'forms.signin_intro', label: 'Sign-in — helper text', kind: 'text', default: 'Sign in to your {{site.name}} account.', max: 200 },
      { key: 'forms.signin_ph_email', label: 'Sign-in — example e-mail', kind: 'text', default: 'you@company.com', max: 80 },
    ],
  },
  {
    id: 'page_contact',
    label: 'Page: Contact',
    page: '/contact',
    description: 'The address, phone and VAT number come from Settings → Company.',
    fields: [
      { key: 'page_contact.title', label: 'Title', kind: 'text', default: 'Contact us', max: 80, required: true },
      { key: 'page_contact.intro', label: 'Reply-time sentence', kind: 'text', default: 'We reply within {{rules.contact_reply_time}}.', max: 200 },
      { key: 'page_contact.general_label', label: 'E-mail block heading', kind: 'text', default: 'General & support', max: 60 },
      { key: 'page_contact.sell_label', label: 'Sell block heading', kind: 'text', default: 'Sell equipment', max: 60, hint: 'Empty heading = block hidden.' },
      { key: 'page_contact.sell_text', label: 'Sell block text', kind: 'text', default: 'Free valuation via [Sell equipment](/sell).', max: 200 },
      { key: 'page_contact.find_label', label: 'Sourcing block heading', kind: 'text', default: 'Need a specific item?', max: 60, hint: 'Empty heading = block hidden.' },
      { key: 'page_contact.find_text', label: 'Sourcing block text', kind: 'text', default: '[Let us find it](/let-us-find-it).', max: 200 },
      { key: 'page_contact.office_label', label: 'Company block heading', kind: 'text', default: 'Registered office', max: 60, required: true },
      { key: 'page_contact.form_intro', label: 'Line above the message form', kind: 'text', default: "Send us a message — we'll open a tracked ticket.", max: 200 },
    ],
  },
  pageGroup('page_terms', 'Page: Terms of Service', '/legal/terms', 'Terms of Service', TERMS),
  pageGroup('page_privacy', 'Page: Privacy Policy', '/legal/privacy', 'Privacy Policy', PRIVACY),
  pageGroup('page_cookies', 'Page: Cookie Policy', '/legal/cookies', 'Cookie Policy', COOKIES),
  pageGroup('page_about', 'Page: About', '/about', 'About {{site.name}}', ABOUT, 'The marketplace for laboratory & analytical instruments.'),
  pageGroup('page_faq', 'Page: FAQ', '/faq', 'Frequently asked questions', FAQ),
];

export function siteGroup(id: string): SiteTextGroup | undefined {
  return SITE_GROUPS.find((g) => g.id === id);
}

export function siteDef(key: string) {
  for (const g of SITE_GROUPS) {
    const d = g.fields.find((f) => f.key === key);
    if (d) return { group: g, def: d };
  }
  return null;
}
