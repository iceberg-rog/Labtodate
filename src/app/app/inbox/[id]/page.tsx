import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { ThreadView } from '@/components/messages/ThreadView';

export const dynamic = 'force-dynamic';

export default async function ThreadPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireSession({ redirectTo: `/app/inbox/${params.id}` });

  const thread = await prisma.messageThread.findUnique({
    where: { id: params.id },
    include: {
      buyer: { select: { id: true, name: true, email: true } },
      seller: { select: { id: true, name: true, email: true } },
      product: { select: { title: true, slug: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  if (!thread) notFound();

  const userId = session.user.id;
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

  const isBuyer = thread.buyerId === userId;
  // Identity is never exposed across the marketplace: a buyer only ever sees
  // "lab2date Verified Supplier", a seller only ever sees "lab2date Buyer".
  // All contact is mediated by lab2date — no real names, no emails, ever.
  const counterpartLabel = isBuyer ? 'lab2date Verified Supplier' : 'lab2date Buyer';

  return (
    <>
    <AutoRefresh />
    <ThreadView
      threadId={thread.id}
      otherParty={{ name: counterpartLabel, role: isBuyer ? 'seller' : 'buyer' }}
      productTitle={thread.product?.title}
      productSlug={thread.product?.slug}
      initialMessages={thread.messages.map((m) => ({
        id: m.id,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        authorName: m.author.id === userId ? 'You' : counterpartLabel,
        authorEmail: null,
        isMine: m.author.id === userId,
      }))}
    />
    </>
  );
}
