import type { MetadataRoute } from 'next';
import { prisma } from '@/lib/db';

const BASE = process.env.BETTER_AUTH_URL ?? 'https://lab2date.com';

export const dynamic = 'force-dynamic'; // DB-backed; render on request, not at build

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [products, categories, posts, articles, cases, facilities, suppliers] = await Promise.all([
    prisma.product.findMany({ where: { status: 'PUBLISHED' }, select: { slug: true, updatedAt: true } }),
    prisma.category.findMany({ select: { slug: true, updatedAt: true } }),
    prisma.blogPost.findMany({ where: { status: 'PUBLISHED' }, select: { slug: true, updatedAt: true } }),
    prisma.wikiArticle.findMany({ where: { status: 'PUBLISHED' }, select: { slug: true, updatedAt: true } }),
    prisma.caseStudy.findMany({ where: { status: 'PUBLISHED' }, select: { slug: true, updatedAt: true } }),
    prisma.labFacility.findMany({ where: { isPublished: true }, select: { slug: true, updatedAt: true } }),
    prisma.company.findMany({ where: { isFeatured: true }, select: { slug: true, updatedAt: true } }),
  ]);

  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE, lastModified: new Date(), changeFrequency: 'daily', priority: 1.0 },
    { url: `${BASE}/marketplace`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.9 },
    { url: `${BASE}/let-us-find-it`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/blog`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE}/wiki`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE}/lab-rental`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE}/case-studies`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE}/sell`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.6 },
  ];

  return [
    ...staticPages,
    ...products.map((p) => ({ url: `${BASE}/marketplace/${p.slug}`, lastModified: p.updatedAt, changeFrequency: 'weekly' as const, priority: 0.7 })),
    ...categories.map((c) => ({ url: `${BASE}/marketplace?category=${c.slug}`, lastModified: c.updatedAt, changeFrequency: 'weekly' as const, priority: 0.6 })),
    ...posts.map((p) => ({ url: `${BASE}/blog/${p.slug}`, lastModified: p.updatedAt, changeFrequency: 'monthly' as const, priority: 0.6 })),
    ...articles.map((a) => ({ url: `${BASE}/wiki/${a.slug}`, lastModified: a.updatedAt, changeFrequency: 'monthly' as const, priority: 0.5 })),
    ...cases.map((c) => ({ url: `${BASE}/case-studies/${c.slug}`, lastModified: c.updatedAt, changeFrequency: 'monthly' as const, priority: 0.6 })),
    ...facilities.map((f) => ({ url: `${BASE}/lab-rental/${f.slug}`, lastModified: f.updatedAt, changeFrequency: 'monthly' as const, priority: 0.5 })),
    ...suppliers.map((s) => ({ url: `${BASE}/suppliers/${s.slug}`, lastModified: s.updatedAt, changeFrequency: 'monthly' as const, priority: 0.5 })),
  ];
}
