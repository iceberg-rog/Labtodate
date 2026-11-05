'use server';

import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { audit } from '@/lib/observability';

/** Orders that are still being handled — the buyer must keep access to them. */
const IN_PROGRESS = ['PAID', 'PROCESSING', 'SHIPPED'] as const;

/**
 * GDPR account deletion (self-service, Profile → Delete account).
 *
 * Orders and invoices must be kept for tax/accounting law, so a user with any
 * history is ANONYMISED (personal data removed, login impossible) instead of
 * hard-deleted; a user with no history at all is deleted. Either way every
 * session is revoked. Refused while an order is still being fulfilled or a
 * payment proof is under review, and for admins (an admin removes another
 * admin's access from the Users page — never their own, so the shop can't end
 * up without one).
 */
export async function deleteMyAccount(formData: FormData) {
  const session = await requireSession({ redirectTo: '/app/profile' });
  if (formData.get('confirm') !== 'on') redirect('/app/profile?delete=confirm');
  const uid = session.user.id;
  const role = (session.user as { role?: string }).role;
  if (role === 'ADMIN') redirect('/app/profile?delete=admin');

  const [busy, orderCount, quoteCount, sellCount, ticketCount] = await Promise.all([
    prisma.order.count({
      where: {
        buyerId: uid,
        OR: [
          { status: { in: [...IN_PROGRESS] } },
          { status: 'PENDING_PAYMENT', paymentSubmittedAt: { not: null } },
        ],
      },
    }),
    prisma.order.count({ where: { buyerId: uid } }),
    prisma.sourcingRequest.count({ where: { submittedById: uid } }),
    prisma.sellSubmission.count({ where: { submittedById: uid } }).catch(() => 0),
    prisma.supportTicket.count({ where: { submittedById: uid } }).catch(() => 0),
  ]);
  if (busy > 0) redirect('/app/profile?delete=orders');

  const anonEmail = `deleted+${uid}@labtodate.invalid`;
  const hasHistory = orderCount + quoteCount + sellCount + ticketCount > 0;

  await prisma.session.deleteMany({ where: { userId: uid } });
  await prisma.account.deleteMany({ where: { userId: uid } });
  await prisma.notification.deleteMany({ where: { userId: uid } });
  await prisma.cartItem.deleteMany({ where: { userId: uid } });
  await prisma.wishlistItem.deleteMany({ where: { userId: uid } });

  let deleted = false;
  if (!hasHistory) {
    try {
      await prisma.user.delete({ where: { id: uid } });
      deleted = true;
    } catch {
      // Some other row still points at the user — anonymise instead.
    }
  }
  if (!deleted) {
    // Quotes without a sale carry no legal retention duty: drop the personal
    // fields. Orders keep their address snapshot (needed on the invoice).
    await prisma.sourcingRequest.updateMany({
      where: { submittedById: uid },
      data: { buyerName: 'Deleted user', buyerEmail: anonEmail },
    }).catch(() => {});
    await prisma.user.update({
      where: { id: uid },
      data: { name: 'Deleted user', email: anonEmail, image: null, emailVerified: false },
    });
  }
  await audit('account.delete', uid, deleted ? 'self-service, hard delete' : 'self-service, anonymised (history retained)');

  redirect('/?account=deleted');
}
