'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { sellPriceOf, SELL_PRICE_SELECT } from '@/lib/pricing/server';

/**
 * Add one unit to the cart. Only what the ONE price resolver calls buyable
 * goes in: a quote-only item, a shop that forces quotes or hides its prices
 * (FORCE_QUOTE / HIDE_PRICE), a priceless or unpublished listing never does.
 */
export async function addToCart(productSlug: string, quantity = 1) {
  const session = await requireSession({ redirectTo: `/marketplace/${productSlug}` });
  const product = await prisma.product.findUnique({
    where: { slug: productSlug },
    select: { id: true, ...SELL_PRICE_SELECT },
  });
  if (!product) redirect('/marketplace?gone=1');
  const price = sellPriceOf(product);
  if (price.soldOut) redirect(`/marketplace/${productSlug}?sold=1`);
  if (!price.buyable) redirect(`/marketplace/${productSlug}?quoteonly=1`);
  const existing = await prisma.cartItem.findUnique({
    where: { userId_productId: { userId: session.user.id, productId: product.id } },
    select: { quantity: true },
  });
  const existingQty = existing?.quantity ?? 0;
  const want = Math.max(1, Math.floor(quantity) || 1) + existingQty;
  const finalQty = Math.min(want, product.quantity, 99);
  // Already holding every available unit: nothing changes, so say so instead
  // of a second "Added to cart ✓".
  if (existing && finalQty <= existingQty) redirect('/app/cart?already=1');
  await prisma.cartItem.upsert({
    where: { userId_productId: { userId: session.user.id, productId: product.id } },
    update: { quantity: finalQty },
    create: { userId: session.user.id, productId: product.id, quantity: finalQty },
  });
  revalidatePath('/app/cart');
  redirect(finalQty < want ? '/app/cart?added=1&capped=1' : '/app/cart?added=1');
}

/** Set a cart row's quantity, clamped to the units available. Returns the
 *  stored quantity and whether the request was capped so the cart can tell
 *  the buyer (and reset the input) instead of silently keeping the old value. */
export async function setCartQty(itemId: string, quantity: number): Promise<{ quantity: number; capped: boolean }> {
  const session = await requireSession({ redirectTo: '/app/cart' });
  const item = await prisma.cartItem.findUnique({
    where: { id: itemId },
    include: { product: { select: { quantity: true } } },
  });
  if (!item || item.userId !== session.user.id) {
    // Row vanished (removed in another tab / checked out) — just re-render.
    revalidatePath('/app/cart');
    return { quantity: 0, capped: false };
  }
  const requested = Math.max(1, Math.floor(quantity) || 1);
  const avail = Math.max(0, item.product?.quantity ?? 0);
  const qty = Math.max(1, Math.min(avail || 1, 99, requested));
  await prisma.cartItem.update({ where: { id: itemId }, data: { quantity: qty } });
  revalidatePath('/app/cart');
  return { quantity: qty, capped: qty < requested };
}

export async function removeFromCart(itemId: string) {
  const session = await requireSession({ redirectTo: '/app/cart' });
  await prisma.cartItem.deleteMany({ where: { id: itemId, userId: session.user.id } });
  revalidatePath('/app/cart');
}

/**
 * Legacy entry points (cached browser POSTs of older pages). They never create
 * an order any more: the order is placed only from the checkout page, where the
 * buyer sees the exact total (VAT engine, shipping zones, country policy).
 */
export async function checkoutCart() {
  redirect('/checkout/cart');
}

export async function startCartCheckoutWithAddress(_formData?: FormData) {
  void _formData;
  redirect('/checkout/cart');
}
