import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingEnum } from '@/lib/settings';
import { siteName } from '@/lib/brand/identity';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { ThreadView } from '@/components/messages/ThreadView';
import { mediationMode, visibleToParticipant } from '@/lib/messages/mediation';
import { mediationNotice, participantLabels, participantMessages } from '@/lib/messages/view';
import { threadTicket } from '@/lib/messages/to-ticket';

export const dynamic = 'force-dynamic';

export default async function ThreadPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireSession({ redirectTo: `/app/inbox/${params.id}` });
  await ensureSettingsLoaded();
  const userId = session.user.id;

  const thread = await prisma.messageThread.findUnique({
    where: { id: params.id },
    select: {
      id: true, buyerId: true, sellerId: true,
      product: { select: { title: true, slug: true } },
      messages: {
        // The other side's messages waiting for staff review stay on the server.
        where: visibleToParticipant(userId),
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, createdAt: true, authorId: true, author: { select: { role: true } } },
      },
    },
  });
  if (!thread) notFound();
  if (thread.buyerId !== userId && thread.sellerId !== userId) notFound();

  // Mark inbound as read on view.
  await prisma.message.updateMany({
    where: {
      threadId: thread.id,
      readAt: null,
      authorId: { not: userId },
    },
    data: { readAt: new Date() },
  });

  const site = siteName();
  const isBuyer = thread.buyerId === userId;
  // Identity is never exposed across the marketplace: a buyer only ever sees
  // "<Site> Supplier", a seller only ever sees "<Site> Buyer", staff are
  // "<Site> team". What the notice says is what mediateMessage() does under
  // the current MESSAGE_MEDIATION_MODE.
  const labels = participantLabels(site);
  const moved = await threadTicket(thread.id);
  const notice = moved
    ? `This conversation continues as support ticket ${moved.ref} — ${isBuyer ? 'reply under Support in your account' : session.user.role === 'ADMIN' ? 'answer it in Admin → Tickets' : `the ${site} team answers the buyer there`}.`
    : mediationNotice(mediationMode(settingEnum('MESSAGE_MEDIATION_MODE')), site);

  return (
    <>
    <AutoRefresh />
    <ThreadView
      threadId={thread.id}
      otherParty={{ name: isBuyer ? labels.supplier : labels.buyer, role: isBuyer ? 'seller' : 'buyer' }}
      productTitle={thread.product?.title}
      productSlug={thread.product?.slug}
      notice={notice}
      closed={
        !moved ? undefined
          : isBuyer ? { href: `/app/support?sent=${encodeURIComponent(moved.ref)}`, label: 'Continue in the support ticket' }
            : session.user.role === 'ADMIN' ? { href: `/admin/tickets/${moved.ticketId}`, label: `Answer ${moved.ref} in Admin → Tickets` }
              : { href: '/app/inbox', label: 'Back to the inbox' }
      }
      initialMessages={participantMessages(
        thread.messages.map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, authorId: m.authorId, authorRole: m.author.role })),
        { viewerId: userId, viewerIsBuyer: isBuyer, site },
      )}
    />
    </>
  );
}
