'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';

const Input = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  body: z.string().min(4).max(2000),
});

export async function submitReview(productSlug: string, formData: FormData) {
  const session = await requireSession({ redirectTo: `/marketplace/${productSlug}` });
  const p = Input.parse({ rating: formData.get('rating'), body: formData.get('body') });
  const product = await prisma.product.findUnique({
    where: { slug: productSlug },
    select: { id: true },
  });
  if (!product) throw new Error('Product not found');

  // Only verified buyers may review: the user must have an order for this
  // product that actually reached (or passed) payment.
  const purchased = await prisma.orderItem.findFirst({
    where: {
      productId: product.id,
      order: {
        buyerId: session.user.id,
        status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
      },
    },
    select: { id: true },
  });
  if (!purchased) {
    redirect(`/marketplace/${productSlug}?review=needpurchase`);
  }

  await prisma.review.upsert({
    where: { productId_userId: { productId: product.id, userId: session.user.id } },
    update: { rating: p.rating, body: p.body },
    create: { productId: product.id, userId: session.user.id, rating: p.rating, body: p.body },
  });
  revalidatePath(`/marketplace/${productSlug}`);
}
