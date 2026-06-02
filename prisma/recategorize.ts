/**
 * One-time cleanup: replace the imported model-number category mess with
 * the clean lab2date taxonomy and remap every product. Idempotent.
 *
 *   npx tsx prisma/recategorize.ts
 */

import { PrismaClient } from '@prisma/client';
import { CLEAN_CATEGORIES, categorize } from './_categorize';

const prisma = new PrismaClient();

async function main() {
  // 1) Ensure the clean categories exist (no parents, ordered).
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

  // 2) Remap every product by keyword (title + its current category name).
  const products = await prisma.product.findMany({
    select: { id: true, title: true, category: { select: { name: true, slug: true } } },
  });
  const tally: Record<string, number> = {};
  for (const p of products) {
    const slug = categorize(p.title, p.category?.name ?? '');
    await prisma.product.update({ where: { id: p.id }, data: { categoryId: idBySlug[slug] } });
    tally[slug] = (tally[slug] ?? 0) + 1;
  }

  // 3) Delete every category that is NOT in the clean set (now product-free).
  const keep = CLEAN_CATEGORIES.map((c) => c.slug);
  // children first to satisfy the self-relation, then the rest
  await prisma.category.deleteMany({ where: { slug: { notIn: keep }, parentId: { not: null } } });
  const removed = await prisma.category.deleteMany({ where: { slug: { notIn: keep } } });

  console.log('✅ Recategorized.', {
    products: products.length,
    perCategory: tally,
    oldCategoriesRemoved: removed.count,
    finalCategories: await prisma.category.count(),
  });
}

main()
  .catch((e) => {
    console.error('recategorize failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
