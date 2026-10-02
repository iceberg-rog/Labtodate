'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';

// Keep in sync with the textarea's minLength/maxLength on the product page
// (a 'use server' module can only export async functions).
const Input = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  body: z.string().trim().min(4).max(2000),
});

export async function submitReview(productSlug: string, formData: FormData) {
  const session = await requireSession({ redirectTo: `/marketplace/${productSlug}` });
  // safeParse + redirect: a thrown ZodError (e.g. a review over 2000 chars)
  // crashed the product page with the redacted server-error screen.
  // Browsers submit textarea line breaks as CRLF, so count them as one
  // character like the textarea's maxLength does.
  const body = String(formData.get('body') ?? '').replace(/\r\n/g, '\n');
  const parsed = Input.safeParse({ rating: formData.get('rating'), body });
  if (!parsed.success) {
    redirect(`/marketplace/${productSlug}?review=invalid#write-review`);
  }
  const p = parsed.data;
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
    redirect(`/marketplace/${productSlug}?review=needpurchase#write-review`);
  }

  await prisma.review.upsert({
    where: { productId_userId: { productId: product.id, userId: session.user.id } },
    update: { rating: p.rating, body: p.body },
    create: { productId: product.id, userId: session.user.id, rating: p.rating, body: p.body },
  });
  revalidatePath(`/marketplace/${productSlug}`);
}
