import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from '@/lib/auth-server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }) {
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

  const messages = await prisma.message.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { id: true, name: true, email: true } } },
  });

  // Mark inbound messages as read.
  await prisma.message.updateMany({
    where: {
      threadId: params.id,
      readAt: null,
      authorId: { not: session.user.id },
    },
    data: { readAt: new Date() },
  });

  return NextResponse.json({
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      authorName: m.author.name,
      authorEmail: m.author.email,
      isMine: m.author.id === session.user.id,
    })),
  });
}
