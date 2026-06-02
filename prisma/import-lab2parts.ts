/**
 * Import the full lab2parts.com WooCommerce catalogue into lab2date.
 *
 * Source: public WooCommerce Store API (no auth, read-only).
 * Idempotent — re-running upserts by product slug.
 *
 *   npx tsx prisma/import-lab2parts.ts
 */

import { PrismaClient, ProductCondition, ProductMode, ProductStatus } from '@prisma/client';

const prisma = new PrismaClient();

const API = 'https://lab2parts.com/wp-json/wc/store/v1';
const PER_PAGE = 100;

const SELLER = {
  id: 'seed_user_seller_lab2parts',
  email: 'sales@lab2parts.com',
  name: 'Lab2Parts Sales',
};
const COMPANY = {
  slug: 'lab2parts',
  name: 'Lab2Parts',
  country: 'Netherlands',
  website: 'https://lab2parts.com',
  description: 'Specialist supplier of used and refurbished spare parts for Agilent, Waters, Thermo, Shimadzu and more.',
};

interface WooImage { src: string }
interface WooCat { id: number; name: string; slug: string }
interface WooProduct {
  id: number;
  name: string;
  slug: string;
  sku: string;
  short_description: string;
  description: string;
  prices: { price: string; currency_code: string; currency_minor_unit: number };
  images: WooImage[];
  categories: WooCat[];
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const KNOWN_BRANDS = [
  'Agilent', 'Waters', 'Thermo', 'Shimadzu', 'PerkinElmer', 'Hitachi', 'Bruker',
  'Sciex', 'Beckman', 'Dionex', 'Hewlett', 'Varian', 'Sartorius', 'Eppendorf',
  'Bio-Rad', 'Mettler', 'Tecan', 'Roche', 'Leica', 'Zeiss', 'Olympus', 'Nikon',
];

function deriveBrand(title: string, cats: WooCat[]): { slug: string; name: string } {
  const hay = `${title} ${cats.map((c) => c.name).join(' ')}`;
  for (const b of KNOWN_BRANDS) {
    if (new RegExp(`\\b${b}`, 'i').test(hay)) {
      const name = b === 'Hewlett' ? 'Hewlett-Packard' : b;
      return { slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name };
    }
  }
  return { slug: 'other', name: 'Other' };
}

function mapCategory(title: string, cats: WooCat[]): string {
  const h = `${title} ${cats.map((c) => c.name + ' ' + c.slug).join(' ')}`.toLowerCase();
  if (/lcms|mass spec|\bms\b|orbitrap|q.?exactive|xevo|tof|quadrupole|ion source|apci|\besi\b|maldi|spectromet/.test(h)) return 'analytical';
  if (/hplc|uplc|\bgc\b|chromatograph|column|\blc\b|acquity|nexera|infinity|1100|1200|1260|1290|2695|2690|6850|7890/.test(h)) return 'chromatography';
  if (/pcr|thermocycler|sequenc|incubat|bioreact|electrophoresis|gel.?doc|qpcr|elisa/.test(h)) return 'biotech';
  if (/microscop|objective|confocal|eyepiece/.test(h)) return 'microscopy';
  if (/centrifug|rotor/.test(h)) return 'centrifugation';
  if (/balance|weigh|\bscale\b/.test(h)) return 'general-lab';
  if (/uv.?vis|ftir|raman|\baas\b|\bicp\b|fluorescen|detector|lamp/.test(h)) return 'test-measurement';
  if (/pump|valve|degasser|autosampler|fraction|tubing|fitting|seal|filter|board|power supply|module/.test(h)) return 'process';
  return 'general-lab';
}

const ILLUSTRATION_FOR: Record<string, string> = {
  analytical: 'massspec',
  chromatography: 'hplc',
  biotech: 'pcr',
  microscopy: 'microscope',
  centrifugation: 'centrifuge',
  'general-lab': 'balance',
  'test-measurement': 'massspec',
  process: 'hplc',
};

async function main() {
  console.log('⇣ Importing lab2parts.com catalogue…');

  // Seller + company
  const company = await prisma.company.upsert({
    where: { slug: COMPANY.slug },
    update: { name: COMPANY.name, country: COMPANY.country, website: COMPANY.website, description: COMPANY.description, isVerified: true, isFeatured: true },
    create: { ...COMPANY, isVerified: true, isFeatured: true },
  });
  await prisma.user.upsert({
    where: { id: SELLER.id },
    update: { email: SELLER.email, name: SELLER.name, role: 'SELLER', companyId: company.id },
    create: { id: SELLER.id, email: SELLER.email, name: SELLER.name, role: 'SELLER', companyId: company.id },
  });

  const catBySlug = Object.fromEntries(
    (await prisma.category.findMany()).map((c) => [c.slug, c.id]),
  );

  // Discover total pages
  const head = await fetch(`${API}/products?per_page=1`);
  const total = parseInt(head.headers.get('x-wp-total') ?? '0', 10);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  console.log(`  ${total} products · ${pages} pages`);

  const brandCache: Record<string, string> = {};
  let imported = 0;

  for (let page = 1; page <= pages; page++) {
    const res = await fetch(`${API}/products?per_page=${PER_PAGE}&page=${page}`);
    if (!res.ok) {
      console.warn(`  ! page ${page} failed (${res.status})`);
      continue;
    }
    const items = (await res.json()) as WooProduct[];

    for (const w of items) {
      const title = stripHtml(w.name).slice(0, 200) || `Product ${w.id}`;
      const slug = (w.slug || `lab2parts-${w.id}`).slice(0, 90);
      const catSlug = mapCategory(title, w.categories);
      const categoryId = catBySlug[catSlug] ?? catBySlug['general-lab'];
      if (!categoryId) continue;

      // Brand
      const b = deriveBrand(title, w.categories);
      let brandId = brandCache[b.slug];
      if (!brandId) {
        const brand = await prisma.brand.upsert({
          where: { slug: b.slug },
          update: { name: b.name },
          create: { slug: b.slug, name: b.name },
        });
        brandId = brand.id;
        brandCache[b.slug] = brandId;
      }

      const priceNum = parseFloat(w.prices?.price ?? '0');
      const minor = w.prices?.currency_minor_unit ?? 2;
      const priceCents = priceNum > 0 ? Math.round(priceNum) * (minor === 2 ? 1 : 1) : null;
      const images = w.images?.map((i) => i.src).filter(Boolean) ?? [];
      const summary = stripHtml(w.short_description).slice(0, 280) || null;

      await prisma.product.upsert({
        where: { slug },
        update: {
          title,
          summary,
          description: w.short_description || w.description || null,
          condition: ProductCondition.USED,
          mode: priceCents ? ProductMode.HYBRID : ProductMode.QUOTE_ONLY,
          status: ProductStatus.PUBLISHED,
          priceCents,
          currency: w.prices?.currency_code || 'EUR',
          images,
          illustration: ILLUSTRATION_FOR[catSlug] ?? 'balance',
          categoryId,
          brandId,
          sellerId: SELLER.id,
          companyId: company.id,
        },
        create: {
          slug,
          title,
          summary,
          description: w.short_description || w.description || null,
          condition: ProductCondition.USED,
          mode: priceCents ? ProductMode.HYBRID : ProductMode.QUOTE_ONLY,
          status: ProductStatus.PUBLISHED,
          priceCents,
          currency: w.prices?.currency_code || 'EUR',
          images,
          illustration: ILLUSTRATION_FOR[catSlug] ?? 'balance',
          categoryId,
          brandId,
          sellerId: SELLER.id,
          companyId: company.id,
        },
      });
      imported++;
    }
    console.log(`  page ${page}/${pages} · ${imported} imported`);
  }

  const counts = {
    products: await prisma.product.count(),
    fromLab2parts: await prisma.product.count({ where: { companyId: company.id } }),
    brands: await prisma.brand.count(),
  };
  console.log('✅ Done.', counts);
}

main()
  .catch((e) => {
    console.error('Import failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
