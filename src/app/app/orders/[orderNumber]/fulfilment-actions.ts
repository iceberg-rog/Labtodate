'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { rateLimit } from '@/lib/ratelimit';
import { addReturnFiles, createReturnRequest, recordReturnShipment } from '@/lib/fulfilment/returns';
import { markDelivered } from '@/lib/fulfilment/shipments';

/**
 * Buyer actions on an order after it shipped: confirm receipt, report a
 * problem / request a return (RMA), add photos, enter the return tracking.
 * Every action checks that the order belongs to the signed-in buyer and
 * returns the truthful outcome (shown on the page).
 */

type R = { ok: boolean; message: string; flash?: string };

async function ownOrder(orderNumber: string) {
  const session = await requireSession({ redirectTo: `/app/orders/${orderNumber}` });
  const order = await prisma.order.findUnique({ where: { orderNumber }, select: { id: true, buyerId: true, orderNumber: true } });
  if (!order || order.buyerId !== session.user.id) return { session, order: null };
  return { session, order };
}

export async function buyerConfirmReceiptAction(fd: FormData): Promise<R> {
  const orderNumber = String(fd.get('orderNumber') ?? '');
  const { session, order } = await ownOrder(orderNumber);
  if (!order) return { ok: false, message: 'Order not found.' };
  const r = await markDelivered({ orderId: order.id, deliveredAt: new Date(), by: 'BUYER' }, { id: session.user.id, email: session.user.email });
  revalidatePath(`/app/orders/${orderNumber}`);
  revalidatePath(`/admin/orders/${order.id}`);
  return r.ok ? { ok: true, message: r.orderDelivered ? 'Thanks — the order is recorded as received. If anything is wrong with it, report it below.' : r.message, flash: r.orderDelivered ? 'received' : undefined } : r;
}

export async function buyerRequestReturnAction(fd: FormData): Promise<R> {
  const orderNumber = String(fd.get('orderNumber') ?? '');
  const { session, order } = await ownOrder(orderNumber);
  if (!order) return { ok: false, message: 'Order not found.' };
  try {
    await rateLimit('return-request', 10, 60 * 60_000);
  } catch {
    return { ok: false, message: 'Too many requests — please try again later or contact support.' };
  }
  const lines: Array<{ orderItemId: string; qty: number }> = [];
  for (const [k, v] of fd.entries()) if (k.startsWith('qty_')) lines.push({ orderItemId: k.slice(4), qty: Number(String(v) || '0') });
  const files = fd.getAll('files').filter((f): f is File => typeof f !== 'string');
  const r = await createReturnRequest(
    { orderId: order.id, reasonLabel: String(fd.get('reason') ?? ''), description: String(fd.get('description') ?? ''), lines, files, openedBy: 'BUYER' },
    { id: session.user.id, email: session.user.email },
  );
  revalidatePath(`/app/orders/${orderNumber}`);
  revalidatePath('/admin/orders/returns');
  return { ok: r.ok, message: r.message, flash: r.ok ? (/emailed you/.test(r.message) ? 'rma-sent' : 'rma-sent-nomail') : undefined };
}

export async function buyerAddReturnFilesAction(fd: FormData): Promise<R> {
  const orderNumber = String(fd.get('orderNumber') ?? '');
  const { session, order } = await ownOrder(orderNumber);
  if (!order) return { ok: false, message: 'Order not found.' };
  const files = fd.getAll('files').filter((f): f is File => typeof f !== 'string');
  const r = await addReturnFiles({ returnId: String(fd.get('returnId') ?? ''), buyerId: session.user.id, files });
  revalidatePath(`/app/orders/${orderNumber}`);
  return r;
}

export async function buyerReturnShippedAction(fd: FormData): Promise<R> {
  const orderNumber = String(fd.get('orderNumber') ?? '');
  const { session, order } = await ownOrder(orderNumber);
  if (!order) return { ok: false, message: 'Order not found.' };
  const r = await recordReturnShipment({ returnId: String(fd.get('returnId') ?? ''), buyerId: session.user.id, carrier: String(fd.get('carrier') ?? ''), tracking: String(fd.get('tracking') ?? '') });
  revalidatePath(`/app/orders/${orderNumber}`);
  revalidatePath(`/admin/orders/${order.id}`);
  return r;
}
