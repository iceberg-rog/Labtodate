'use server';

import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';

/**
 * GDPR account deletion. If the user has orders we must retain invoice
 * records for tax/accounting law, so we anonymise instead of hard-delete;
 * otherwise we fully delete. Either way all sessions are revoked.
 */
export async function deleteMyAccount(formData: FormData) {
  const session = await requireSession({ redirectTo: '/app/profile' });
  if (formData.get('confirm') !== 'on') {
    throw new Error('Please confirm you understand this is permanent.');
  }
  const uid = session.user.id;

  const orderCount = await prisma.order.count({ where: { buyerId: uid } });

  // Revoke auth (Better-Auth tables are lower-cased via @@map)
  await prisma.session.deleteMany({ where: { userId: uid } });

  if (orderCount > 0) {
    // Keep an anonymised user row for invoice/tax retention, but purge
    // everything not legally required — same footprint as a hard delete.
    await prisma.account.deleteMany({ where: { userId: uid } });
    await prisma.notification.deleteMany({ where: { userId: uid } });
    await prisma.cartItem.deleteMany({ where: { userId: uid } });
    await prisma.wishlistItem.deleteMany({ where: { userId: uid } });
    await prisma.user.update({
      where: { id: uid },
      data: {
        name: 'Deleted user',
        email: `deleted+${uid}@lab2date.invalid`,
        image: null,
      },
    });
  } else {
    await prisma.account.deleteMany({ where: { userId: uid } });
    await prisma.notification.deleteMany({ where: { userId: uid } });
    await prisma.cartItem.deleteMany({ where: { userId: uid } });
    await prisma.wishlistItem.deleteMany({ where: { userId: uid } });
    await prisma.user.delete({ where: { id: uid } });
  }

  redirect('/?account=deleted');
}
