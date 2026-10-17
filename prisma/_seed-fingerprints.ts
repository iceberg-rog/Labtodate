/**
 * Exact fingerprints of everything the demo seed scripts create
 * (prisma/seed.ts, prisma/seed-content.ts, prisma/seed-own-catalogue.ts and the
 * sample testimonials in src/lib/seed-data). Used by prisma/audit-seed-content.ts
 * to find seed rows precisely — by their stable id/slug AND a second field
 * (email / title / name) — so real data is never matched by accident.
 *
 * Keep in sync when a seed script changes.
 */

export const SEED_ADMIN_USERS = [
  { id: 'seed_user_admin', email: 'admin@lab2date.com', script: 'seed.ts' },
  { id: 'seed_user_admin_curator', email: 'curator@lab2date.com', script: 'seed-own-catalogue.ts' },
] as const;

export const SEED_DEMO_USERS = [
  { id: 'seed_user_seller_biolab', email: 'sales@biolab-refurb.example' },
  { id: 'seed_user_seller_northeast', email: 'sales@northeast-scientific.ex' },
  { id: 'seed_user_seller_optiscope', email: 'sales@optiscope.example' },
  { id: 'seed_user_seller_pivot', email: 'sales@pivotpark.example' },
  { id: 'seed_user_seller_eurolab', email: 'sales@eurolab.example' },
  { id: 'seed_user_seller_asia', email: 'sales@asci.example' },
  { id: 'seed_user_buyer_demo1', email: 'demo-buyer@lab2date.com' },
  { id: 'seed_user_buyer_demo2', email: 'researcher@lab2date.com' },
] as const;

/** Products seeded by these sellers are demo listings (seed.ts / seed-own-catalogue.ts). */
export const SEED_PRODUCT_SELLER_IDS = [
  ...SEED_DEMO_USERS.filter((u) => u.id.startsWith('seed_user_seller_')).map((u) => u.id),
  'seed_user_admin_curator',
] as const;

export const SEED_COMPANIES = [
  { slug: 'biolab-refurb-gmbh', name: 'BioLab Refurb GmbH', website: 'https://biolab-refurb.example' },
  { slug: 'northeast-scientific', name: 'Northeast Scientific', website: 'https://northeast-scientific.example' },
  { slug: 'optiscope-trade-bv', name: 'OptiScope Trade BV', website: 'https://optiscope.example' },
  { slug: 'pivot-park-instruments', name: 'Pivot Park Instruments', website: 'https://pivotpark.example' },
  { slug: 'eurolab-supplies', name: 'EuroLab Supplies', website: 'https://eurolab.example' },
  { slug: 'asia-scientific-direct', name: 'Asia Scientific Direct', website: 'https://asci.example' },
] as const;

/** Fabricated: invented customers (real organisation names) and invented figures. */
export const SEED_CASE_STUDIES = [
  { slug: 'pivot-park-40-percent-cost-savings', customer: 'Pivot Park', title: 'Pivot Park saved 40% on a Zeiss confocal versus distributor list price' },
  { slug: 'epoch-biodesign-discontinued-mass-spec-component', customer: 'EPOCH BioDesign', title: 'EPOCH BioDesign sourced a discontinued mass spec component in 11 days' },
] as const;

/** Fabricated rental facilities attributed to the fake seed companies. */
export const SEED_FACILITIES = [
  { slug: 'pivot-park-imaging-core', name: 'Pivot Park Imaging Core' },
  { slug: 'biolab-refurb-test-lab', name: 'BioLab Refurb Test Bay' },
  { slug: 'northeast-scientific-mass-spec-suite', name: 'Northeast Scientific Mass Spec Suite' },
] as const;

/** Seeded blog posts: contain invented anecdotes and process claims
 *  ("the checklist our procurement team uses on every incoming system",
 *  "a €74,000 lesson" at an unnamed Dutch lab, "warrantied … with full
 *  inspection documentation"). */
export const SEED_BLOG_POSTS = [
  {
    slug: 'buying-refurbished-hplc-checklist',
    title: 'How to Buy a Refurbished HPLC System: The Complete 2026 Inspection Checklist',
    claim: 'claims an 18-point checklist "our procurement team uses on every incoming system" and links to "warrantied refurbished HPLC systems with full inspection documentation"',
  },
  {
    slug: 'mass-spec-cost-breakdown-2026',
    title: 'Mass Spectrometer Total Cost of Ownership: A 2026 Breakdown',
    claim: 'presents invented cost/uptime statistics as fact and links to "warrantied refurbished mass spectrometers"',
  },
  {
    slug: 'centrifuge-rotor-compatibility-guide',
    title: 'Centrifuge Rotor Compatibility: The Complete Cross-Brand Guide',
    claim: 'tells an invented "€74,000 lesson" at an unnamed Dutch life-science park as a real incident',
  },
] as const;

/** Seeded wiki articles: generic definitions published under the seed admin. */
export const SEED_WIKI_ARTICLES = [
  { slug: 'what-is-hplc', title: 'What is HPLC?' },
  { slug: 'centrifuge-types', title: 'Centrifuge types explained' },
] as const;

/** Sample testimonials (src/lib/seed-data/testimonials.ts): invented people at real organisations. */
export const SEED_TESTIMONIALS = [
  { author: 'Dr. Anna Vermeer', company: 'Pivot Park', quoteStart: 'We saved 42% on a Zeiss confocal' },
  { author: 'Prof. Daniel Okafor', company: 'Northeastern University', quoteStart: 'The "Let Us Find It" team sourced a discontinued' },
  { author: 'Marie Lefèvre', company: 'EPOCH BioDesign', quoteStart: 'Listing my surplus inventory took 20 minutes' },
] as const;

/** Address domains that can never receive mail (or are not ours): flagged in reports. */
export const PLACEHOLDER_EMAIL_RE = /@([^@\s]+\.)?(example|ex|local|import|invalid|localhost|test)$|@lab2date\.com$/i;
