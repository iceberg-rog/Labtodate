/**
 * One-time cleanup for products imported from supplier WooCommerce shops
 * before the importer stripped supplier branding and decoded HTML entities
 * (src/lib/marketplace/import-clean.ts). For imported listings only
 * (seed_user_seller_* owners):
 *   - drops description paragraphs / lines that name the supplier, link to
 *     its site or say "see our website", removes images hotlinked from the
 *     supplier's server, and unwraps outbound links;
 *   - rebuilds a summary that mentions the supplier, or that was built from a
 *     description that got cleaned, from the cleaned text;
 *   - decodes HTML entities left in titles and summaries ("&#8211;", "&#038;"
 *     → "–", "&"); a summary the old importer built from the description is
 *     rebuilt from it, which also restores characters it blanked ("&deg;");
 *   - moves PUBLISHED "Product 1234" placeholder titles to Pending review so
 *     an admin gives them a real title before they go live again.
 *
 * Dry run by default (prints what would change). Idempotent: a listing is
 * only proposed when a field would actually change, so a dry run right after
 * --apply reports 0. Supplier mentions the cleaner cannot take out on its own
 * are listed separately ("check by hand") and are not counted as changes.
 * Apply with:
 *   npx tsx prisma/clean-imported-branding.ts --apply
 */

import { PrismaClient, ProductStatus } from '@prisma/client';
import {
  cleanSupplierHtml,
  decodeEntities,
  hasExternalImage,
  stripHtml,
  supplierPattern,
  PLACEHOLDER_TITLE_RE,
} from '../src/lib/marketplace/import-clean';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** stripHtml as the importers had it before entities were decoded. */
function legacyStripHtml(h: string): string {
  return h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain text with its entities decoded once and whitespace collapsed. */
function decodeText(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/** The summary the importer builds from a description (cut at 280 chars). */
function summaryFrom(description: string | null | undefined): string | null {
  return stripHtml(description ?? '').slice(0, 280) || null;
}

async function main() {
  const products = await prisma.product.findMany({
    where: { sellerId: { startsWith: 'seed_user_seller_' }, companyId: { not: null } },
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      summary: true,
      description: true,
      company: { select: { name: true, website: true, importSourceUrl: true } },
    },
  });

  let cleaned = 0;
  let decoded = 0;
  let flagged = 0;
  const leftovers: string[] = [];
  for (const p of products) {
    if (!p.company) continue;
    const supplier = { name: p.company.name, urls: [p.company.website, p.company.importSourceUrl] };
    const re = supplierPattern(supplier);
    const data: { title?: string; description?: string | null; summary?: string | null; status?: ProductStatus } = {};

    // Only rewrite descriptions that actually carry supplier copy, links or
    // hotlinked images — and only when cleaning changes them — so untouched
    // listings keep their original markup byte for byte.
    const description = p.description ?? '';
    if (re.test(description) || /<a\b/i.test(description) || hasExternalImage(description)) {
      const next = cleanSupplierHtml(description, supplier);
      if (next !== p.description) data.description = next;
    }
    const finalDescription = data.description !== undefined ? data.description : p.description;
    if (p.summary) {
      // The importer builds the summary from the same short description, so a
      // summary that names the supplier, or was built from a description that
      // gets cleaned now, is rebuilt from the cleaned text. The old stripHtml
      // kept numeric entities and blanked named ones, so a summary it built is
      // rebuilt too; any other summary only has its entities decoded.
      const legacy = !!p.description && p.summary === legacyStripHtml(p.description).slice(0, 280);
      // (Some importers trimmed the cut, so compare without trailing space.)
      const derived = !!p.description && p.summary.trim() === summaryFrom(p.description)?.trim();
      const summary =
        re.test(p.summary) || legacy || (derived && data.description !== undefined)
          ? summaryFrom(finalDescription)
          : decodeText(p.summary);
      if (summary !== p.summary) data.summary = summary;
    }
    const branded = data.description !== undefined || (data.summary !== undefined && re.test(p.summary ?? ''));
    // What the cleaner cannot take out by itself (copy outside a text block, a
    // summary written apart from the description): listed, not counted.
    const finalSummary = data.summary !== undefined ? data.summary : p.summary;
    if (re.test(stripHtml(finalDescription ?? '')) || re.test(finalSummary ?? '')) leftovers.push(p.slug);
    const title = decodeText(p.title).slice(0, 200);
    if (title && title !== p.title) data.title = title;
    if (p.status === ProductStatus.PUBLISHED && PLACEHOLDER_TITLE_RE.test(p.title)) {
      data.status = ProductStatus.PENDING_REVIEW;
      flagged++;
    }
    if (!Object.keys(data).length) continue;
    if (branded) cleaned++;
    else if (data.title !== undefined || data.summary !== undefined) decoded++;

    console.log(`• ${p.slug} (${p.title})`);
    if (data.title !== undefined) console.log(`    title → ${JSON.stringify(data.title)}`);
    if (data.summary !== undefined) console.log(`    summary → ${JSON.stringify(data.summary)}`);
    if (data.description !== undefined) console.log(`    description: ${p.description?.length ?? 0} → ${data.description?.length ?? 0} chars`);
    if (data.status) console.log(`    status PUBLISHED → ${data.status} (placeholder title)`);

    if (APPLY) await prisma.product.update({ where: { id: p.id }, data });
  }

  if (leftovers.length) {
    console.log(`\nStill mention the supplier after cleaning — check by hand (${leftovers.length}):`);
    for (const slug of leftovers) console.log(`  ! ${slug}`);
  }
  console.log(
    `\n${APPLY ? 'Updated' : 'Would update'}: ${cleaned} cleaned listing(s), ${decoded} more with only HTML entities decoded, ` +
      `${flagged} placeholder title(s) sent to Pending review` +
      (APPLY ? '' : '\nDry run — re-run with --apply to write.'),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
