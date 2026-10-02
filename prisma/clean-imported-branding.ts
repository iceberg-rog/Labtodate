/**
 * One-time cleanup for products imported from supplier WooCommerce shops
 * before the importer stripped supplier branding (src/lib/marketplace/
 * import-clean.ts). For imported listings only (seed_user_seller_* owners):
 *   - drops description paragraphs that name the supplier, link to its site
 *     or say "see our website", and unwraps outbound links;
 *   - rebuilds a summary that mentions the supplier from the cleaned text;
 *   - moves PUBLISHED "Product 1234" placeholder titles to Pending review so
 *     an admin gives them a real title before they go live again.
 *
 * Dry run by default (prints what would change). Idempotent. Apply with:
 *   npx tsx prisma/clean-imported-branding.ts --apply
 */

import { PrismaClient, ProductStatus } from '@prisma/client';
import {
  cleanSupplierHtml,
  stripHtml,
  supplierPattern,
  PLACEHOLDER_TITLE_RE,
} from '../src/lib/marketplace/import-clean';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

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
  let flagged = 0;
  for (const p of products) {
    if (!p.company) continue;
    const supplier = { name: p.company.name, urls: [p.company.website, p.company.importSourceUrl] };
    const re = supplierPattern(supplier);
    const data: { description?: string | null; summary?: string | null; status?: ProductStatus } = {};

    // Only rewrite descriptions that actually carry supplier copy or links, so
    // untouched listings keep their original markup byte for byte.
    const description = p.description ?? '';
    if (re.test(description) || /<a\b/i.test(description)) {
      data.description = cleanSupplierHtml(description, supplier);
    }
    if (p.summary && re.test(p.summary)) {
      // The importer builds the summary from the same short description.
      const source = data.description !== undefined ? data.description : p.description;
      data.summary = stripHtml(source ?? '').slice(0, 280) || null;
    }
    if (p.status === ProductStatus.PUBLISHED && PLACEHOLDER_TITLE_RE.test(p.title)) {
      data.status = ProductStatus.PENDING_REVIEW;
      flagged++;
    }
    if (!Object.keys(data).length) continue;
    if (data.description !== undefined || data.summary !== undefined) cleaned++;

    console.log(`• ${p.slug} (${p.title})`);
    if (data.summary !== undefined) console.log(`    summary → ${JSON.stringify(data.summary)}`);
    if (data.description !== undefined) console.log(`    description: ${p.description?.length ?? 0} → ${data.description?.length ?? 0} chars`);
    if (data.status) console.log(`    status PUBLISHED → ${data.status} (placeholder title)`);

    if (APPLY) await prisma.product.update({ where: { id: p.id }, data });
  }

  console.log(
    `\n${APPLY ? 'Updated' : 'Would update'}: ${cleaned} cleaned listing(s), ${flagged} placeholder title(s) sent to Pending review` +
      (APPLY ? '' : '\nDry run — re-run with --apply to write.'),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
