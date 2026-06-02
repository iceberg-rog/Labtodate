'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';

export async function markNotificationsRead() {
  const session = await requireSession({ redirectTo: '/app/notifications' });
  await prisma.notification.updateMany({
    where: { userId: session.user.id, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath('/app/notifications');
  revalidatePath('/app');
}
