'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { markDelivered } from '@/lib/fulfilment/shipments';

/**
 * Buyer-side delivery confirmation ("Mark as received"): every shipment of the
 * order is recorded as delivered by the buyer and the order becomes DELIVERED
 * (lib/fulfilment/shipments.ts — compare-and-set, so a double click or a
 * concurrent refund never regresses it). Kept for older bound forms; the order
 * page uses buyerConfirmReceiptAction.
 */
export async function confirmDelivery(orderNumber: string): Promise<void> {
  await ensureSettingsLoaded();
  const session = await requireSession({ redirectTo: `/app/orders/${orderNumber}` });
  const order = await prisma.order.findUnique({ where: { orderNumber }, select: { id: true, buyerId: true } });
  if (!order || order.buyerId !== session.user.id) throw new Error('Order not found');
  await markDelivered({ orderId: order.id, deliveredAt: new Date(), by: 'BUYER' }, { id: session.user.id, email: session.user.email });
  revalidatePath(`/app/orders/${orderNumber}`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${order.id}`);
}

/**
 * Buy now → the checkout page (lib/checkout). Kept so any existing
 * `<form action={startCheckout.bind(null, slug)}>` still works.
 */
export async function startCheckout(productSlug: string) {
  redirect(`/checkout/${productSlug}`);
}

/**
 * Legacy entry point (cached POSTs of the old address form). It no longer
 * creates an order: orders are placed only from the checkout page, where the
 * buyer sees the exact total (sell price, shipping zone, VAT engine, country
 * policy) — lib/checkout/actions.ts placeOrder.
 */
export async function startCheckoutWithAddress(productSlug: string, _formData?: FormData) {
  void _formData;
  redirect(`/checkout/${productSlug}`);
}
