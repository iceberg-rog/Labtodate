/**
 * Homepage modules + copy (Admin → Homepage).
 *
 * Since the 2026-10 redesign the homepage follows the Shelter landing
 * structure: pinned scroll stations, each a full screen whose 3D moves with
 * the scroll — intro (particle word), hero (chrome molecule), categories
 * (structural-formula column + card helix), suppliers (globe route), process
 * (live buying-panel demo), ways (ways to buy) and cta (particle outro).
 * The four older content modules still exist as optional extras, off by
 * default; switched on they render after the stations as ordinary sections.
 *
 * Every station, item, text, button label and link is a registry setting
 * (HOME_FIELDS below → src/lib/home/settings-defs.ts → the settings registry),
 * so each change has validation, Change history and Revert. A few keys keep
 * the names they were saved under before the registry (HERO_*, HOMEPAGE_POPULAR,
 * TEST_*, CTA_*): renaming them would drop the values already saved.
 *
 * Pure module (no DB, no settings import): readers take a `read(key)` function —
 * the live values (process.env after ensureSettingsLoaded) or a draft overlay.
 */
export const HOME_STATIONS = ['intro', 'hero', 'categories', 'suppliers', 'process', 'ways', 'cta'] as const;
export const HOME_EXTRAS = ['trustbar', 'featured', 'blog', 'testimonials'] as const;
export const HOME_SECTIONS = [...HOME_STATIONS, ...HOME_EXTRAS] as const;

export type HomeSection = (typeof HOME_SECTIONS)[number];
export type HomeStation = (typeof HOME_STATIONS)[number];
export type HomeExtra = (typeof HOME_EXTRAS)[number];
export const isStation = (s: HomeSection): s is HomeStation => (HOME_STATIONS as readonly string[]).includes(s);
export const isExtra = (s: string): s is HomeExtra => (HOME_EXTRAS as readonly string[]).includes(s);

export const HOME_SECTION_LABEL: Record<HomeSection, string> = {
  intro: 'Intro (particle word)',
  hero: 'Hero + search (chrome molecule)',
  categories: 'Instruments (formula column + cards)',
  suppliers: 'Route (globe)',
  process: 'Buying, live demo',
  ways: 'Ways to buy',
  cta: 'Sourcing call to action (particle word)',
  trustbar: 'Extra — Trust bar (brands)',
  featured: 'Extra — Featured products',
  blog: 'Extra — Blog teasers',
  testimonials: 'Extra — Testimonials',
};

/** Extras saved before the registry (HOMEPAGE_SECTIONS) count only with this version marker. */
export const HOME_ORDER_VERSION = '3';
/** Keys of the pre-registry extras list; removed when the homepage is published from the editor. */
export const HOME_LEGACY_KEYS = ['HOMEPAGE_SECTIONS', 'HOMEPAGE_SECTIONS_V'] as const;

/** Reads one setting: '' when unset (the homepage then uses the field's default). */
export type HomeRead = (key: string) => string;
/** The live values (call ensureSettingsLoaded first). */
export const envRead: HomeRead = (k) => (process.env[k] ?? '').replace(/\r\n/g, '\n').trim();

// ── the fields ───────────────────────────────────────────────────────────────

export type HomeFieldGroup =
  | 'layout' | 'intro' | 'hero' | 'categories' | 'route' | 'demo' | 'ways' | 'cta' | 'featured' | 'trustbar' | 'blog' | 'testimonials';
/** line: one line · text: several lines · link: "Label|/link" · list: comma-separated · int: whole number */
export type HomeFieldKind = 'line' | 'text' | 'link' | 'list' | 'int';
/** Fields edited by a picker of their own on Admin → Homepage instead of a text box. */
export type HomePicker = 'stations' | 'rail' | 'extras' | 'categories' | 'product' | 'products';

export interface HomeField {
  key: string;
  label: string;
  group: HomeFieldGroup;
  kind: HomeFieldKind;
  default: string;
  hint?: string;
  picker?: HomePicker;
  min?: number;
  max?: number;
}

export const HOME_GROUP_TITLE: Record<HomeFieldGroup, string> = {
  layout: 'Stations & modules',
  intro: 'Intro',
  hero: 'Hero',
  categories: 'Instruments',
  route: 'Route (globe)',
  demo: 'Buying demo',
  ways: 'Ways to buy',
  cta: 'Call to action',
  featured: 'Extra — Featured products',
  trustbar: 'Extra — Trust bar',
  blog: 'Extra — Blog teasers',
  testimonials: 'Extra — Testimonials',
};

/** The station each text group belongs to (the editor shows the group under its station). */
export const HOME_GROUP_SECTION: Partial<Record<HomeFieldGroup, HomeSection>> = {
  intro: 'intro', hero: 'hero', categories: 'categories', route: 'suppliers', demo: 'process', ways: 'ways', cta: 'cta',
  featured: 'featured', trustbar: 'trustbar', blog: 'blog', testimonials: 'testimonials',
};

const lines = (...l: string[]) => l.join('\n');
const SITE_HINT = ' {SITE} is replaced by the site name (Settings → Brand).';
const LINK_HINT = 'Label|/link — the link is a page of this site (/…) or an https:// address.';

export const HOME_FIELDS: readonly HomeField[] = [
  // ── layout ──
  { key: 'HOME_STATIONS', label: 'Stations shown, in order', group: 'layout', kind: 'list', picker: 'stations',
    default: HOME_STATIONS.join(','),
    hint: 'The 3D stations shown on the homepage, in order (intro, hero, categories, suppliers, process, ways, cta). A station left out is hidden; the intro opens the page, so when shown it stays first.' },
  { key: 'HOME_RAIL_NAMES', label: 'Section rail labels', group: 'layout', kind: 'text', picker: 'rail',
    default: lines('intro|INTRO', 'hero|MARKET', 'categories|INSTRUMENTS', 'suppliers|ROUTE', 'process|BUYING', 'ways|WAYS TO BUY', 'cta|SOURCE'),
    hint: 'One per line: station|label — the names in the section rail on the right and in the top frame (“SEC 01 // …”).' },
  { key: 'HOME_EXTRAS', label: 'Extra modules below the stations', group: 'layout', kind: 'list', picker: 'extras', default: '',
    hint: 'Modules shown after the stations, in order: trustbar, featured, blog, testimonials. Empty = none.' },
  { key: 'HOME_HUD_META', label: 'Line in the top frame', group: 'layout', kind: 'line', default: '{SITE}//MOLECULAR ANALYSIS',
    hint: 'The small line in the top-left corner of the frame.' + SITE_HINT },

  // ── intro ──
  { key: 'HOME_INTRO_WORD', label: 'Particle word', group: 'intro', kind: 'line', default: '', hint: 'The word drawn in particles. Empty = the site name.' },
  { key: 'HOME_INTRO_TAGLINE', label: 'Line under it', group: 'intro', kind: 'line', default: '{SITE} — the marketplace for used laboratory equipment',
    hint: 'The line under the particle word.' + SITE_HINT },
  { key: 'HOME_INTRO_SCROLL', label: 'Scroll hint', group: 'intro', kind: 'line', default: 'SCROLL TO ENTER', hint: 'The hint next to the mouse icon (links to the next station).' },
  { key: 'HOME_TOUR', label: 'Auto tour', group: 'intro', kind: 'line', default: 'Auto tour|Scroll or tap to take over',
    hint: 'Button label|line in the tour bar. The tour plays the stations by itself after a few idle seconds.' },

  // ── hero (keys saved before the registry keep their names) ──
  { key: 'HERO_BADGE', label: 'Badge', group: 'hero', kind: 'line', default: 'Used laboratory equipment', hint: 'The small label over the hero title.' },
  { key: 'HERO_TITLE', label: 'Title', group: 'hero', kind: 'line', default: 'The marketplace for', hint: 'The hero title (the main heading of the page).' },
  { key: 'HERO_ACCENT', label: 'Title — accent word', group: 'hero', kind: 'line', default: 'science.', hint: 'Shown after the title in the accent colour.' },
  { key: 'HERO_SUBTITLE', label: 'Subtitle', group: 'hero', kind: 'text',
    default: 'Buy used laboratory equipment online, or request a written quote — every order with a proforma and a VAT invoice.',
    hint: 'The paragraph under the hero title.' },
  { key: 'HOME_HERO_SEARCH', label: 'Search placeholder', group: 'hero', kind: 'line', default: '',
    hint: 'Grey text in the search box. Empty = “Try ‘…’ or ‘…’…” built from the popular searches below.' },
  { key: 'HOME_HERO_BROWSE', label: 'Button next to the search', group: 'hero', kind: 'link', default: 'Browse|/marketplace', hint: LINK_HINT },
  { key: 'HOME_HERO_SOURCE', label: 'Sourcing button', group: 'hero', kind: 'link', default: 'Can’t find it? Let us source it|/let-us-find-it', hint: LINK_HINT },
  { key: 'HOME_HERO_SELL', label: 'Sell link', group: 'hero', kind: 'link', default: 'Sell your equipment →|/sell', hint: LINK_HINT },
  { key: 'HOMEPAGE_POPULAR', label: 'Popular searches', group: 'hero', kind: 'list', default: 'HPLC,Gas Chromatography,Mass Spec,Autosampler,Agilent',
    hint: 'Comma-separated. Each becomes a search link under the hero; a term the marketplace would find nothing for is hidden.' },
  { key: 'HERO_STATS', label: 'Stats', group: 'hero', kind: 'text', default: '',
    hint: 'One per line — value|suffix|label (e.g. 12400|+|instruments listed). Empty = live counts from the catalogue.' },
  { key: 'HOME_STAT_LABELS', label: 'Labels of the live counts', group: 'hero', kind: 'text',
    default: lines('instrument listed|instruments listed', 'supplier onboarded|suppliers onboarded', 'country we source from|countries we source from'),
    hint: 'Three lines (listings, suppliers with a signed agreement, countries), each singular|plural. Used while Stats is empty; a count of 0 is not shown.' },

  // ── categories ──
  { key: 'HOME_CAT_ITEMS', label: 'Categories on the station', group: 'categories', kind: 'text', picker: 'categories', default: '',
    hint: 'One per line: category-slug|label|image|link. Label empty = the category name; image empty = the category picture (Admin → Categories), else its best listing photo; image product:<slug> = that listing’s photo; link empty = the category page, product:<slug> = that listing. Empty = automatic: the categories marked “show on homepage”, in their homepage order, then by live listings. A category without live listings is not shown.' },
  { key: 'HOME_CAT_MAX', label: 'Cards when automatic', group: 'categories', kind: 'int', default: '9', min: 1, max: 12,
    hint: 'How many categories the station shows while the list above is empty (1–12).' },
  { key: 'HOME_CAT_TITLE', label: 'Question', group: 'categories', kind: 'line', default: 'Which instrument', hint: 'The heading over the category list.' },
  { key: 'HOME_CAT_ACCENT', label: 'Question — accent part', group: 'categories', kind: 'line', default: 'are you looking for?', hint: 'Shown after the question in the accent colour.' },
  { key: 'HOME_CAT_OPEN', label: 'Open link under the list', group: 'categories', kind: 'line', default: 'Browse {NAME}',
    hint: 'The link to the category in focus; {NAME} is its name.' },
  { key: 'HOME_CAT_COUNT', label: 'Count on the cards', group: 'categories', kind: 'line', default: '{N} listing|{N} listings',
    hint: 'singular|plural; {N} is the number of live listings of the category.' },
  { key: 'HOME_CAT_ALL_TITLE', label: 'Tile 1', group: 'categories', kind: 'link', default: 'All categories|/marketplace', hint: 'Title|/link of the first tile.' },
  { key: 'HOME_CAT_ALL_SUB', label: 'Tile 1 line', group: 'categories', kind: 'line', default: '{N} listings', hint: '{N} = live listings.' },
  { key: 'HOME_CAT_ASK_TITLE', label: 'Tile 2', group: 'categories', kind: 'link', default: 'Not in the list?|/let-us-find-it', hint: 'Title|/link of the second tile.' },
  { key: 'HOME_CAT_ASK_SUB', label: 'Tile 2 line', group: 'categories', kind: 'line', default: 'Ask us to source it', hint: 'The line under the second tile’s title.' },

  // ── route ──
  { key: 'HOME_NET_TITLE', label: 'Heading', group: 'route', kind: 'line', default: 'The route of an instrument,', hint: 'The heading next to the globe.' },
  { key: 'HOME_NET_ACCENT', label: 'Heading — accent part', group: 'route', kind: 'line', default: 'through {SITE}.', hint: 'Shown after the heading in the accent colour.' + SITE_HINT },
  { key: 'HOME_NET_SUBTITLE', label: 'Text', group: 'route', kind: 'text',
    default: 'One accountable counterparty from your request to your lab — quote, proforma, payment and shipping.', hint: 'The paragraph under the heading.' },
  { key: 'HOME_NET_STEPS', label: 'Story beats', group: 'route', kind: 'text',
    default: lines('Your request|Tell us the instrument you need', 'Sourcing|We search our supply network', 'Offer|A written offer you accept first', 'Delivery|Shipped to your lab once the proforma is paid'),
    hint: 'Four lines, Title|short line — lit one by one as the globe story plays.' },
  { key: 'HOME_NET_HUB', label: 'Globe hub', group: 'route', kind: 'line', default: '',
    hint: 'name|latitude|longitude of the hub on the globe. Empty = the site name and the issuing city (Settings → Company) at that city.' },
  { key: 'HOME_NET_LANES', label: 'Globe lanes', group: 'route', kind: 'text',
    default: lines('NYC|40.71|-74.00', 'GRU|-23.55|-46.63', 'MAD|40.42|-3.70', 'STO|59.33|18.07', 'IST|41.01|28.97', 'CAI|30.04|31.24', 'DXB|25.20|55.27', 'BOM|19.08|72.88', 'JNB|-26.20|28.05'),
    hint: 'One per line: CODE|latitude|longitude. A drawing only — no shipping promise is shown unless Catalog & claims has one.' },
  { key: 'HOME_NET_LABS', label: 'Globe label at the labs', group: 'route', kind: 'line', default: 'Your lab', hint: 'Shown over the cluster of labs the requests come from.' },

  // ── demo ──
  { key: 'HOME_DEMO_PRODUCT', label: 'Listing in the demo', group: 'demo', kind: 'line', picker: 'product', default: '',
    hint: 'Slug of the live listing the demo shows (as sample data). Empty = the newest live listing with a photo.' },
  { key: 'HOME_DEMO_TITLE', label: 'Heading', group: 'demo', kind: 'line', default: 'Buying, step by step,', hint: 'The heading next to the demo.' },
  { key: 'HOME_DEMO_ACCENT', label: 'Heading — accent part', group: 'demo', kind: 'line', default: 'in your account.', hint: 'Shown after the heading in the accent colour.' },
  { key: 'HOME_DEMO_LEAD', label: 'Text', group: 'demo', kind: 'text',
    default: 'Every quote, offer, proforma and shipment sits in one place — and nothing is ordered until you accept the offer.', hint: 'The paragraph under the heading.' },
  { key: 'HOME_DEMO_BULLETS', label: 'Bullets', group: 'demo', kind: 'text',
    default: lines('Request a quote|on any listing, or for anything we do not list', 'Accept the offer|an itemised written offer, no surprises', 'Pay the proforma|the VAT invoice follows your payment', 'Follow the shipment|its status in your account'),
    hint: 'One per line: bold part|rest (up to five).' },
  { key: 'HOME_DEMO_CTA', label: 'Button', group: 'demo', kind: 'link', default: 'Create your account|/auth/sign-up', hint: LINK_HINT },
  { key: 'HOME_DEMO_NOTE', label: 'Note under the demo', group: 'demo', kind: 'line', default: 'Sample data — your real quotes live in your account.',
    hint: 'Says that the panel shows sample data. Keep it: the demo is not a real quote.' },
  { key: 'HOME_DEMO_NAV', label: 'Demo menu', group: 'demo', kind: 'list', default: 'Dashboard,Quotes,Orders,Messages',
    hint: 'The menu of the sample account panel, comma-separated; the second item is shown selected.' },
  { key: 'HOME_DEMO_REF', label: 'Sample quote number', group: 'demo', kind: 'line', default: 'QUOTE Q-2026-0142', hint: 'The reference over the listing title in the demo.' },
  { key: 'HOME_DEMO_SAMPLE', label: 'Title without a listing', group: 'demo', kind: 'line', default: 'Sample instrument',
    hint: 'The title the demo shows while no live listing has a photo.' },
  { key: 'HOME_DEMO_STEPS', label: 'Timeline', group: 'demo', kind: 'text',
    default: lines(
      'Requested|Quote requested|You asked for this instrument|',
      'Offer received|Offer received|Itemised written offer|Offer received — itemised written offer',
      'Accepted|Offer accepted|Proforma issued — nothing is ordered before this|Offer accepted — proforma issued',
      'Paid|Proforma paid|VAT invoice issued|Proforma paid — VAT invoice issued',
      'Shipped|Shipped|On its way to your lab|Shipped',
    ),
    hint: 'Five lines, one per step the demo plays: status|step|line|message that pops up (may be empty). Keep it in the real order: offer, acceptance, proforma, payment and VAT invoice, shipment.' },
  { key: 'HOME_DEMO_OFFER', label: 'Offer rows', group: 'demo', kind: 'text',
    default: lines('Instrument as listed|1 ×', 'Freight|quoted separately ({INCOTERM})', 'Offer total|sample'),
    hint: 'One per line: label|value, the last line is the total. {INCOTERM} = the default Incoterm (Quotes & offers).' },
  { key: 'HOME_DEMO_BUTTONS', label: 'Offer buttons', group: 'demo', kind: 'line', default: 'Accept offer|Ask a question', hint: 'accept button|second button of the sample offer.' },

  // ── ways ──
  { key: 'HOME_WAYS_TITLE', label: 'Heading', group: 'ways', kind: 'line', default: 'Choose', hint: 'The heading over the ways to buy.' },
  { key: 'HOME_WAYS_ACCENT', label: 'Heading — accent part', group: 'ways', kind: 'line', default: 'how you buy.', hint: 'Shown after the heading in the accent colour.' },
  { key: 'HOME_WAYS_LEAD', label: 'Text', group: 'ways', kind: 'text',
    default: 'Four ways to get an instrument into your lab — all through one accountable counterparty.', hint: 'The paragraph under the heading.' },
  { key: 'HOME_WAYS_ITEMS', label: 'Tabs', group: 'ways', kind: 'text',
    default: lines(
      'Buy now|Listed price|Instruments with a listed price can be ordered straight away.|Order at the listed price;Proforma and VAT invoice;Follow it in your account|Browse the marketplace|/marketplace',
      'Request a quote|Written offer|Ask for a quote on any listing — nothing is ordered until you accept the offer.|Itemised written offer;You accept before anything is ordered;Pay against the proforma|Request a quote|/marketplace',
      'Let us find it|Sourcing|Discontinued or rare? Tell us what you need and we search our supply network.|Tell us the model or the specs;We search our supply network;You decide on every offer|Submit a sourcing request|/let-us-find-it',
      'Sell to us|Acquisitions|Surplus instruments in your lab? Send us the details and we reply with an offer.|Send photos and details;We review and reply;{SELL_SHIPPING}|Sell your equipment|/sell',
    ),
    hint: 'Up to four lines: Title|Tag|Text|bullet;bullet;bullet|Button|/link. {SELL_SHIPPING} follows Acquisitions → “Who ships equipment to you” (“You ship it to our warehouse” or “We arrange the collection”).' },
  { key: 'HOME_WAYS_START', label: 'Tab open at first', group: 'ways', kind: 'int', default: '1', min: 1, max: 4,
    hint: 'Which tab is open when the page loads (1 = the first). With one way the tabs are hidden and its card is shown.' },
  { key: 'HOME_WAYS_CHIPS', label: 'Chips under the card', group: 'ways', kind: 'line', default: 'Proforma before payment, VAT invoice with every order, Everything in your account',
    hint: 'Comma-separated. Only what is true for every order.' },

  // ── cta ──
  { key: 'HOME_OUTRO_WORD', label: 'Particle word', group: 'cta', kind: 'line', default: 'SOURCED.', hint: 'Shown above the sourcing call to action.' },
  { key: 'CTA_HEADING', label: 'Heading', group: 'cta', kind: 'line', default: 'Discontinued. Rare. Out of budget. We try to find it.',
    hint: 'The closing heading; its last sentence is shown in the accent colour.' },
  { key: 'CTA_SUBTITLE', label: 'Text', group: 'cta', kind: 'text', default: 'Tell us what you need. We search our supply network and reply with what we find.',
    hint: 'The paragraph under the closing heading.' },
  { key: 'HOME_CTA_PRIMARY', label: 'Main button', group: 'cta', kind: 'link', default: 'Submit a sourcing request|/let-us-find-it', hint: LINK_HINT },
  { key: 'HOME_CTA_SECONDARY', label: 'Second button', group: 'cta', kind: 'link', default: 'Talk to sales|/contact', hint: LINK_HINT },

  // ── extras ──
  { key: 'HOME_FEATURED_PRODUCTS', label: 'Listings', group: 'featured', kind: 'list', picker: 'products', default: '',
    hint: 'Slugs of up to eight live listings, comma-separated, in order. Empty = the eight newest live listings.' },
  { key: 'HOME_FEATURED_KICKER', label: 'Label', group: 'featured', kind: 'line', default: 'From the catalogue', hint: 'The small label over the heading.' },
  { key: 'HOME_FEATURED_TITLE', label: 'Heading', group: 'featured', kind: 'line', default: 'Instruments available now.', hint: 'The heading of the module.' },
  { key: 'HOME_FEATURED_BUTTON', label: 'Button', group: 'featured', kind: 'link', default: 'Browse all {N}|/marketplace', hint: '{N} = live listings. ' + LINK_HINT },
  { key: 'HOME_TRUST_LABEL', label: 'Label', group: 'trustbar', kind: 'line', default: 'Brands in our catalogue', hint: 'The line over the brand names (brands with live listings).' },
  { key: 'HOME_BLOG_KICKER', label: 'Label', group: 'blog', kind: 'line', default: 'Field notes', hint: 'The small label over the heading.' },
  { key: 'HOME_BLOG_TITLE', label: 'Heading', group: 'blog', kind: 'line', default: 'What lab managers wish they knew before buying.', hint: 'The heading of the module.' },
  { key: 'HOME_BLOG_BUTTON', label: 'Button', group: 'blog', kind: 'link', default: 'All articles|/blog', hint: LINK_HINT },
  { key: 'HOME_BLOG_READ', label: 'Reading time', group: 'blog', kind: 'line', default: '{N} min read', hint: '{N} = the article’s reading time in minutes.' },
  { key: 'TEST_HEADING', label: 'Heading', group: 'testimonials', kind: 'line', default: 'What buyers say.', hint: 'The heading of the testimonials module.' },
  { key: 'TEST_META', label: 'Line next to the stars', group: 'testimonials', kind: 'line', default: '', hint: 'Short line next to the stars. Empty = none.' },
];

const FIELD = new Map(HOME_FIELDS.map((f) => [f.key, f]));
export const HOME_KEYS: readonly string[] = HOME_FIELDS.map((f) => f.key);
export const homeField = (key: string): HomeField | undefined => FIELD.get(key);
export const isHomeKey = (key: string): boolean => FIELD.has(key);

/** A field's value: what `read` returns, else its default. */
export function homeValue(read: HomeRead, key: string): string {
  return read(key) || (FIELD.get(key)?.default ?? '');
}

// ── parsers (pure) ───────────────────────────────────────────────────────────

export interface HomeStat {
  value: number;
  suffix: string;
  label: string;
}

/** Parse "12400|+|instruments listed" lines. Returns null when nothing
 *  usable is set — callers then show LIVE catalogue counts, never zero
 *  placeholders. */
export function parseHeroStats(raw: string | undefined): HomeStat[] | null {
  if (!raw?.trim()) return null;
  const out: HomeStat[] = [];
  for (const line of raw.split('\n')) {
    const [v, suf, ...rest] = line.split('|');
    const value = parseInt((v || '').replace(/[^0-9]/g, ''), 10);
    const label = rest.join('|').trim();
    if (Number.isFinite(value) && label) out.push({ value, suffix: (suf || '').trim(), label });
  }
  return out.length ? out : null;
}

export interface GeoPoint {
  label: string;
  lat: number;
  lon: number;
}

/** "NAME|lat|lon" lines → points; invalid lines are skipped. */
export function parseGeoLines(raw: string): GeoPoint[] {
  const out: GeoPoint[] = [];
  for (const line of raw.split('\n')) {
    const [label, la, lo] = line.split('|').map((s) => s?.trim() ?? '');
    const lat = Number(la), lon = Number(lo);
    if (label && la && lo && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push({ label: label.slice(0, 40), lat, lon });
  }
  return out;
}

export interface TitleLine {
  title: string;
  text: string;
}

/** "Title|line" lines → items (max `max`). */
export function parseTitleLines(raw: string, max = 6): TitleLine[] {
  return raw
    .split('\n')
    .map((l) => l.split('|'))
    .filter(([t]) => t?.trim())
    .slice(0, max)
    .map(([t, ...rest]) => ({ title: t.trim(), text: rest.join('|').trim() }));
}

export interface WayItem {
  title: string;
  tag: string;
  text: string;
  bullets: string[];
  cta: string;
  href: string;
}

/** A link that may be followed: a page of this site ("/…", not "//host") or an https:// address. */
export function isSafeHref(raw: string): boolean {
  const v = raw.trim();
  return /^\/(?![/\\])[^\s]*$/.test(v) || /^https:\/\/[^\s]+$/.test(v);
}

/** Only site-relative links (or https) are accepted for buttons. */
export function safeHref(raw: string, fallback = '/marketplace'): string {
  return isSafeHref(raw) ? raw.trim() : fallback;
}

export function parseWays(raw: string): WayItem[] {
  return raw
    .split('\n')
    .map((l) => l.split('|').map((s) => s.trim()))
    .filter(([t]) => t)
    .slice(0, 4)
    .map(([title, tag = '', text = '', bullets = '', cta = '', href = '']) => ({
      title,
      tag,
      text,
      bullets: bullets.split(';').map((b) => b.trim()).filter(Boolean).slice(0, 4),
      cta: cta || title,
      href: safeHref(href),
    }));
}

/** "Label|/link" → [label, href]. */
export function parseCta(raw: string, fallback: [string, string]): [string, string] {
  const [l, h] = raw.split('|').map((s) => s?.trim() ?? '');
  return l ? [l, safeHref(h || fallback[1], fallback[1])] : fallback;
}

/** "a|b" lines → pairs (missing parts empty). */
export function parsePairs(raw: string): [string, string][] {
  return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [a, ...rest] = l.split('|');
    return [a.trim(), rest.join('|').trim()];
  });
}

/** "singular|plural" with {N} → the text for `n`. */
export function countText(raw: string, n: number): string {
  const [one, many] = raw.split('|').map((s) => s.trim());
  const t = n === 1 ? one || many || '' : many || one || '';
  return t.replaceAll('{N}', n.toLocaleString('en-US'));
}

export interface DemoStep {
  status: string;
  title: string;
  text: string;
  toast: string;
}

/** The demo's five steps ("status|step|line|toast"); a missing line keeps the default's. */
export function parseDemoSteps(raw: string): DemoStep[] {
  const parse = (s: string) => s.split('\n').filter((l) => l.trim()).map((l) => {
    const [status = '', title = '', text = '', toast = ''] = l.split('|').map((x) => x.trim());
    return { status: status || title, title: title || status, text, toast };
  });
  const own = parse(raw);
  const def = parse(FIELD.get('HOME_DEMO_STEPS')!.default);
  return def.map((d, i) => own[i] ?? d);
}

/** Search placeholder built from the popular terms (which the home page has
 *  already checked return results), instead of examples we may not stock. */
export function searchPlaceholderFor(popular: string[]): string {
  const [a, b] = popular;
  if (a && b) return `Try ‘${a}’ or ‘${b}’…`;
  if (a) return `Try ‘${a}’…`;
  return 'Search instruments, brands, part numbers…';
}

/** The stations to show, in order: known names only, each once, the intro first when shown. */
export function parseStations(raw: string): HomeStation[] {
  const list = [...new Set(raw.split(',').map((s) => s.trim()).filter((s): s is HomeStation => (HOME_STATIONS as readonly string[]).includes(s)))];
  if (!list.length) return [...HOME_STATIONS];
  return list.includes('intro') ? ['intro', ...list.filter((s) => s !== 'intro')] : list;
}

export function parseExtras(raw: string): HomeExtra[] {
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(isExtra))];
}

/** "station|LABEL" lines → the rail label of every station (missing ones keep the default). */
export function parseRailNames(raw: string): Record<HomeStation, string> {
  const out = Object.fromEntries(parsePairs(FIELD.get('HOME_RAIL_NAMES')!.default)) as Record<HomeStation, string>;
  for (const [s, name] of parsePairs(raw)) if ((HOME_STATIONS as readonly string[]).includes(s) && name) out[s as HomeStation] = name.slice(0, 24);
  return out;
}

export type HomeItemImage = { kind: 'auto' } | { kind: 'url'; value: string } | { kind: 'product'; slug: string };
export type HomeItemLink = { kind: 'category' } | { kind: 'product'; slug: string };

export interface HomeCategoryItem {
  slug: string;
  label: string;
  image: HomeItemImage;
  link: HomeItemLink;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/i;
export const isSlug = (s: string): boolean => SLUG_RE.test(s);

function itemImage(raw: string): HomeItemImage | null {
  const v = raw.trim();
  if (!v) return { kind: 'auto' };
  const m = v.match(/^product:(.+)$/i);
  if (m) return isSlug(m[1].trim()) ? { kind: 'product', slug: m[1].trim().toLowerCase() } : null;
  if (/^\/(?![/\\])\S+$/.test(v) || /^https?:\/\/\S+$/i.test(v)) return { kind: 'url', value: v };
  return null;
}

function itemLink(raw: string): HomeItemLink | null {
  const v = raw.trim();
  if (!v || /^category$/i.test(v)) return { kind: 'category' };
  const m = v.match(/^product:(.+)$/i);
  return m && isSlug(m[1].trim()) ? { kind: 'product', slug: m[1].trim().toLowerCase() } : null;
}

/** HOME_CAT_ITEMS lines → items; a malformed line is skipped (the validator names it on save). */
export function parseCategoryItems(raw: string): HomeCategoryItem[] {
  const out: HomeCategoryItem[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [slug = '', label = '', image = '', link = ''] = line.split('|').map((s) => s.trim());
    const img = itemImage(image), lnk = itemLink(link);
    if (!isSlug(slug) || !img || !lnk || out.some((o) => o.slug === slug.toLowerCase())) continue;
    out.push({ slug: slug.toLowerCase(), label: label.slice(0, 60), image: img, link: lnk });
  }
  return out.slice(0, 12);
}

export function serializeCategoryItems(items: readonly HomeCategoryItem[]): string {
  const img = (i: HomeItemImage) => (i.kind === 'url' ? i.value : i.kind === 'product' ? `product:${i.slug}` : '');
  const lnk = (l: HomeItemLink) => (l.kind === 'product' ? `product:${l.slug}` : '');
  return items.map((i) => [i.slug, i.label, img(i.image), lnk(i.link)].join('|').replace(/\|+$/, '')).join('\n');
}

export function parseSlugList(raw: string, max = 8): string[] {
  return [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(isSlug))].slice(0, max);
}

// ── validation (pure; the registry calls it for every HOME key) ──────────────

const badLink = (h: string) => `“${h.slice(0, 60)}” is not a link of this site (/…) or an https:// address.`;

/** Why `value` is not a valid value for homepage field `key` (null = valid). */
export function homeFieldProblem(key: string, value: string): string | null {
  const f = FIELD.get(key);
  if (!f || !value) return null;
  if (f.kind === 'link') {
    const [label, href = ''] = value.split('|').map((s) => s.trim());
    if (!label) return 'start with the label, e.g. Browse|/marketplace.';
    if (href && !isSafeHref(href)) return badLink(href);
  }
  if (f.kind === 'line' && value.includes('\n')) return 'one line only.';
  switch (key) {
    case 'HOME_STATIONS': {
      const items = value.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = items.filter((s) => !(HOME_STATIONS as readonly string[]).includes(s));
      if (bad.length) return `unknown station “${bad[0]}” — use ${HOME_STATIONS.join(', ')}.`;
      if (new Set(items).size !== items.length) return 'each station once.';
      if (items.includes('intro') && items[0] !== 'intro') return 'the intro opens the page — when shown it comes first.';
      return null;
    }
    case 'HOME_EXTRAS': {
      const items = value.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = items.filter((s) => !isExtra(s));
      if (bad.length) return `unknown module “${bad[0]}” — use ${HOME_EXTRAS.join(', ')}.`;
      return new Set(items).size !== items.length ? 'each module once.' : null;
    }
    case 'HOME_RAIL_NAMES': {
      for (const [s, name] of parsePairs(value)) {
        if (!(HOME_STATIONS as readonly string[]).includes(s)) return `unknown station “${s}” — one line per station: station|LABEL.`;
        if (!name) return `“${s}” has no label (station|LABEL).`;
      }
      return null;
    }
    case 'HERO_STATS': {
      const bad = value.split('\n').map((l) => l.trim()).find((l) => l && !parseHeroStats(l));
      return bad !== undefined ? `line “${bad.slice(0, 60)}” isn’t value|suffix|label (e.g. 12400|+|instruments listed). Empty the box to show live counts.` : null;
    }
    case 'HOME_STAT_LABELS':
      return parsePairs(value).length === 3 ? null : 'three lines — listings, suppliers, countries — each singular|plural.';
    case 'HOME_CAT_ITEMS': {
      const rows = value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (rows.length > 12) return 'at most 12 categories.';
      const seen = new Set<string>();
      for (const line of rows) {
        const [slug = '', , image = '', link = ''] = line.split('|').map((s) => s.trim());
        if (!isSlug(slug)) return `“${line.slice(0, 40)}” must start with a category slug (letters, digits, hyphens).`;
        if (seen.has(slug.toLowerCase())) return `“${slug}” is listed twice.`;
        seen.add(slug.toLowerCase());
        if (!itemImage(image)) return `image of “${slug}”: use a photo address (/media/… or https://…) or product:<listing-slug>.`;
        if (!itemLink(link)) return `link of “${slug}”: leave it empty (the category page) or use product:<listing-slug>.`;
      }
      return null;
    }
    case 'HOME_FEATURED_PRODUCTS': {
      const items = value.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = items.find((s) => !isSlug(s));
      if (bad) return `“${bad.slice(0, 40)}” is not a listing slug.`;
      return items.length > 8 ? 'at most eight listings.' : null;
    }
    case 'HOME_DEMO_PRODUCT':
      return isSlug(value) ? null : `“${value.slice(0, 40)}” is not a listing slug.`;
    case 'HOME_NET_HUB':
      return parseGeoLines(value).length === 1 && !value.includes('\n') ? null : 'one line: name|latitude|longitude (e.g. Zoetermeer|52.06|4.49).';
    case 'HOME_NET_LANES': {
      const bad = value.split('\n').map((l) => l.trim()).find((l) => l && parseGeoLines(l).length === 0);
      return bad !== undefined ? `line “${bad.slice(0, 40)}” isn’t CODE|latitude|longitude.` : null;
    }
    case 'HOME_NET_STEPS':
      return parseTitleLines(value, 99).length > 4 ? 'at most four beats (the globe story has four).' : null;
    case 'HOME_DEMO_STEPS': {
      const rows = value.split('\n').filter((l) => l.trim());
      if (rows.length !== 5) return 'five lines — requested, offer, accepted, paid, shipped — each status|step|line|message.';
      return rows.some((l) => !l.split('|')[0].trim()) ? 'every line starts with the status shown at the top of the demo.' : null;
    }
    case 'HOME_DEMO_OFFER':
      return parsePairs(value).length >= 1 && parsePairs(value).length <= 5 ? null : 'one to five lines of label|value.';
    case 'HOME_WAYS_ITEMS': {
      const ways = value.split('\n').filter((l) => l.trim());
      if (ways.length > 4) return 'at most four ways.';
      for (const l of ways) {
        const href = (l.split('|')[5] ?? '').trim();
        if (href && !isSafeHref(href)) return badLink(href);
      }
      return null;
    }
    case 'HOME_CAT_COUNT':
      return value.includes('{N}') ? null : 'include {N} (the number of listings), e.g. {N} listing|{N} listings.';
    default:
      return null;
  }
}

// ── the content the page renders ─────────────────────────────────────────────

export interface HomeContent {
  site: string;
  hudMeta: string;
  rail: Record<HomeStation, string>;
  introWord: string;
  introTagline: string;
  introScroll: string;
  tour: [string, string];
  heroBadge: string;
  heroTitle: string;
  heroAccent: string;
  heroSubtitle: string;
  /** '' = built from the popular terms (searchPlaceholderFor). */
  searchPlaceholder: string;
  heroBrowse: [string, string];
  heroSource: [string, string];
  heroSell: [string, string];
  popular: string[];
  /** Explicit stats (HERO_STATS), else [] — the page fills in live counts. */
  stats: HomeStat[];
  statLabels: [string, string][];
  catItems: HomeCategoryItem[];
  catMax: number;
  catTitle: string;
  catAccent: string;
  catOpen: string;
  catCount: string;
  catAll: [string, string];
  catAllSub: string;
  catAsk: [string, string];
  catAskSub: string;
  netTitle: string;
  netAccent: string;
  netSubtitle: string;
  netSteps: TitleLine[];
  /** The hub as typed (HOME_NET_HUB), else null — the page derives it from the company city. */
  netHub: GeoPoint | null;
  netLanes: GeoPoint[];
  netLabs: string;
  demoProduct: string;
  demoTitle: string;
  demoAccent: string;
  demoLead: string;
  demoBullets: TitleLine[];
  demoCta: [string, string];
  demoNote: string;
  demoNav: string[];
  demoRef: string;
  demoSample: string;
  demoSteps: DemoStep[];
  demoOffer: [string, string][];
  demoButtons: [string, string];
  waysTitle: string;
  waysAccent: string;
  waysLead: string;
  ways: WayItem[];
  /** Index of the tab open at first (clamped to the ways there are). */
  waysStart: number;
  waysChips: string[];
  outroWord: string;
  ctaHeading: string;
  ctaSubtitle: string;
  ctaPrimary: [string, string];
  ctaSecondary: [string, string];
  featuredProducts: string[];
  featuredKicker: string;
  featuredTitle: string;
  featuredButton: [string, string];
  trustLabel: string;
  blogKicker: string;
  blogTitle: string;
  blogButton: [string, string];
  blogRead: string;
  testHeading: string;
  testMeta: string;
}

export interface HomeContext {
  /** Brand name (SITE_NAME) for {SITE}. */
  site: string;
  /** SELL_LOGISTICS_MODE, for {SELL_SHIPPING}. */
  sellLogistics?: 'SELLER_SHIPS' | 'WE_ARRANGE_PICKUP';
  /** OFFER_DEFAULT_INCOTERM, for {INCOTERM}. */
  incoterm?: string;
}

const defaultCta = (key: string): [string, string] => {
  const [l, h] = (FIELD.get(key)?.default ?? '').split('|');
  return [l ?? '', h ?? '/'];
};

/** Everything the homepage shows, from `read` (live values or a draft) with each field's default. */
export function getHomeContent(read: HomeRead, ctx: HomeContext): HomeContent {
  const site = ctx.site;
  const sell = ctx.sellLogistics === 'WE_ARRANGE_PICKUP' ? 'We arrange the collection' : 'You ship it to our warehouse';
  const tokens = (s: string) => s.replaceAll('{SITE}', site).replaceAll('{SELL_SHIPPING}', sell).replaceAll('{INCOTERM}', ctx.incoterm || 'EXW');
  const v = (key: string) => tokens(homeValue(read, key));
  const cta = (key: string) => parseCta(v(key), defaultCta(key));
  const int = (key: string) => {
    const f = FIELD.get(key)!;
    const n = Number(v(key));
    return Number.isInteger(n) && n >= (f.min ?? -Infinity) && n <= (f.max ?? Infinity) ? n : Number(f.default);
  };
  const pair = (key: string): [string, string] => {
    const [a = '', b = ''] = v(key).split('|').map((s) => s.trim());
    return [a, b];
  };
  const popular = v('HOMEPAGE_POPULAR').split(',').map((s) => s.trim()).filter(Boolean);
  const ways = parseWays(v('HOME_WAYS_ITEMS'));
  const hub = read('HOME_NET_HUB') ? parseGeoLines(v('HOME_NET_HUB'))[0] ?? null : null;
  const offer = parsePairs(v('HOME_DEMO_OFFER'));
  return {
    site,
    hudMeta: v('HOME_HUD_META'),
    rail: parseRailNames(v('HOME_RAIL_NAMES')),
    introWord: v('HOME_INTRO_WORD'),
    introTagline: v('HOME_INTRO_TAGLINE'),
    introScroll: v('HOME_INTRO_SCROLL'),
    tour: pair('HOME_TOUR'),
    heroBadge: v('HERO_BADGE'),
    heroTitle: v('HERO_TITLE'),
    heroAccent: v('HERO_ACCENT'),
    heroSubtitle: v('HERO_SUBTITLE'),
    searchPlaceholder: v('HOME_HERO_SEARCH'),
    heroBrowse: cta('HOME_HERO_BROWSE'),
    heroSource: cta('HOME_HERO_SOURCE'),
    heroSell: cta('HOME_HERO_SELL'),
    popular,
    stats: parseHeroStats(read('HERO_STATS')) ?? [],
    statLabels: parsePairs(v('HOME_STAT_LABELS')),
    catItems: parseCategoryItems(read('HOME_CAT_ITEMS')),
    catMax: int('HOME_CAT_MAX'),
    catTitle: v('HOME_CAT_TITLE'),
    catAccent: v('HOME_CAT_ACCENT'),
    catOpen: v('HOME_CAT_OPEN'),
    catCount: v('HOME_CAT_COUNT'),
    catAll: cta('HOME_CAT_ALL_TITLE'),
    catAllSub: v('HOME_CAT_ALL_SUB'),
    catAsk: cta('HOME_CAT_ASK_TITLE'),
    catAskSub: v('HOME_CAT_ASK_SUB'),
    netTitle: v('HOME_NET_TITLE'),
    netAccent: v('HOME_NET_ACCENT'),
    netSubtitle: v('HOME_NET_SUBTITLE'),
    netSteps: parseTitleLines(v('HOME_NET_STEPS'), 4),
    netHub: hub,
    netLanes: parseGeoLines(v('HOME_NET_LANES')),
    netLabs: v('HOME_NET_LABS'),
    demoProduct: read('HOME_DEMO_PRODUCT').toLowerCase(),
    demoTitle: v('HOME_DEMO_TITLE'),
    demoAccent: v('HOME_DEMO_ACCENT'),
    demoLead: v('HOME_DEMO_LEAD'),
    demoBullets: parseTitleLines(v('HOME_DEMO_BULLETS'), 5),
    demoCta: cta('HOME_DEMO_CTA'),
    demoNote: v('HOME_DEMO_NOTE'),
    demoNav: v('HOME_DEMO_NAV').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6),
    demoRef: v('HOME_DEMO_REF'),
    demoSample: v('HOME_DEMO_SAMPLE'),
    demoSteps: parseDemoSteps(v('HOME_DEMO_STEPS')),
    demoOffer: offer.length ? offer : parsePairs(tokens(FIELD.get('HOME_DEMO_OFFER')!.default)),
    demoButtons: pair('HOME_DEMO_BUTTONS'),
    waysTitle: v('HOME_WAYS_TITLE'),
    waysAccent: v('HOME_WAYS_ACCENT'),
    waysLead: v('HOME_WAYS_LEAD'),
    ways,
    waysStart: Math.max(0, Math.min(int('HOME_WAYS_START') - 1, ways.length - 1)),
    waysChips: v('HOME_WAYS_CHIPS').split(',').map((s) => s.trim()).filter(Boolean),
    outroWord: v('HOME_OUTRO_WORD'),
    ctaHeading: v('CTA_HEADING'),
    ctaSubtitle: v('CTA_SUBTITLE'),
    ctaPrimary: cta('HOME_CTA_PRIMARY'),
    ctaSecondary: cta('HOME_CTA_SECONDARY'),
    featuredProducts: parseSlugList(read('HOME_FEATURED_PRODUCTS')),
    featuredKicker: v('HOME_FEATURED_KICKER'),
    featuredTitle: v('HOME_FEATURED_TITLE'),
    featuredButton: cta('HOME_FEATURED_BUTTON'),
    trustLabel: v('HOME_TRUST_LABEL'),
    blogKicker: v('HOME_BLOG_KICKER'),
    blogTitle: v('HOME_BLOG_TITLE'),
    blogButton: cta('HOME_BLOG_BUTTON'),
    blogRead: v('HOME_BLOG_READ'),
    testHeading: v('TEST_HEADING'),
    testMeta: v('TEST_META'),
  };
}

export interface HomeLayout {
  stations: HomeStation[];
  extras: HomeExtra[];
}

/**
 * The stations shown (in their order) and the extras below them. Extras saved
 * before the registry (HOMEPAGE_SECTIONS with version marker 3) still count
 * until the homepage is published from the editor, which removes them; a list
 * saved before the station layout (v1/v2) counts as no extras.
 */
export function getHomeLayout(read: HomeRead): HomeLayout {
  const extras = read('HOME_EXTRAS')
    ? parseExtras(read('HOME_EXTRAS'))
    : read('HOMEPAGE_SECTIONS_V') === HOME_ORDER_VERSION ? parseExtras(read('HOMEPAGE_SECTIONS')) : [];
  return { stations: parseStations(homeValue(read, 'HOME_STATIONS')), extras };
}

/** Reads a draft over the live values. A draft is complete: the pre-registry keys read as removed. */
export function draftRead(values: Readonly<Record<string, string>>, live: HomeRead = envRead): HomeRead {
  return (k) => (k in values ? (values[k] ?? '').replace(/\r\n/g, '\n').trim() : (HOME_LEGACY_KEYS as readonly string[]).includes(k) ? '' : live(k));
}

// ── kept for the old saveHomepage action (src/app/admin/actions.ts), no longer wired to the editor ──

interface LegacyHomeDefaults {
  popular: string[];
  stats: HomeStat[];
  heroBadge: string;
  heroTitle: string;
  heroAccent: string;
  heroSubtitle: string;
  testHeading: string;
  testMeta: string;
  ctaHeading: string;
  ctaSubtitle: string;
  [field: string]: string | string[] | HomeStat[];
}

/** @deprecated See HOME_DEFAULTS. The HOME_* text keys, as the old action wrote them. */
export const HOME_TEXT_FIELDS: { field: string; key: string }[] = HOME_FIELDS
  .filter((f) => f.key.startsWith('HOME_') && !f.picker && f.kind !== 'int')
  .map((f) => ({ field: f.key, key: f.key }));

/** @deprecated The editor saves through src/app/admin/homepage/actions.ts. */
export const HOME_DEFAULTS: LegacyHomeDefaults = {
  ...Object.fromEntries(HOME_TEXT_FIELDS.map((f) => [f.field, homeField(f.key)!.default])),
  popular: homeField('HOMEPAGE_POPULAR')!.default.split(','),
  stats: [],
  heroBadge: homeField('HERO_BADGE')!.default,
  heroTitle: homeField('HERO_TITLE')!.default,
  heroAccent: homeField('HERO_ACCENT')!.default,
  heroSubtitle: homeField('HERO_SUBTITLE')!.default,
  testHeading: homeField('TEST_HEADING')!.default,
  testMeta: homeField('TEST_META')!.default,
  ctaHeading: homeField('CTA_HEADING')!.default,
  ctaSubtitle: homeField('CTA_SUBTITLE')!.default,
};
