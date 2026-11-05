'use server';

import { revalidatePath } from 'next/cache';
import { getServerSession, hasCapability } from '@/lib/auth-server';
import { audit } from '@/lib/observability';
import { sendOrderInvoice } from '@/lib/orders/internal';
import { prisma } from '@/lib/db';

export async function resendOrderDocuments(orderId: string): Promise<{ ok: boolean; message: string }> {
  const session = await getServerSession();
  if (!session?.user || session.user.role !== 'ADMIN' || !(await hasCapability('orders:fulfil'))) {
    return { ok: false, message: 'Your admin account lacks the “orders:fulfil” permission.' };
  }
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } });
  if (!order) return { ok: false, message: 'Order not found.' };
  await sendOrderInvoice(orderId, session.user.id);
  await audit('documents.order.resend', order.orderNumber, session.user.email).catch(() => {});
  revalidatePath(`/admin/orders/${orderId}/invoice`);
  return { ok: true, message: 'Sent. Check the e-mail log if the buyer says it did not arrive.' };
}
