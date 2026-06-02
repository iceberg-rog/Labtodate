'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
}

const BlogInput = z.object({
  title: z.string().min(6).max(200),
  excerpt: z.string().max(400).optional().nullable(),
  body: z.string().min(20),
  category: z.string().max(80).optional().nullable(),
  illustration: z.enum(['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector']).optional().nullable(),
  coverImage: z.string().max(500).optional().nullable(),
  coverGradient: z.string().max(200).optional().nullable(),
  readMinutes: z.number().int().min(1).max(60).default(5),
  publish: z.boolean().default(false),
});

export type BlogInputType = z.infer<typeof BlogInput>;

async function actor() {
  return requireSession({ roles: ['ADMIN'], redirectTo: '/admin/blog' });
}

export async function createBlogPost(input: BlogInputType) {
  const parsed = BlogInput.parse(input);
  const session = await actor();
  let slug = slugify(parsed.title);
  while (await prisma.blogPost.findUnique({ where: { slug } })) {
    slug = `${slug.slice(0, 80)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  await prisma.blogPost.create({
    data: {
      slug,
      title: parsed.title,
      excerpt: parsed.excerpt ?? null,
      body: parsed.body,
      category: parsed.category ?? null,
      illustration: parsed.illustration ?? null,
      coverImage: parsed.coverImage ?? null,
      coverGradient: parsed.coverGradient ?? null,
      readMinutes: parsed.readMinutes,
      authorId: session.user.id,
      status: parsed.publish ? 'PUBLISHED' : 'DRAFT',
      publishedAt: parsed.publish ? new Date() : null,
    },
  });
  revalidatePath('/blog');
  revalidatePath('/admin/blog');
  redirect('/admin/blog');
}

export async function updateBlogPost(slug: string, input: BlogInputType) {
  const parsed = BlogInput.parse(input);
  await actor();
  const existing = await prisma.blogPost.findUnique({ where: { slug } });
  if (!existing) throw new Error('Post not found');
  await prisma.blogPost.update({
    where: { id: existing.id },
    data: {
      title: parsed.title,
      excerpt: parsed.excerpt ?? null,
      body: parsed.body,
      category: parsed.category ?? null,
      illustration: parsed.illustration ?? null,
      coverImage: parsed.coverImage ?? null,
      coverGradient: parsed.coverGradient ?? null,
      readMinutes: parsed.readMinutes,
      status: parsed.publish ? 'PUBLISHED' : existing.status,
      publishedAt: parsed.publish && !existing.publishedAt ? new Date() : existing.publishedAt,
    },
  });
  revalidatePath('/blog');
  revalidatePath(`/blog/${slug}`);
  revalidatePath('/admin/blog');
  redirect('/admin/blog');
}

const WikiInput = z.object({
  title: z.string().min(6).max(200),
  body: z.string().min(20),
  category: z.string().max(80).optional().nullable(),
  publish: z.boolean().default(false),
});

export type WikiInputType = z.infer<typeof WikiInput>;

export async function createWikiArticle(input: WikiInputType) {
  const parsed = WikiInput.parse(input);
  const session = await actor();
  let slug = slugify(parsed.title);
  while (await prisma.wikiArticle.findUnique({ where: { slug } })) {
    slug = `${slug.slice(0, 80)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  await prisma.wikiArticle.create({
    data: {
      slug,
      title: parsed.title,
      body: parsed.body,
      category: parsed.category ?? null,
      authorId: session.user.id,
      status: parsed.publish ? 'PUBLISHED' : 'DRAFT',
      publishedAt: parsed.publish ? new Date() : null,
    },
  });
  revalidatePath('/wiki');
  revalidatePath('/admin/wiki');
  redirect('/admin/wiki');
}

export async function updateWikiArticle(slug: string, input: WikiInputType) {
  const parsed = WikiInput.parse(input);
  await actor();
  const existing = await prisma.wikiArticle.findUnique({ where: { slug } });
  if (!existing) throw new Error('Article not found');
  await prisma.wikiArticle.update({
    where: { id: existing.id },
    data: {
      title: parsed.title,
      body: parsed.body,
      category: parsed.category ?? null,
      status: parsed.publish ? 'PUBLISHED' : existing.status,
      publishedAt: parsed.publish && !existing.publishedAt ? new Date() : existing.publishedAt,
    },
  });
  revalidatePath('/wiki');
  revalidatePath(`/wiki/${slug}`);
  revalidatePath('/admin/wiki');
  redirect('/admin/wiki');
}
