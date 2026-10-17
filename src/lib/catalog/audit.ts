/**
 * Catalog audit: what supplier listings say that lab2date has not promised,
 * checked live against the owner's rules (Settings → Import & suppliers /
 * Catalog & claims) — so it never goes stale:
 *  - CLAIMS: supplier warranty / "tested" / service promises in the texts;
 *  - PRICES: other prices inside the texts (meta description, JSON-LD);
 *  - CROSS_SELL: "Also available: …" tails naming other units;
 *  - TITLE_CLAIM: a claim in the title itself (only a person can rename);
 *  - CONDITION: the grade contradicts the listing's own title / text;
 *  - BRAND / CATEGORY: no brand, a placeholder brand, or one the title contradicts;
 *    no category rule matches the title.
 * Used by Admin → Catalog → Audit and the cleanup script (prisma/clean-imported-claims.ts).
 */
import type { Prisma, PrismaClient, ProductCondition } from '@prisma/client';
import { cleanSupplierHtmlDetailed, cleanSupplierText, stripHtml, type RemovedText } from '@/lib/marketplace/import-clean';
import { conditionConflict, matchBrand, matchCategory } from '@/lib/catalog/import-rules';
import type { ImportSettings } from '@/lib/catalog/import-settings';
import { isPlaceholderBrand } from '@/lib/catalog/jsonld';

export type AuditKind = 'CLAIMS' | 'PRICES' | 'CROSS_SELL' | 'TITLE_CLAIM' | 'CONDITION' | 'BRAND' | 'CATEGORY';

export interface AuditRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  shop: string | null;
  condition: ProductCondition;
  kinds: AuditKind[];
  /** Sentences the cleaner would remove (with the reason). */
  removed: RemovedText[];
  /** The condition the title / text states, when it contradicts the grade. */
  statedCondition: ProductCondition | null;
  brand: string | null;
  suggestedBrand: string | null;
  category: string;
  suggestedCategory: string | null;
  /** Description / summary are locked by an admin edit: cleaned by hand only. */
  textLocked: boolean;
}

export const AUDIT_SELECT = {
  id: true,
  slug: true,
  title: true,
  status: true,
  summary: true,
  description: true,
  condition: true,
  lockedFields: true,
  brand: { select: { name: true, slug: true } },
  category: { select: { slug: true, name: true } },
  company: { select: { name: true, website: true, importSourceUrl: true } },
} satisfies Prisma.ProductSelect;

type AuditProduct = Prisma.ProductGetPayload<{ select: typeof AUDIT_SELECT }>;

/** Supplier listings that are not archived (lab2date sells them as seller of record). */
export const AUDIT_WHERE: Prisma.ProductWhereInput = { companyId: { not: null }, status: { not: 'ARCHIVED' } };

export function auditProduct(p: AuditProduct, rules: ImportSettings, placeholderBrands: readonly string[], categoryNames: Map<string, string>): AuditRow {
  const supplier = { name: p.company?.name ?? '', urls: [p.company?.website, p.company?.importSourceUrl] };
  const desc = cleanSupplierHtmlDetailed(p.description, supplier, rules.detect);
  const summ = cleanSupplierText(p.summary, supplier, rules.detect);
  // Shown: what goes from the description (the summary is rebuilt from it);
  // the summary's own findings only when the description has none.
  const removed = (desc.removed.length ? desc.removed : summ.removed).filter((r, i, all) => all.findIndex((x) => x.text === r.text) === i);
  const kinds = new Set<AuditKind>();
  for (const r of [...desc.removed, ...summ.removed]) {
    if (r.reason === 'CLAIM' || r.reason === 'SUPPLIER') kinds.add('CLAIMS');
    if (r.reason === 'PRICE') kinds.add('PRICES');
    if (r.reason === 'CROSS_SELL') kinds.add('CROSS_SELL');
  }
  if (rules.detect.claims?.test(p.title)) kinds.add('TITLE_CLAIM');
  const stated = conditionConflict(p.condition, p.title, stripHtml(`${p.summary ?? ''} ${p.description ?? ''}`), rules.conditionWords);
  if (stated) kinds.add('CONDITION');
  const brandName = p.brand && !isPlaceholderBrand(p.brand, placeholderBrands) ? p.brand.name : null;
  const bm = matchBrand(null, p.title, rules.brands);
  const suggestedBrand = bm.brand && bm.brand.toLowerCase() !== (brandName ?? '').toLowerCase() ? bm.brand : null;
  if (!brandName || (suggestedBrand && !bm.candidates.some((c) => c.toLowerCase() === (brandName ?? '').toLowerCase()))) kinds.add('BRAND');
  const catSlug = matchCategory(p.title, '', rules.categories, (s) => categoryNames.has(s));
  if (!catSlug) kinds.add('CATEGORY');
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    status: p.status,
    shop: p.company?.name ?? null,
    condition: p.condition,
    kinds: [...kinds],
    removed,
    statedCondition: stated,
    brand: brandName,
    suggestedBrand,
    category: p.category.name,
    suggestedCategory: catSlug && catSlug !== p.category.slug ? categoryNames.get(catSlug) ?? catSlug : null,
    textLocked: p.lockedFields.includes('description') || p.lockedFields.includes('summary'),
  };
}

export interface CleanupResult {
  checked: number;
  cleaned: number;
  sentences: number;
  skippedLocked: number;
  byReason: Record<string, number>;
  samples: { slug: string; removed: RemovedText[] }[];
}

/**
 * Apply the cleaner (claims / prices / cross-sell / supplier mentions) to the
 * description and summary of supplier listings. Admin-locked texts are left
 * alone (reported). Idempotent: a second run changes nothing.
 */
export async function cleanSupplierTexts(
  db: PrismaClient | Prisma.TransactionClient,
  rules: ImportSettings,
  opts: { apply: boolean; where?: Prisma.ProductWhereInput },
): Promise<CleanupResult> {
  const products = await db.product.findMany({ where: opts.where ?? AUDIT_WHERE, select: AUDIT_SELECT, orderBy: { slug: 'asc' } });
  const out: CleanupResult = { checked: products.length, cleaned: 0, sentences: 0, skippedLocked: 0, byReason: {}, samples: [] };
  for (const p of products) {
    const supplier = { name: p.company?.name ?? '', urls: [p.company?.website, p.company?.importSourceUrl] };
    // Always remove (the owner asked for it with this action), whatever IMPORT_CLAIM_MODE says.
    const desc = cleanSupplierHtmlDetailed(p.description, supplier, rules.detect);
    const summ = cleanSupplierText(p.summary, supplier, rules.detect);
    const removed = [...desc.removed, ...summ.removed];
    if (!removed.length) continue;
    const locked = p.lockedFields.includes('description') || p.lockedFields.includes('summary');
    if (locked) {
      out.skippedLocked++;
      continue;
    }
    const data: Prisma.ProductUpdateInput = {};
    if (desc.html !== p.description) data.description = desc.html;
    // A summary is plain text without line breaks (importers built it from the
    // shop's short description), so a claim in it cannot be cut out by
    // sentence: it is rebuilt from the cleaned description — the same way the
    // importer builds one — or, without a description, cleaned in place.
    const plainBefore = stripHtml(p.description ?? '');
    const derived = !!p.summary && !!plainBefore && plainBefore.slice(0, 60) === p.summary.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (summ.removed.length || (derived && desc.removed.length)) {
      data.summary = desc.html ? teaser(stripHtml(desc.html)) : summ.text ? summ.text.slice(0, 300) : null;
    }
    if (!Object.keys(data).length) continue;
    out.cleaned++;
    out.sentences += removed.length;
    for (const r of removed) out.byReason[r.reason] = (out.byReason[r.reason] ?? 0) + 1;
    if (out.samples.length < 20) out.samples.push({ slug: p.slug, removed: removed.slice(0, 4) });
    if (opts.apply) await db.product.update({ where: { id: p.id }, data });
  }
  return out;
}

/** A card summary from plain text: at most 280 characters, cut at a word. */
export function teaser(text: string, max = 280): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, '')}…`;
}
