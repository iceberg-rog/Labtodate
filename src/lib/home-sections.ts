/**
 * Homepage modules + copy (Admin → Homepage).
 *
 * Since the 2026-10 redesign the homepage follows the Shelter landing
 * structure: seven pinned scroll stations, each a full screen whose 3D moves
 * with the scroll — intro (particle word), hero (chrome molecule), categories
 * (structural-formula column + card helix), suppliers (globe route), process
 * (live buying-panel demo), ways (ways to buy) and cta (particle outro).
 * The four older content modules still exist as optional extras, off by
 * default; switched on they render after the stations as ordinary sections.
 */
export const HOME_STATIONS = ['intro', 'hero', 'categories', 'suppliers', 'process', 'ways', 'cta'] as const;
export const HOME_EXTRAS = ['trustbar', 'featured', 'blog', 'testimonials'] as const;
export const HOME_SECTIONS = [...HOME_STATIONS, ...HOME_EXTRAS] as const;

export type HomeSection = (typeof HOME_SECTIONS)[number];
export type HomeStation = (typeof HOME_STATIONS)[number];
export type HomeExtra = (typeof HOME_EXTRAS)[number];
export const isStation = (s: HomeSection): s is HomeStation => (HOME_STATIONS as readonly string[]).includes(s);

export const HOME_SECTION_LABEL: Record<HomeSection, string> = {
  intro: 'Station 1 — Intro (particle word)',
  hero: 'Station 2 — Hero + search (chrome molecule)',
  categories: 'Station 3 — Categories (formula column + cards)',
  suppliers: 'Station 4 — Route (globe)',
  process: 'Station 5 — Buying, live demo',
  ways: 'Station 6 — Ways to buy',
  cta: 'Station 7 — Sourcing call to action (particle word)',
  trustbar: 'Extra — Trust bar (brands)',
  featured: 'Extra — Featured products',
  blog: 'Extra — Blog teasers',
  testimonials: 'Extra — Testimonials',
};

/** Orders saved before the station layout (v1/v2) fall back to the stations; extras start off. */
export const HOME_ORDER_VERSION = '3';

export interface HomeStat {
  value: number;
  suffix: string;
  label: string;
}

export interface HomeContent {
  popular: string[];
  heroBadge: string;
  heroTitle: string;
  heroAccent: string;
  heroSubtitle: string;
  stats: HomeStat[];
  testHeading: string;
  testMeta: string;
  ctaHeading: string;
  ctaSubtitle: string;
  introWord: string;
  introTagline: string;
  catTitle: string;
  catAccent: string;
  catAllTitle: string;
  catAllSub: string;
  catAskTitle: string;
  catAskSub: string;
  netTitle: string;
  netAccent: string;
  netSubtitle: string;
  netSteps: string;
  netHub: string;
  netLanes: string;
  netLabs: string;
  demoTitle: string;
  demoAccent: string;
  demoLead: string;
  demoBullets: string;
  demoCta: string;
  demoNote: string;
  waysTitle: string;
  waysAccent: string;
  waysLead: string;
  waysItems: string;
  waysChips: string;
  outroWord: string;
}

export const HOME_DEFAULTS: HomeContent = {
  // Terms that match the current HPLC/GC/MS inventory. The home page also
  // hides any chip that would return no results (see src/app/page.tsx).
  popular: ['HPLC', 'Gas Chromatography', 'Mass Spec', 'Autosampler', 'Agilent'],
  heroBadge: 'Used laboratory equipment',
  heroTitle: 'The marketplace for',
  heroAccent: 'science.',
  heroSubtitle:
    'Buy used laboratory equipment online, or request a written quote — every order with a proforma and a VAT invoice.',
  // Counts are computed live from the DB at request time (see src/lib/home-stats.ts)
  // whenever HERO_STATS is unset; these zeros are a type-level fallback only and
  // must never be pre-filled into the editor (saving them used to ship "0 / 0 / 0").
  stats: [
    { value: 0, suffix: '', label: 'instruments listed' },
    { value: 0, suffix: '', label: 'suppliers' },
    { value: 0, suffix: '', label: 'countries we source from' },
  ],
  testHeading: 'What buyers say.',
  testMeta: '',
  ctaHeading: 'Discontinued. Rare. Out of budget. We try to find it.',
  ctaSubtitle: 'Tell us what you need. We search our supply network and reply with what we find.',
  // Station 1: the particle word ('' = the site name) and the line under it ({SITE} = site name)
  introWord: '',
  introTagline: '{SITE} — the marketplace for used laboratory equipment',
  // Station 3: the question over the category list, and the two tiles under it ({N} = live listings)
  catTitle: 'Which instrument',
  catAccent: 'are you looking for?',
  catAllTitle: 'All categories',
  catAllSub: '{N} listings',
  catAskTitle: 'Not in the list?',
  catAskSub: 'Ask us to source it',
  // Station 4: the route story — four beats, one per line "Title|line"; hub + lanes are "NAME|lat|lon"
  netTitle: 'The route of an instrument,',
  netAccent: 'through lab2date.',
  netSubtitle: 'One accountable counterparty from your request to your lab — quote, proforma, payment and shipping.',
  netSteps: [
    'Your request|Tell us the instrument you need',
    'Sourcing|We search our supply network',
    'Offer|A written offer you accept first',
    'Delivery|Shipped from our hub to your lab',
  ].join('\n'),
  netHub: 'lab2date hub|52.37|4.90',
  netLabs: 'Your lab',
  netLanes: ['NYC|40.71|-74.00', 'GRU|-23.55|-46.63', 'MAD|40.42|-3.70', 'STO|59.33|18.07', 'IST|41.01|28.97', 'CAI|30.04|31.24', 'DXB|25.20|55.27', 'BOM|19.08|72.88', 'JNB|-26.20|28.05'].join('\n'),
  // Station 5: the live buying-panel demo next to this copy (sample data, said so on screen)
  demoTitle: 'Buying, step by step,',
  demoAccent: 'in your account.',
  demoLead: 'Every quote, offer, proforma and shipment sits in one place — and nothing is ordered until you accept the offer.',
  demoBullets: ['Request a quote|on any listing, or for anything we do not list', 'Accept the offer|an itemised written offer, no surprises', 'Pay the proforma|VAT invoice with every order', 'Follow the shipment|from our hub to your lab'].join('\n'),
  demoCta: 'Create your account|/auth/sign-up',
  demoNote: 'Sample data — your real quotes live in your account.',
  // Station 6: ways to buy — one per line: Title|Tag|Text|bullet;bullet;bullet|Button|/link
  waysTitle: 'Choose',
  waysAccent: 'how you buy.',
  waysLead: 'Four ways to get an instrument into your lab — all through one accountable counterparty.',
  waysItems: [
    'Buy now|Listed price|Instruments with a listed price can be ordered straight away.|Order at the listed price;Proforma and VAT invoice;Follow it in your account|Browse the marketplace|/marketplace',
    'Request a quote|Written offer|Ask for a quote on any listing — nothing is ordered until you accept the offer.|Itemised written offer;You accept before anything is ordered;Pay against the proforma|Request a quote|/marketplace',
    'Let us find it|Sourcing|Discontinued or rare? Tell us what you need and we search our supply network.|Tell us the model or the specs;We search our supply network;You decide on every offer|Submit a sourcing request|/let-us-find-it',
    'Sell to us|Acquisitions|Surplus instruments in your lab? Send us the details and we reply with an offer.|Send photos and details;We review and reply;Agree the pick-up together|Sell your equipment|/sell',
  ].join('\n'),
  waysChips: 'Proforma before payment, VAT invoice with every order, Everything in your account',
  outroWord: 'SOURCED.',
};

/**
 * Search placeholder built from the popular terms (which the home page has
 * already checked return results), instead of examples we may not stock.
 */
export function searchPlaceholderFor(popular: string[]): string {
  const [a, b] = popular;
  if (a && b) return `Try ‘${a}’ or ‘${b}’…`;
  if (a) return `Try ‘${a}’…`;
  return 'Search instruments, brands, part numbers…';
}

/** Parse "12400|+|instruments listed" lines. Returns null when nothing
 *  usable is set — callers then show LIVE catalogue counts, never the zero
 *  placeholders above. */
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
    if (label && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push({ label: label.slice(0, 24), lat, lon });
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

/** Only site-relative links (or https) are accepted for buttons. */
export function safeHref(raw: string, fallback = '/marketplace'): string {
  const v = raw.trim();
  if (/^\/(?!\/)[^\s]*$/.test(v) || /^https:\/\/[^\s]+$/.test(v)) return v;
  return fallback;
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

/**
 * The homepage's modules: always the seven stations in their fixed order (the 3D story and its camera are built on
 * that order), then the extras switched on in Admin → Homepage, in the order saved there. A list saved before the
 * station layout (v1/v2) counts as no extras.
 */
export function getHomeSectionOrder(): HomeSection[] {
  const configured = (process.env.HOMEPAGE_SECTIONS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is HomeExtra => (HOME_EXTRAS as readonly string[]).includes(s));
  const extras = process.env.HOMEPAGE_SECTIONS_V === HOME_ORDER_VERSION ? [...new Set(configured)] : [];
  return [...HOME_STATIONS, ...extras];
}

/** Read homepage content from process.env (call ensureSettingsLoaded first). */
export function getHomeContent(): HomeContent {
  const d = HOME_DEFAULTS;
  const popular = (process.env.HOMEPAGE_POPULAR || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const env = (k: string, def: string) => process.env[k]?.trim() || def;
  const out = {
    ...d,
    popular: popular.length ? popular : d.popular,
    heroBadge: env('HERO_BADGE', d.heroBadge),
    heroTitle: env('HERO_TITLE', d.heroTitle),
    heroAccent: env('HERO_ACCENT', d.heroAccent),
    heroSubtitle: env('HERO_SUBTITLE', d.heroSubtitle),
    stats: parseHeroStats(process.env.HERO_STATS) ?? HOME_DEFAULTS.stats,
    testHeading: env('TEST_HEADING', d.testHeading),
    testMeta: env('TEST_META', d.testMeta),
    ctaHeading: env('CTA_HEADING', d.ctaHeading),
    ctaSubtitle: env('CTA_SUBTITLE', d.ctaSubtitle),
  } as HomeContent;
  for (const f of HOME_TEXT_FIELDS) (out as unknown as Record<string, string>)[f.field] = env(f.key, d[f.field] as string);
  return out;
}

export type TextGroup = 'intro' | 'categories' | 'route' | 'demo' | 'ways' | 'cta';

/** Admin form field ↔ Setting key for the station texts (save + editor). */
export const HOME_TEXT_FIELDS: { field: keyof HomeContent; key: string; label: string; multiline?: boolean; hint?: string; group: TextGroup }[] = [
  { field: 'introWord', key: 'HOME_INTRO_WORD', label: 'Particle word', group: 'intro', hint: 'Empty = the site name.' },
  { field: 'introTagline', key: 'HOME_INTRO_TAGLINE', label: 'Line under it', group: 'intro', hint: '{SITE} is replaced by the site name.' },
  { field: 'catTitle', key: 'HOME_CAT_TITLE', label: 'Question', group: 'categories' },
  { field: 'catAccent', key: 'HOME_CAT_ACCENT', label: 'Question — accent part', group: 'categories' },
  { field: 'catAllTitle', key: 'HOME_CAT_ALL_TITLE', label: 'Tile 1 title', group: 'categories' },
  { field: 'catAllSub', key: 'HOME_CAT_ALL_SUB', label: 'Tile 1 line', group: 'categories', hint: '{N} = live listings.' },
  { field: 'catAskTitle', key: 'HOME_CAT_ASK_TITLE', label: 'Tile 2 title', group: 'categories' },
  { field: 'catAskSub', key: 'HOME_CAT_ASK_SUB', label: 'Tile 2 line', group: 'categories' },
  { field: 'netTitle', key: 'HOME_NET_TITLE', label: 'Heading', group: 'route' },
  { field: 'netAccent', key: 'HOME_NET_ACCENT', label: 'Heading — accent part', group: 'route' },
  { field: 'netSubtitle', key: 'HOME_NET_SUBTITLE', label: 'Text', group: 'route', multiline: true },
  { field: 'netSteps', key: 'HOME_NET_STEPS', label: 'Story beats', group: 'route', multiline: true, hint: 'Four lines, Title|short line — lit one by one as the globe story plays.' },
  { field: 'netHub', key: 'HOME_NET_HUB', label: 'Globe hub', group: 'route', hint: 'name|latitude|longitude' },
  { field: 'netLanes', key: 'HOME_NET_LANES', label: 'Globe lanes', group: 'route', multiline: true, hint: 'One per line: CODE|latitude|longitude. A drawing only — no shipping promise is shown unless Catalog & claims has one.' },
  { field: 'netLabs', key: 'HOME_NET_LABS', label: 'Globe label at the labs', group: 'route', hint: 'Shown over the cluster of labs the requests come from.' },
  { field: 'demoTitle', key: 'HOME_DEMO_TITLE', label: 'Heading', group: 'demo' },
  { field: 'demoAccent', key: 'HOME_DEMO_ACCENT', label: 'Heading — accent part', group: 'demo' },
  { field: 'demoLead', key: 'HOME_DEMO_LEAD', label: 'Text', group: 'demo', multiline: true },
  { field: 'demoBullets', key: 'HOME_DEMO_BULLETS', label: 'Bullets', group: 'demo', multiline: true, hint: 'One per line: bold part|rest.' },
  { field: 'demoCta', key: 'HOME_DEMO_CTA', label: 'Button', group: 'demo', hint: 'Label|/link' },
  { field: 'demoNote', key: 'HOME_DEMO_NOTE', label: 'Note under the demo', group: 'demo' },
  { field: 'waysTitle', key: 'HOME_WAYS_TITLE', label: 'Heading', group: 'ways' },
  { field: 'waysAccent', key: 'HOME_WAYS_ACCENT', label: 'Heading — accent part', group: 'ways' },
  { field: 'waysLead', key: 'HOME_WAYS_LEAD', label: 'Text', group: 'ways', multiline: true },
  { field: 'waysItems', key: 'HOME_WAYS_ITEMS', label: 'Tabs', group: 'ways', multiline: true, hint: 'Up to four lines: Title|Tag|Text|bullet;bullet;bullet|Button|/link' },
  { field: 'waysChips', key: 'HOME_WAYS_CHIPS', label: 'Chips under the card', group: 'ways', hint: 'Comma-separated. Only what is true for every order.' },
  { field: 'outroWord', key: 'HOME_OUTRO_WORD', label: 'Particle word', group: 'cta', hint: 'Shown above the sourcing call to action.' },
];
