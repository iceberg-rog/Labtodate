/**
 * Generic WooCommerce → lab2date importer.
 *
 * Preserves each source's REAL category taxonomy (with parent
 * hierarchy), merging categories across sources by slug. Products are
 * assigned to their most-specific real category. Idempotent.
 *
 *   npx tsx prisma/import-woo.ts
 */

import { PrismaClient, ProductCondition, ProductMode, ProductStatus } from '@prisma/client';
import { CLEAN_CATEGORIES, categorize } from './_categorize';

const prisma = new PrismaClient();

interface Site {
  key: string;
  base: string;            // e.g. https://lab2parts.com
  company: { slug: string; name: string; country: string };
}

const SITES: Site[] = [
  { key: 'lab2parts', base: 'https://lab2parts.com', company: { slug: 'lab2parts', name: 'Lab2Parts', country: 'Netherlands' } },
  { key: 'lab2nl',    base: 'https://lab2.nl',       company: { slug: 'lab2nl',    name: 'Lab2',      country: 'Netherlands' } },
];

interface WooCat { id: number; name: string; slug: string; parent: number; count: number }
interface WooProduct {
  id: number; name: string; slug: string; short_description: string; description: string;
  prices: { price: string; currency_code: string };
  images: { src: string }[];
  categories: { id: number; name: string; slug: string }[];
}

function stripHtml(h: string): string {
  return h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

const KNOWN_BRANDS = ['Agilent', 'Waters', 'Thermo', 'Shimadzu', 'PerkinElmer', 'Hitachi', 'Bruker', 'Sciex', 'Beckman', 'Dionex', 'Varian', 'Sartorius', 'Eppendorf', 'Bio-Rad', 'Mettler', 'Tecan', 'Roche', 'Leica', 'Zeiss', 'Olympus', 'Nikon', 'Hewlett'];
const brandCache: Record<string, string> = {};

async function brandIdFor(title: string, catNames: string): Promise<string> {
  const hay = `${title} ${catNames}`;
  let name = 'Other';
  for (const b of KNOWN_BRANDS) {
    if (new RegExp(`\\b${b}`, 'i').test(hay)) { name = b === 'Hewlett' ? 'Hewlett-Packard' : b; break; }
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (brandCache[slug]) return brandCache[slug];
  const brand = await prisma.brand.upsert({ where: { slug }, update: { name }, create: { slug, name } });
  brandCache[slug] = brand.id;
  return brand.id;
}

async function fetchAll<T>(url: string, total: number, perPage: number): Promise<T[]> {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const out: T[] = [];
  for (let p = 1; p <= pages; p++) {
    const res = await fetch(`${url}&page=${p}`);
    if (!res.ok) { console.warn(`  ! ${url} page ${p} → ${res.status}`); continue; }
    out.push(...((await res.json()) as T[]));
  }
  return out;
}

async function importSite(site: Site) {
  console.log(`\n⇣ ${site.key} (${site.base})`);
  const api = `${site.base}/wp-json/wc/store/v1`;

  const company = await prisma.company.upsert({
    where: { slug: site.company.slug },
    update: { name: site.company.name, country: site.company.country, website: site.base, isVerified: true, isFeatured: true },
    create: { slug: site.company.slug, name: site.company.name, country: site.company.country, website: site.base, isVerified: true, isFeatured: true, description: `Imported catalogue from ${site.base}` },
  });
  const sellerId = `seed_user_seller_${site.key}`;
  await prisma.user.upsert({
    where: { id: sellerId },
    update: { email: `sales@${site.company.slug}.import`, name: `${site.company.name} Sales`, role: 'SELLER', companyId: company.id },
    create: { id: sellerId, email: `sales@${site.company.slug}.import`, name: `${site.company.name} Sales`, role: 'SELLER', companyId: company.id },
  });

  // ── Categories: clean lab2date taxonomy only (never Woo model-number junk) ──
  const idBySlug: Record<string, string> = {};
  let order = 0;
  for (const c of CLEAN_CATEGORIES) {
    const rec = await prisma.category.upsert({
      where: { slug: c.slug },
      update: { name: c.name, sortOrder: order, parentId: null },
      create: { slug: c.slug, name: c.name, sortOrder: order },
    });
    idBySlug[c.slug] = rec.id;
    order++;
  }
  console.log(`  ${CLEAN_CATEGORIES.length} clean categories ensured`);

  // ── Products ──
  const ph = await fetch(`${api}/products?per_page=1`);
  const pTotal = parseInt(ph.headers.get('x-wp-total') ?? '0', 10);
  const products = await fetchAll<WooProduct>(`${api}/products?per_page=100`, pTotal, 100);
  console.log(`  ${products.length} products`);

  let n = 0;
  for (const w of products) {
    const title = stripHtml(w.name).slice(0, 200) || `Product ${w.id}`;
    const slug = (w.slug || `${site.key}-${w.id}`).slice(0, 90);

    // clean keyword-based categorization (title + Woo category names as hint)
    const hint = w.categories.map((c) => c.name).join(' ');
    const categoryId = idBySlug[categorize(title, hint)];

    const brandId = await brandIdFor(title, w.categories.map((c) => c.name).join(' '));
    const priceNum = parseFloat(w.prices?.price ?? '0');
    const priceCents = priceNum > 0 ? Math.round(priceNum) : null;
    const images = w.images?.map((i) => i.src).filter(Boolean) ?? [];
    const summary = stripHtml(w.short_description).slice(0, 280) || null;

    const data = {
      title,
      summary,
      description: w.short_description || w.description || null,
      condition: ProductCondition.USED,
      mode: priceCents ? ProductMode.HYBRID : ProductMode.QUOTE_ONLY,
      status: ProductStatus.PUBLISHED,
      priceCents,
      currency: w.prices?.currency_code || 'EUR',
      images,
      hasImages: images.length > 0,
      illustration: 'balance',
      categoryId,
      brandId,
      sellerId,
      companyId: company.id,
    };
    await prisma.product.upsert({ where: { slug }, update: data, create: { slug, ...data } });
    n++;
  }
  console.log(`  ✓ ${n} products imported`);
}

/**
 * Build a one-off Site from CLI args for ADDITIVE imports of a new shop:
 *
 *   npx tsx prisma/import-woo.ts --add https://newshop.com "New Shop" [Country]
 *
 * No WordPress login is needed — this only reads the public WooCommerce
 * Store API. Additive mode imports the new shop WITHOUT deleting any
 * existing imported catalogue.
 */
function siteFromArgs(): Site | null {
  const i = process.argv.indexOf('--add');
  if (i === -1) return null;
  const base = (process.argv[i + 1] || '').replace(/\/+$/, '');
  const name = process.argv[i + 2];
  const country = process.argv[i + 3] || 'Netherlands';
  if (!/^https?:\/\//.test(base) || !name) {
    throw new Error('Usage: tsx prisma/import-woo.ts --add <https://shop-url> "<Company Name>" [Country]');
  }
  const host = new URL(base).hostname.replace(/^www\./, '');
  const key = host.replace(/[^a-z0-9]+/gi, '').toLowerCase();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { key, base, company: { slug, name, country } };
}

async function main() {
  const added = siteFromArgs();

  if (added) {
    // ── Additive: import just the new shop, delete nothing ──
    await importSite(added);
    console.log('\n✅ Added shop:', {
      shop: added.company.name,
      products: await prisma.product.count({ where: { sellerId: `seed_user_seller_${added.key}` } }),
      totalProducts: await prisma.product.count(),
    });
    console.log('\nNext: localize its images into MinIO and fetch brand logos:');
    console.log('  npx tsx prisma/localize-images.ts');
    console.log('  npx tsx prisma/fetch-brand-logos.ts');
    return;
  }

  for (const s of SITES) await importSite(s);

  // ── Cleanup: drop the original fake seed catalogue ──
  const realSellers = SITES.map((s) => `seed_user_seller_${s.key}`);
  const removed = await prisma.product.deleteMany({
    where: { sellerId: { notIn: realSellers } },
  });
  console.log(`\n🧹 Removed ${removed.count} non-imported (fake seed) products`);

  // ── Cleanup: drop categories with zero published products ──
  const empties = await prisma.category.findMany({
    where: { products: { none: { status: 'PUBLISHED' } }, children: { none: {} } },
    select: { id: true },
  });
  if (empties.length) {
    await prisma.category.deleteMany({ where: { id: { in: empties.map((e) => e.id) } } });
  }
  console.log(`🧹 Removed ${empties.length} empty categories`);

  console.log('\n✅ Final:', {
    products: await prisma.product.count(),
    categories: await prisma.category.count(),
    brands: await prisma.brand.count(),
  });
}

main()
  .catch((e) => { console.error('Import failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
