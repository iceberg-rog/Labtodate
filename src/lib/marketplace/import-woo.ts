/**
 * Runtime WooCommerce importer used by the admin "Sync products" button.
 * Mirrors prisma/import-woo.ts but importable from server actions.
 *
 * Idempotent: upserts on Product.slug. Does NOT delete anything.
 */

import { prisma } from '@/lib/db';
import { ProductCondition, ProductMode, ProductStatus } from '@prisma/client';

const KNOWN_BRANDS = [
  'Agilent', 'Waters', 'Thermo', 'Shimadzu', 'PerkinElmer', 'Hitachi', 'Bruker', 'Sciex',
  'Beckman', 'Dionex', 'Varian', 'Sartorius', 'Eppendorf', 'Bio-Rad', 'Mettler', 'Tecan',
  'Roche', 'Leica', 'Zeiss', 'Olympus', 'Nikon', 'Hewlett',
];

interface WooProduct {
  id: number;
  name: string;
  slug: string;
  short_description: string;
  description: string;
  prices: { price: string; currency_code: string };
  images: { src: string }[];
  categories: { id: number; name: string; slug: string }[];
}

function stripHtml(h: string): string {
  return h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function brandIdFor(
  title: string,
  catNames: string,
  cache: Record<string, string>,
): Promise<string> {
  const hay = `${title} ${catNames}`;
  let name = 'Other';
  for (const b of KNOWN_BRANDS) {
    if (new RegExp(`\\b${b}`, 'i').test(hay)) {
      name = b === 'Hewlett' ? 'Hewlett-Packard' : b;
      break;
    }
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (cache[slug]) return cache[slug];
  const brand = await prisma.brand.upsert({
    where: { slug },
    update: { name },
    create: { slug, name },
  });
  cache[slug] = brand.id;
  return brand.id;
}

/**
 * Very small inline categorizer — uses the most-popular existing category
 * for matches we can't classify. Keeps lib/ free of the prisma/_categorize
 * dependency.
 */
async function chooseCategory(title: string, hint: string, fallback: string): Promise<string> {
  const hay = `${title} ${hint}`.toLowerCase();
  const RULES: Array<[string, RegExp]> = [
    ['mass-spec', /\b(mass\s*spec|lc[\s/-]*ms|gc[\s/-]*ms|orbitrap|tof|triple\s*quad|qqq|xevo|micromass|finnigan|spectromet|icp[\s-]*ms)\b/],
    ['spectroscopy', /\b(aas|ftir|ft[\s-]?ir|uv[\s/-]*vis|fluorescen|raman|\bnmr\b|icp[\s-]*oes)\b/],
    ['gc', /\b(gc\b|gas\s*chromatograph|6890|6850|5890|trace\s*gc|headspace)\b/],
    ['hplc-lc', /\b(hplc|uplc|alliance|acquity|nexera|1100|1200|1260|2695|2487|empower)\b/],
    ['autosamplers', /\b(autosampler|auto[\s-]*sampler|carousel|triplus|717)\b/],
    ['detectors', /\b(detector|\bdad\b|\bpda\b|\bfld\b|\belsd\b|\bcad\b|\brid\b|diode array|refractive index)\b/],
    ['pumps-fluidics', /\b(pump|degasser|gradient|solvent manager|fluidic|syringe pump)\b/],
    ['vacuum-gas', /\b(vacuum|edwards|gas generat|nitrogen generat|turbo\s*pump)\b/],
    ['microscopy', /\b(microscop|confocal|axio|imager|imaging system)\b/],
    ['centrifuges', /\b(centrifug|rotor|sorvall|allegra|avanti)\b/],
    ['parts-modules', /\b(part|module|lamp|seal|filter|valve|kit|consumab)\b/],
  ];
  for (const [slug, re] of RULES) {
    if (re.test(hay)) {
      const c = await prisma.category.findUnique({ where: { slug }, select: { id: true } });
      if (c) return c.id;
    }
  }
  return fallback;
}

async function fetchPage<T>(url: string): Promise<{ items: T[]; total: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const total = parseInt(res.headers.get('x-wp-total') ?? '0', 10);
  const items = (await res.json()) as T[];
  return { items, total };
}

export interface ImportTarget {
  companyId: string;
  slug: string;
  name: string;
  base: string;
  /** if provided, only products whose Woo `slug` is in this list get imported */
  whitelistSlugs?: string[] | null;
}

/** Resolve (or create) the seed seller user that owns imported products. */
async function ensureSellerFor(target: ImportTarget): Promise<string> {
  const key = `seed_user_seller_${target.slug.replace(/[^a-z0-9]/g, '')}`;
  await prisma.user.upsert({
    where: { id: key },
    update: { companyId: target.companyId, role: 'SELLER', name: `${target.name} Sales` },
    create: {
      id: key,
      email: `sales@${target.slug}.import`,
      name: `${target.name} Sales`,
      role: 'SELLER',
      companyId: target.companyId,
    },
  });
  return key;
}

export async function runWooImport(target: ImportTarget): Promise<number> {
  const api = `${target.base.replace(/\/+$/, '')}/wp-json/wc/store/v1`;
  const sellerId = await ensureSellerFor(target);
  const brandCache: Record<string, string> = {};

  // Need a sensible fallback category — pick the first category by sortOrder.
  const fallback = await prisma.category.findFirst({
    orderBy: { sortOrder: 'asc' },
    select: { id: true },
  });
  if (!fallback) throw new Error('No categories exist yet — seed CLEAN_CATEGORIES first.');

  // Walk all pages (Woo Store API caps perPage at 100).
  const first = await fetchPage<WooProduct>(`${api}/products?per_page=100&page=1`);
  const pages = Math.max(1, Math.ceil(first.total / 100));
  let all: WooProduct[] = [...first.items];
  for (let p = 2; p <= pages; p++) {
    try {
      const page = await fetchPage<WooProduct>(`${api}/products?per_page=100&page=${p}`);
      all = all.concat(page.items);
    } catch (e) {
      // tolerate one bad page rather than abort the whole import
      console.warn(`woo import: page ${p} failed`, e);
    }
  }

  const whitelist = target.whitelistSlugs ? new Set(target.whitelistSlugs) : null;

  let n = 0;
  for (const w of all) {
    const title = stripHtml(w.name).slice(0, 200) || `Product ${w.id}`;
    const slug = (w.slug || `${target.slug}-${w.id}`).slice(0, 90);
    if (whitelist && !whitelist.has(slug)) continue;
    const hint = (w.categories ?? []).map((c) => c.name).join(' ');
    const categoryId = await chooseCategory(title, hint, fallback.id);
    const brandId = await brandIdFor(title, hint, brandCache);
    const priceNum = parseFloat(w.prices?.price ?? '0');
    const priceCents = priceNum > 0 ? Math.round(priceNum) : null;
    const images = (w.images ?? []).map((i) => i.src).filter(Boolean);
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
      companyId: target.companyId,
    };

    await prisma.product.upsert({
      where: { slug },
      update: data,
      create: { slug, ...data },
    });
    n++;
  }
  return n;
}
