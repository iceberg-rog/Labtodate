'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { Prisma, type ProductCondition, type ProductMode } from '@prisma/client';

const ProductInput = z.object({
  title: z.string().min(6).max(180),
  summary: z.string().max(300).optional().nullable(),
  description: z.string().max(8000).optional().nullable(),
  categoryId: z.string().min(1),
  brandId: z.string().optional().nullable(),
  condition: z.enum(['NEW', 'REFURBISHED', 'USED']),
  mode: z.enum(['BUY_NOW', 'QUOTE_ONLY', 'HYBRID']),
  priceCents: z.number().int().nonnegative().nullable(),
  currency: z.string().default('EUR'),
  yearMade: z.number().int().min(1900).max(2100).nullable(),
  illustration: z.enum(['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector']),
  images: z.array(z.string().url()).max(8).default([]),
  specs: z.record(z.string()).default({}),
});

export type ProductInputType = z.infer<typeof ProductInput>;

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

export async function createProduct(input: ProductInputType) {
  const parsed = ProductInput.parse(input);
  const { userId } = await getActor();

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

export async function updateProduct(slug: string, input: ProductInputType) {
  const parsed = ProductInput.parse(input);
  const { userId, role } = await getActor();

  const existing = await prisma.product.findUnique({ where: { slug }, select: { id: true, sellerId: true } });
  if (!existing) throw new Error('Product not found');
  if (existing.sellerId !== userId && role !== 'ADMIN') throw new Error('Forbidden');

  await prisma.product.update({
    where: { id: existing.id },
    data: {
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

  revalidatePath('/app/seller/products');
  revalidatePath(`/marketplace/${slug}`);
  redirect('/app/seller/products?updated=1');
}

/**
 * Delete a product.
 *
 * BUG-004 fix: previously a seller could nuke a product that had pending
 * orders, silently cascading away reviews/wishlists/cart items and
 * orphaning OrderItems (productId → null). We now refuse hard-delete if
 * any OrderItem references this product on a non-terminal order. Sellers
 * who want to remove a live product should ARCHIVE instead.
 *
 * Admins can still hard-delete (e.g. for legal takedown), but for products
 * with order history we route through ARCHIVED to preserve audit + invoice
 * regeneration.
 */
export async function deleteProduct(slug: string) {
  const { userId, role } = await getActor();
  const existing = await prisma.product.findUnique({
    where: { slug },
    select: { id: true, sellerId: true },
  });
  if (!existing) return;
  if (existing.sellerId !== userId && role !== 'ADMIN') throw new Error('Forbidden');

  // Block hard-delete if there's ANY order history (terminal or not).
  // Terminal orders (DELIVERED/CANCELED/REFUNDED) still need the product
  // row for invoice regeneration + chargeback defence.
  const hasOrderHistory = await prisma.orderItem.findFirst({
    where: { productId: existing.id },
    select: { id: true },
  });
  if (hasOrderHistory) {
    // Route to archive instead — preserves all FK relations.
    await prisma.product.update({
      where: { id: existing.id },
      data: { status: 'ARCHIVED' },
    });
    revalidatePath('/app/seller/products');
    revalidatePath(`/marketplace/${slug}`);
    redirect('/app/seller/products?archived=1');
  }

  await prisma.product.delete({ where: { id: existing.id } });
  revalidatePath('/app/seller/products');
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

  if (role === 'ADMIN') {
    await prisma.product.update({
      where: { id: existing.id },
      data: { status: publish ? 'PUBLISHED' : 'DRAFT' },
    });
  } else {
    // Seller path — strictly gated.
    let nextStatus: 'DRAFT' | 'PENDING_REVIEW';
    if (publish) {
      if (existing.status === 'PUBLISHED') {
        // Already live; idempotent no-op.
        revalidatePath('/app/seller/products');
        return;
      }
      // Asking to go live → enter moderation queue. Admin must approve.
      nextStatus = 'PENDING_REVIEW';
    } else {
      nextStatus = 'DRAFT';
    }
    await prisma.product.update({
      where: { id: existing.id },
      data: { status: nextStatus },
    });
  }

  revalidatePath('/app/seller/products');
  revalidatePath(`/marketplace/${slug}`);
}
