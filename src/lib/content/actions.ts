'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapability } from '@/lib/auth-server';
import { audit } from '@/lib/observability';

/** Latin-only slug; titles in Persian / Arabic / CJK … strip to '' — fall back
 *  to a short random slug so the item still gets a working URL and edit link. */
function slugify(s: string): string {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) ||
    Math.random().toString(36).slice(2, 8)
  );
}

/** Visible text length of a Tiptap HTML body (tags + entities ignored). */
function textLength(html: string): number {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim().length;
}

const Title = z.string().trim()
  .min(6, 'Title must be at least 6 characters.')
  .max(200, 'Title must be at most 200 characters.');
const Body = z.string().refine((b) => textLength(b) >= 20, 'Body must be at least 20 characters of text.');

const BlogInput = z.object({
  title: Title,
  excerpt: z.string().max(400, 'Excerpt must be at most 400 characters.').optional().nullable(),
  body: Body,
  category: z.string().max(80, 'Category must be at most 80 characters.').optional().nullable(),
  illustration: z.enum(['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector']).optional().nullable(),
  coverImage: z.string().max(500).optional().nullable(),
  coverGradient: z.string().max(200).optional().nullable(),
  readMinutes: z.number().int().min(1, 'Read minutes must be 1–60.').max(60, 'Read minutes must be 1–60.').default(5),
  publish: z.boolean().default(false),
});

export type BlogInputType = z.infer<typeof BlogInput>;

/** Returned (not thrown) so the editor can show it — production builds
 *  redact thrown server-action messages. Success redirects instead. */
export type ContentResult = { ok: false; message: string };

function firstIssue(e: z.ZodError): string {
  return e.issues[0]?.message ?? 'Please check the form and try again.';
}

async function actor() {
  return requireCapability('content:write', { redirectTo: '/admin/blog' });
}

async function uniqueSlug(base: string, exists: (slug: string) => Promise<boolean>): Promise<string> {
  let slug = slugify(base);
  while (await exists(slug)) {
    slug = `${slug.slice(0, 80)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return slug;
}

export async function createBlogPost(input: BlogInputType): Promise<ContentResult | void> {
  const r = BlogInput.safeParse(input);
  if (!r.success) return { ok: false, message: firstIssue(r.error) };
  const parsed = r.data;
  const session = await actor();
  const slug = await uniqueSlug(parsed.title, async (s) => !!(await prisma.blogPost.findUnique({ where: { slug: s } })));
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

/** `publish` = keep / make it live; false = save as draft, which also takes a
 *  published post OFF the public site (it used to silently stay live). */
export async function updateBlogPost(slug: string, input: BlogInputType): Promise<ContentResult | void> {
  const r = BlogInput.safeParse(input);
  if (!r.success) return { ok: false, message: firstIssue(r.error) };
  const parsed = r.data;
  await actor();
  const existing = await prisma.blogPost.findUnique({ where: { slug } });
  if (!existing) return { ok: false, message: 'This post no longer exists — it may have been deleted.' };
  // Repair rows saved with an empty slug (non-Latin title before the fallback).
  const nextSlug = existing.slug
    ? existing.slug
    : await uniqueSlug(parsed.title, async (s) => !!(await prisma.blogPost.findUnique({ where: { slug: s } })));
  await prisma.blogPost.update({
    where: { id: existing.id },
    data: {
      slug: nextSlug,
      title: parsed.title,
      excerpt: parsed.excerpt ?? null,
      body: parsed.body,
      category: parsed.category ?? null,
      illustration: parsed.illustration ?? null,
      coverImage: parsed.coverImage ?? null,
      coverGradient: parsed.coverGradient ?? null,
      readMinutes: parsed.readMinutes,
      status: parsed.publish ? 'PUBLISHED' : 'DRAFT',
      publishedAt: parsed.publish && !existing.publishedAt ? new Date() : existing.publishedAt,
    },
  });
  revalidatePath('/blog');
  revalidatePath(`/blog/${nextSlug}`);
  revalidatePath('/admin/blog');
  redirect('/admin/blog');
}

const WikiInput = z.object({
  title: Title,
  body: Body,
  category: z.string().max(80, 'Category must be at most 80 characters.').optional().nullable(),
  publish: z.boolean().default(false),
});

export type WikiInputType = z.infer<typeof WikiInput>;

export async function createWikiArticle(input: WikiInputType): Promise<ContentResult | void> {
  const r = WikiInput.safeParse(input);
  if (!r.success) return { ok: false, message: firstIssue(r.error) };
  const parsed = r.data;
  const session = await actor();
  const slug = await uniqueSlug(parsed.title, async (s) => !!(await prisma.wikiArticle.findUnique({ where: { slug: s } })));
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

export async function updateWikiArticle(slug: string, input: WikiInputType): Promise<ContentResult | void> {
  const r = WikiInput.safeParse(input);
  if (!r.success) return { ok: false, message: firstIssue(r.error) };
  const parsed = r.data;
  await actor();
  const existing = await prisma.wikiArticle.findUnique({ where: { slug } });
  if (!existing) return { ok: false, message: 'This article no longer exists — it may have been deleted.' };
  const nextSlug = existing.slug
    ? existing.slug
    : await uniqueSlug(parsed.title, async (s) => !!(await prisma.wikiArticle.findUnique({ where: { slug: s } })));
  await prisma.wikiArticle.update({
    where: { id: existing.id },
    data: {
      slug: nextSlug,
      title: parsed.title,
      body: parsed.body,
      category: parsed.category ?? null,
      status: parsed.publish ? 'PUBLISHED' : 'DRAFT',
      publishedAt: parsed.publish && !existing.publishedAt ? new Date() : existing.publishedAt,
    },
  });
  revalidatePath('/wiki');
  revalidatePath(`/wiki/${nextSlug}`);
  revalidatePath('/admin/wiki');
  redirect('/admin/wiki');
}

/* ── List-row actions (unpublish / delete). By id, so rows with a broken
 *    (empty) slug can still be managed. ─────────────────────────────── */

export async function setBlogPostPublished(id: string, publish: boolean): Promise<void> {
  await actor();
  const post = await prisma.blogPost.findUnique({ where: { id }, select: { slug: true, publishedAt: true } });
  if (!post) return;
  await prisma.blogPost.update({
    where: { id },
    data: {
      status: publish ? 'PUBLISHED' : 'DRAFT',
      publishedAt: publish && !post.publishedAt ? new Date() : post.publishedAt,
    },
  });
  await audit(publish ? 'blog.publish' : 'blog.unpublish', post.slug || id);
  revalidatePath('/blog');
  if (post.slug) revalidatePath(`/blog/${post.slug}`);
  revalidatePath('/admin/blog');
}

export async function deleteBlogPost(id: string): Promise<void> {
  await actor();
  const post = await prisma.blogPost.findUnique({ where: { id }, select: { slug: true, title: true } });
  if (!post) return;
  // BlogComment rows cascade (onDelete: Cascade).
  await prisma.blogPost.delete({ where: { id } });
  await audit('blog.delete', post.slug || id, post.title);
  revalidatePath('/blog');
  if (post.slug) revalidatePath(`/blog/${post.slug}`);
  revalidatePath('/admin/blog');
}

export async function setWikiArticlePublished(id: string, publish: boolean): Promise<void> {
  await actor();
  const article = await prisma.wikiArticle.findUnique({ where: { id }, select: { slug: true, publishedAt: true } });
  if (!article) return;
  await prisma.wikiArticle.update({
    where: { id },
    data: {
      status: publish ? 'PUBLISHED' : 'DRAFT',
      publishedAt: publish && !article.publishedAt ? new Date() : article.publishedAt,
    },
  });
  await audit(publish ? 'wiki.publish' : 'wiki.unpublish', article.slug || id);
  revalidatePath('/wiki');
  if (article.slug) revalidatePath(`/wiki/${article.slug}`);
  revalidatePath('/admin/wiki');
}

export async function deleteWikiArticle(id: string): Promise<void> {
  await actor();
  const article = await prisma.wikiArticle.findUnique({ where: { id }, select: { slug: true, title: true } });
  if (!article) return;
  await prisma.wikiArticle.delete({ where: { id } });
  await audit('wiki.delete', article.slug || id, article.title);
  revalidatePath('/wiki');
  if (article.slug) revalidatePath(`/wiki/${article.slug}`);
  revalidatePath('/admin/wiki');
}
