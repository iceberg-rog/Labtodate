'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';

export async function toggleWishlist(productSlug: string) {
  const session = await requireSession({ redirectTo: `/marketplace/${productSlug}` });
  const product = await prisma.product.findUnique({ where: { slug: productSlug }, select: { id: true } });
  if (!product) throw new Error('Product not found');

  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_productId: { userId: session.user.id, productId: product.id } },
  });

  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } });
  } else {
    await prisma.wishlistItem.create({
      data: { userId: session.user.id, productId: product.id },
    });
  }

  revalidatePath(`/marketplace/${productSlug}`);
  revalidatePath('/app/wishlist');
}

export async function isWishlisted(userId: string | null, productId: string): Promise<boolean> {
  if (!userId) return false;
  const found = await prisma.wishlistItem.findUnique({
    where: { userId_productId: { userId, productId } },
  });
  return !!found;
}
