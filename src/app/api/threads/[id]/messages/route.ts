import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from '@/lib/auth-server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const thread = await prisma.messageThread.findUnique({
    where: { id: params.id },
    select: { buyerId: true, sellerId: true },
  });
  if (!thread) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (thread.buyerId !== session.user.id && thread.sellerId !== session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(req.url);
  const since = url.searchParams.get('since');

  const where: Record<string, unknown> = { threadId: params.id };
  if (since) {
    const date = new Date(since);
    if (!isNaN(date.getTime())) where.createdAt = { gt: date };
  }

  // Cap the load: fetch the most-recent 200 (desc + take), then flip back to
  // chronological order for display. Prevents an unbounded read on a thread
  // that a participant inflates.
  const messages = await prisma.message.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    // Only the author id is needed: identities are never returned (see below).
    include: { author: { select: { id: true } } },
  });
  messages.reverse();

  // Mark inbound messages as read.
  await prisma.message.updateMany({
    where: {
      threadId: params.id,
      readAt: null,
      authorId: { not: session.user.id },
    },
    data: { readAt: new Date() },
  });

  // Same masking as the inbox page (src/app/app/inbox/[id]/page.tsx): a buyer
  // only ever sees "lab2date Verified Supplier", a seller only "lab2date
  // Buyer" — no real names, no emails, not even in this polling payload.
  const counterpartLabel = thread.buyerId === session.user.id ? 'lab2date Verified Supplier' : 'lab2date Buyer';
  return NextResponse.json({
    messages: messages.map((m) => {
      const isMine = m.author.id === session.user.id;
      return {
        id: m.id,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        authorName: isMine ? 'You' : counterpartLabel,
        authorEmail: null,
        isMine,
      };
    }),
  });
}
