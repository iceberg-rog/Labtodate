'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapability } from '@/lib/auth-server';
import { audit } from '@/lib/observability';
import { readVerifiedUpload } from '@/lib/storage/file-type';
import { uploadObject } from '@/lib/storage/s3';
import { firstPublicImage, ownMediaPath } from '@/lib/media/public-src';
import { isCategoryIcon } from '@/lib/home/category-icons';
import { invalidateHomeLanding } from '@/lib/home-landing-data';
import { zodMessage } from '@/lib/products/validation';
import { categorySlug, cleanSlugInput } from './slug';

type Result = { ok: boolean; message: string };

// Returned, never thrown: they run from form submits, and a thrown error became a full-page 500.

const intOrNull = z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.coerce.number().int().min(0).max(9999).nullable());
const textOrNull = (max: number) => z.preprocess((v) => (typeof v === 'string' && v.trim() ? v.trim() : null), z.string().max(max).nullable());

const CategoryForm = z.object({
  name: z.string().trim().min(2).max(80),
  slug: textOrNull(80),
  description: textOrNull(1000),
  icon: textOrNull(40),
  imageUrl: textOrNull(2048),
  parentId: textOrNull(40),
  sortOrder: z.preprocess((v) => (v === '' || v == null ? 0 : v), z.coerce.number().int().min(0).max(9999)),
  homeOrder: intOrNull,
  showOnHome: z.boolean(),
  seoTitle: textOrNull(70),
  seoDescription: textOrNull(170),
});
const LABELS = {
  name: 'Name', slug: 'Slug', description: 'Intro', icon: 'Icon', imageUrl: 'Picture', parentId: 'Parent', sortOrder: 'Sort order',
  homeOrder: 'Homepage order', seoTitle: 'Search title', seoDescription: 'Search description',
};

function read(fd: FormData) {
  const s = (k: string) => {
    const v = fd.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  return CategoryForm.safeParse({
    name: s('name') ?? '',
    slug: s('slug'),
    description: s('description'),
    icon: s('icon'),
    imageUrl: s('imageUrl'),
    parentId: s('parentId'),
    sortOrder: s('sortOrder'),
    homeOrder: s('homeOrder'),
    showOnHome: fd.get('showOnHome') === 'on',
    seoTitle: s('seoTitle'),
    seoDescription: s('seoDescription'),
  });
}

/**
 * The category picture as stored: a photo from our own media store (“/media/…”),
 * an uploaded file (stored there), or product:<slug> = that listing's first own
 * photo. Another site's image is refused — the homepage only shows our own media.
 */
async function resolveImage(fd: FormData, typed: string | null, slug: string): Promise<{ ok: true; url: string | null } | { ok: false; message: string }> {
  const file = fd.get('imageFile');
  if (file instanceof File && file.size > 0) {
    const checked = await readVerifiedUpload(file, { allow: ['jpeg', 'png', 'webp'], maxBytes: 6 * 1024 * 1024, label: 'Picture' });
    if (!checked.ok) return { ok: false, message: checked.error };
    try {
      const { url } = await uploadObject(`products/categories/${slug}-${Date.now()}.${checked.upload.ext}`, checked.upload.buf, checked.upload.mime);
      return { ok: true, url: ownMediaPath(url) ?? url };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? `Upload failed: ${e.message.slice(0, 140)}` : 'Upload failed.' };
    }
  }
  if (!typed) return { ok: true, url: null };
  const m = typed.match(/^product:(.+)$/i);
  if (m) {
    const p = await prisma.product.findUnique({ where: { slug: m[1].trim().toLowerCase() }, select: { images: true } });
    const img = p ? firstPublicImage(p.images) : null;
    return img ? { ok: true, url: img } : { ok: false, message: `Picture: “${m[1].trim()}” is not a listing with a photo of our own.` };
  }
  const own = ownMediaPath(typed);
  return own ? { ok: true, url: own } : { ok: false, message: 'Picture: use a photo from your own media store (/media/…), upload one, or product:<listing-slug> — another site’s image cannot be shown.' };
}

/** A parent must exist and must not be the category itself or one of its descendants. */
async function parentProblem(id: string | null, parentId: string | null): Promise<string | null> {
  if (!parentId) return null;
  if (parentId === id) return 'Parent: a category cannot be its own parent.';
  let at: string | null = parentId;
  for (let hops = 0; at && hops < 50; hops++) {
    const row: { id: string; parentId: string | null } | null = await prisma.category.findUnique({ where: { id: at }, select: { id: true, parentId: true } });
    if (!row) return hops === 0 ? 'Parent: that category no longer exists.' : null;
    if (id && row.parentId === id) return 'Parent: that category sits under this one — choose another parent.';
    at = row.parentId;
  }
  return null;
}

function changed(): void {
  invalidateHomeLanding();
  revalidatePath('/admin/categories');
  revalidatePath('/admin/homepage');
  revalidatePath('/marketplace');
  revalidatePath('/');
}

/**
 * Add a category. The slug (its links: /marketplace?category=<slug>) is the one
 * typed, else made from the name — transliterated for Persian, Arabic, Cyrillic
 * or Greek names — and kept unique; a name with no letters a link can use asks
 * for a slug.
 */
export async function createCategory(fd: FormData): Promise<Result> {
  await requireCapability('categories:manage', { redirectTo: '/admin' });
  const r = read(fd);
  if (!r.success) return { ok: false, message: zodMessage(r.error, LABELS) };
  const v = r.data;
  const dup = await prisma.category.findFirst({ where: { name: { equals: v.name, mode: 'insensitive' } }, select: { id: true } });
  if (dup) return { ok: false, message: `A category named “${v.name}” already exists.` };

  let slug: string;
  if (v.slug) {
    const typed = cleanSlugInput(v.slug);
    if (!typed) return { ok: false, message: 'Slug: use Latin letters, digits and hyphens, e.g. gas-chromatography.' };
    if (await prisma.category.findUnique({ where: { slug: typed }, select: { id: true } })) return { ok: false, message: `Slug “${typed}” is already used by another category.` };
    slug = typed;
  } else {
    const base = categorySlug(v.name);
    if (!base) return { ok: false, message: `“${v.name}” has no letters a link can use — enter a slug (Latin letters, digits and hyphens), e.g. chromatography.` };
    slug = base;
    for (let n = 2; await prisma.category.findUnique({ where: { slug }, select: { id: true } }); n++) slug = `${base.slice(0, 64)}-${n}`;
  }
  if (v.icon && !isCategoryIcon(v.icon)) return { ok: false, message: 'Icon: choose one from the list.' };
  const parent = await parentProblem(null, v.parentId);
  if (parent) return { ok: false, message: parent };
  const img = await resolveImage(fd, v.imageUrl, slug);
  if (!img.ok) return { ok: false, message: img.message };
  const count = await prisma.category.count();
  await prisma.category.create({
    data: {
      slug, name: v.name, description: v.description, icon: v.icon, imageUrl: img.url, parentId: v.parentId,
      sortOrder: fd.get('sortOrder') ? v.sortOrder : count, showOnHome: v.showOnHome, homeOrder: v.homeOrder,
      seoTitle: v.seoTitle, seoDescription: v.seoDescription,
    },
  });
  await audit('category.create', slug, v.name);
  changed();
  return { ok: true, message: `Category “${v.name}” added (link: /marketplace?category=${slug}).` };
}

/** Save a category's details. The slug stays (links and search results point at it). */
export async function updateCategory(fd: FormData): Promise<Result> {
  await requireCapability('categories:manage', { redirectTo: '/admin' });
  const id = String(fd.get('id') ?? '');
  const r = read(fd);
  if (!r.success) return { ok: false, message: zodMessage(r.error, LABELS) };
  const v = r.data;
  const existing = await prisma.category.findUnique({ where: { id }, select: { id: true, slug: true, name: true, imageUrl: true } });
  if (!existing) return { ok: false, message: 'Category not found — it may have been deleted.' };
  const dup = await prisma.category.findFirst({ where: { name: { equals: v.name, mode: 'insensitive' }, NOT: { id } }, select: { id: true } });
  if (dup) return { ok: false, message: `Another category is already named “${v.name}”.` };
  if (v.icon && !isCategoryIcon(v.icon)) return { ok: false, message: 'Icon: choose one from the list.' };
  const parent = await parentProblem(id, v.parentId);
  if (parent) return { ok: false, message: parent };
  const img = await resolveImage(fd, v.imageUrl, existing.slug);
  if (!img.ok) return { ok: false, message: img.message };
  await prisma.category.update({
    where: { id },
    data: {
      name: v.name, description: v.description, icon: v.icon, imageUrl: img.url, parentId: v.parentId, sortOrder: v.sortOrder,
      showOnHome: v.showOnHome, homeOrder: v.homeOrder, seoTitle: v.seoTitle, seoDescription: v.seoDescription,
    },
  });
  await audit('category.update', existing.slug, existing.name !== v.name ? `renamed “${existing.name}” → “${v.name}”` : undefined);
  changed();
  return { ok: true, message: `Saved “${v.name}” — the homepage and the marketplace show it on the next load.` };
}

export async function deleteCategory(id: string): Promise<Result> {
  await requireCapability('categories:manage', { redirectTo: '/admin' });
  const [products, children] = await Promise.all([
    prisma.product.count({ where: { categoryId: id } }),
    prisma.category.count({ where: { parentId: id } }),
  ]);
  if (products > 0) return { ok: false, message: `Cannot delete: ${products} product(s) still use this category.` };
  if (children > 0) return { ok: false, message: `Cannot delete: it has ${children} sub-categor${children === 1 ? 'y' : 'ies'}.` };
  const cat = await prisma.category.findUnique({ where: { id }, select: { name: true, slug: true } });
  if (!cat) return { ok: false, message: 'Category not found — it may already be deleted.' };
  await prisma.category.delete({ where: { id } });
  await audit('category.delete', cat.slug, cat.name);
  changed();
  return { ok: true, message: `Category “${cat.name}” deleted.` };
}
