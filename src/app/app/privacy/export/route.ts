import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await requireSession({ redirectTo: '/app/profile' });
  const uid = session.user.id;

  const [user, orders, quotes, tickets, notifications, wishlist, cart] = await Promise.all([
    prisma.user.findUnique({
      where: { id: uid },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    }),
    prisma.order.findMany({ where: { buyerId: uid }, include: { items: true } }),
    prisma.sourcingRequest.findMany({
      where: { OR: [{ submittedById: uid }, { buyerEmail: session.user.email }] },
      include: { messages: true },
    }),
    prisma.supportTicket.findMany({
      where: { submittedById: uid },
      include: { messages: { where: { isInternalNote: false } } },
    }),
    prisma.notification.findMany({ where: { userId: uid } }),
    prisma.wishlistItem.findMany({ where: { userId: uid } }),
    prisma.cartItem.findMany({ where: { userId: uid } }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    account: user,
    orders,
    quotes,
    supportTickets: tickets,
    notifications,
    wishlist,
    cart,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="lab2date-data-${uid}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
