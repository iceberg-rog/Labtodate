import type { MetadataRoute } from 'next';
import { prisma } from '@/lib/db';
import { publicCaseStudyWhere } from '@/lib/catalog/consent';
import { LIVE_PRODUCT_WHERE } from '@/lib/marketplace/queries';
import { buildSitemap, SITEMAP_TEXT_KEYS } from '@/lib/seo/sitemap';

const BASE = process.env.BETTER_AUTH_URL ?? 'https://labtodate.com';

export const dynamic = 'force-dynamic'; // DB-backed; render on request, not at build

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // NOTE: /suppliers/[slug] is intentionally disabled (always 404s), so supplier
  // micro-sites are deliberately NOT in the sitemap — never list 404 URLs.
  // Rules (what is listed, which lastmod): src/lib/seo/sitemap.ts.
  const [products, categories, posts, articles, cases, facilities, texts] = await Promise.all([
    prisma.product.findMany({ where: LIVE_PRODUCT_WHERE, select: { slug: true, categoryId: true, updatedAt: true } }),
    prisma.category.findMany({ where: { products: { some: LIVE_PRODUCT_WHERE } }, select: { id: true, slug: true, updatedAt: true } }),
    prisma.blogPost.findMany({ where: { status: 'PUBLISHED' }, select: { slug: true, updatedAt: true } }),
    prisma.wikiArticle.findMany({ where: { status: 'PUBLISHED' }, select: { slug: true, updatedAt: true } }),
    prisma.caseStudy.findMany({ where: await publicCaseStudyWhere(), select: { slug: true, updatedAt: true } }),
    prisma.labFacility.findMany({ where: { isPublished: true }, select: { slug: true, updatedAt: true } }),
    prisma.setting.findMany({ where: { key: { in: [...SITEMAP_TEXT_KEYS] } }, select: { key: true, updatedAt: true } }),
  ]);

  return buildSitemap({
    base: BASE,
    products,
    categories,
    posts,
    articles,
    cases,
    facilities,
    textSavedAt: Object.fromEntries(texts.map((r) => [r.key, r.updatedAt])),
  });
}
