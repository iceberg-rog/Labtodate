'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { deleteOrArchiveProduct, productDeleteDbFrom } from '@/lib/products/delete-guard';
import { requireSession } from '@/lib/auth-server';
import { notifyAdmins } from '@/lib/observability';
import { MAX_PRICE_CENTS, MAX_PRICE_MESSAGE, zodFieldErrors, zodMessage } from '@/lib/products/validation';
import { isOwnMediaUrl, isSafeImageUrl } from '@/lib/products/image-urls';
import { Prisma, type ProductCondition, type ProductMode } from '@prisma/client';

const ProductInput = z.object({
  title: z.string().trim().min(6).max(180),
  summary: z.string().max(300).optional().nullable(),
  description: z.string().max(8000, 'Description is too long (max 8,000 characters including formatting). Please shorten it.').optional().nullable(),
  categoryId: z.string().min(1),
  brandId: z.string().optional().nullable(),
  condition: z.enum(['NEW', 'REFURBISHED', 'USED']),
  mode: z.enum(['BUY_NOW', 'QUOTE_ONLY', 'HYBRID']),
  priceCents: z.number().int().nonnegative().max(MAX_PRICE_CENTS, MAX_PRICE_MESSAGE).nullable(),
  currency: z.string().default('EUR'),
  yearMade: z.number().int().min(1900).max(2100).nullable(),
  illustration: z.enum(['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector']),
  // Where each photo may point is checked by checkImages() below.
  images: z.array(z.string().max(2048)).max(8).default([]),
  specs: z.record(z.string()).default({}),
});

export type ProductInputType = z.infer<typeof ProductInput>;

/** Returned (never thrown) when a save is rejected, so the form can show a
 *  readable message — production builds redact thrown server-action errors. */
export type ProductActionError = { ok: false; message: string; fieldErrors?: Record<string, string> };

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  summary: 'Short summary',
  description: 'Description',
  categoryId: 'Category',
  brandId: 'Brand',
  condition: 'Condition',
  mode: 'Buying mode',
  priceCents: 'Price',
  currency: 'Currency',
  yearMade: 'Year made',
  illustration: 'Fallback illustration',
  images: 'Photos',
  specs: 'Technical specs',
};

function parseInput(input: ProductInputType): { data: ProductInputType } | { error: ProductActionError } {
  const r = ProductInput.safeParse(input);
  if (r.success) return { data: r.data };
  return {
    error: {
      ok: false,
      message: zodMessage(r.error, FIELD_LABELS),
      fieldErrors: zodFieldErrors(r.error, FIELD_LABELS),
    },
  };
}

/**
 * Photos must be files from our own upload store (the form's "Add image" →
 * /api/upload). A URL already on the listing — e.g. a supplier photo from a
 * shop import — may stay if it is a plain http(s) address, so such listings
 * remain editable; no new outside URL can be added. javascript:, data: and
 * other schemes are refused always.
 */
function checkImages(images: string[], alreadyOnListing: readonly string[] = []): ProductActionError | null {
  for (const [i, url] of images.entries()) {
    if (isOwnMediaUrl(url)) continue;
    if (alreadyOnListing.includes(url) && isSafeImageUrl(url)) continue;
    const message = isSafeImageUrl(url)
      ? `Photo ${i + 1} is not one of your uploads. Remove it and add the picture with “Add image” instead.`
      : `Photo ${i + 1} has an address we can't use. Remove it and add the picture with “Add image” instead.`;
    return { ok: false, message, fieldErrors: { images: message } };
  }
  return null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

async function getActor() {
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: '/app/seller' });
  return { userId: session.user.id, role: (session.user as { role?: string }).role || 'SELLER' };
}

export async function createProduct(input: ProductInputType): Promise<ProductActionError | void> {
  const { userId } = await getActor();
  const result = parseInput(input);
  if ('error' in result) return result.error;
  const parsed = result.data;
  const imageError = checkImages(parsed.images);
  if (imageError) return imageError;

  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { companyId: true },
  });

  // Ensure unique slug — append a short random suffix if needed.
  let slug = slugify(parsed.title);
  if (slug.length < 3) slug = `product-${Date.now().toString(36)}`;
  while (await prisma.product.findUnique({ where: { slug } })) {
    slug = `${slug.slice(0, 80)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  await prisma.product.create({
    data: {
      slug,
      title: parsed.title,
      summary: parsed.summary ?? null,
      description: parsed.description ?? null,
      condition: parsed.condition as ProductCondition,
      mode: parsed.mode as ProductMode,
      status: 'PENDING_REVIEW',
      priceCents: parsed.priceCents,
      currency: parsed.currency,
      yearMade: parsed.yearMade,
      illustration: parsed.illustration,
      images: parsed.images,
      specs: Object.keys(parsed.specs).length ? (parsed.specs as Prisma.InputJsonValue) : Prisma.JsonNull,
      categoryId: parsed.categoryId,
      brandId: parsed.brandId || null,
      sellerId: userId,
      companyId: me?.companyId ?? null,
    },
  });

  revalidatePath('/app/seller/products');
  redirect('/app/seller/products?created=1');
}

export async function updateProduct(slug: string, input: ProductInputType): Promise<ProductActionError | void> {
  const { userId, role } = await getActor();
  const result = parseInput(input);
  if ('error' in result) return result.error;
  const parsed = result.data;

  const existing = await prisma.product.findUnique({ where: { slug } });
  if (!existing) return { ok: false, message: 'This listing no longer exists.' };
  if (existing.sellerId !== userId && role !== 'ADMIN') return { ok: false, message: 'You can only edit your own listings.' };
  const imageError = checkImages(parsed.images, existing.images);
  if (imageError) return imageError;

  // INVARIANTS A3: an approved listing can't be swapped for different content.
  // When a seller changes anything buyers see on a PUBLISHED listing, it goes
  // back to PENDING_REVIEW (hidden) until an admin approves it again.
  const text = (v: string | null | undefined) => (v ?? '').trim();
  const specsKey = (v: unknown) => (v && typeof v === 'object' && Object.keys(v).length ? JSON.stringify(v) : '');
  const changed =
    text(existing.title) !== text(parsed.title) ||
    text(existing.summary) !== text(parsed.summary) ||
    text(existing.description) !== text(parsed.description) ||
    existing.priceCents !== parsed.priceCents ||
    existing.currency !== parsed.currency ||
    existing.mode !== parsed.mode ||
    existing.condition !== parsed.condition ||
    existing.yearMade !== parsed.yearMade ||
    existing.categoryId !== parsed.categoryId ||
    (existing.brandId ?? null) !== (parsed.brandId || null) ||
    (existing.illustration ?? 'balance') !== parsed.illustration ||
    existing.images.join('\n') !== parsed.images.join('\n') ||
    specsKey(existing.specs) !== specsKey(parsed.specs);
  const backToReview = role !== 'ADMIN' && existing.status === 'PUBLISHED' && changed;

  await prisma.product.update({
    where: { id: existing.id },
    data: {
      ...(backToReview ? { status: 'PENDING_REVIEW' as const } : {}),
      title: parsed.title,
      summary: parsed.summary ?? null,
      description: parsed.description ?? null,
      condition: parsed.condition as ProductCondition,
      mode: parsed.mode as ProductMode,
      priceCents: parsed.priceCents,
      currency: parsed.currency,
      yearMade: parsed.yearMade,
      illustration: parsed.illustration,
      images: parsed.images,
      specs: Object.keys(parsed.specs).length ? (parsed.specs as Prisma.InputJsonValue) : Prisma.JsonNull,
      categoryId: parsed.categoryId,
      brandId: parsed.brandId || null,
    },
  });

  if (backToReview) {
    await notifyAdmins(
      'Live listing edited — needs re-review',
      `The seller changed listing ${slug}. It is hidden from buyers until you approve it again.`,
      '/admin/products?status=PENDING_REVIEW',
    );
  }

  revalidatePath('/app/seller/products');
  revalidatePath(`/marketplace/${slug}`);
  redirect(backToReview ? '/app/seller/products?updated=1&review=1' : '/app/seller/products?updated=1');
}

/**
 * Delete a product.
 *
 * BUG-004 fix: previously a seller could nuke a product that had pending
 * orders, silently cascading away reviews/wishlists/cart items and
 * orphaning OrderItems (productId → null). Any product with order history is
 * ARCHIVED instead of hard-deleted — for EVERYONE, sellers and admins alike.
 * The OrderItem.productId FK is ON DELETE RESTRICT (defense-in-depth), so even a
 * stray hard-delete cannot sever the audit link; the shared deleteOrArchiveProduct
 * helper (src/lib/products/delete-guard.ts) enforces this and is also TOCTOU-safe.
 */
export async function deleteProduct(slug: string) {
  const { userId, role } = await getActor();
  const existing = await prisma.product.findUnique({
    where: { slug },
    select: { id: true, sellerId: true },
  });
  if (!existing) return;
  if (existing.sellerId !== userId && role !== 'ADMIN') throw new Error('Forbidden');

  const outcome = await deleteOrArchiveProduct(productDeleteDbFrom(prisma), existing.id);
  revalidatePath('/app/seller/products');
  revalidatePath(`/marketplace/${slug}`);
  redirect(outcome === 'archived' ? '/app/seller/products?archived=1' : '/app/seller/products?deleted=1');
}

/**
 * Seller-side publish toggle.
 *
 * BUG-001 fix: previously sellers could flip DRAFT → PUBLISHED directly,
 * bypassing admin moderation. Now:
 *  - SELLER: DRAFT → PENDING_REVIEW ("request approval"); PUBLISHED → DRAFT
 *    ("unpublish"). They CANNOT push to PUBLISHED.
 *  - ADMIN: any transition (DRAFT/PENDING_REVIEW/PUBLISHED/ARCHIVED).
 */
export async function publishProduct(slug: string, publish: boolean) {
  const { userId, role } = await getActor();
  const existing = await prisma.product.findUnique({
    where: { slug },
    select: { id: true, sellerId: true, status: true },
  });
  if (!existing) return;
  if (existing.sellerId !== userId && role !== 'ADMIN') throw new Error('Forbidden');

  // Each outcome redirects with a flag so the list page can say what happened.
  let notice: 'published' | 'requested' | 'in-review' | 'unpublished';
  if (role === 'ADMIN') {
    await prisma.product.update({
      where: { id: existing.id },
      data: { status: publish ? 'PUBLISHED' : 'DRAFT' },
    });
    notice = publish ? 'published' : 'unpublished';
  } else {
    // Seller path — strictly gated.
    let nextStatus: 'DRAFT' | 'PENDING_REVIEW';
    if (publish) {
      if (existing.status === 'PUBLISHED' || existing.status === 'PENDING_REVIEW') {
        // Already live / already queued; idempotent no-op.
        revalidatePath('/app/seller/products');
        redirect(`/app/seller/products?notice=${existing.status === 'PUBLISHED' ? 'published' : 'in-review'}`);
      }
      // Asking to go live → enter moderation queue. Admin must approve.
      nextStatus = 'PENDING_REVIEW';
      notice = 'requested';
    } else {
      nextStatus = 'DRAFT';
      notice = 'unpublished';
    }
    await prisma.product.update({
      where: { id: existing.id },
      data: { status: nextStatus },
    });
  }

  revalidatePath('/app/seller/products');
  revalidatePath(`/marketplace/${slug}`);
  redirect(`/app/seller/products?notice=${notice}`);
}
