import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { siteName } from '@/lib/brand/identity';
import { visibleToParticipant } from '@/lib/messages/mediation';
import { participantMessages } from '@/lib/messages/view';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  await ensureSettingsLoaded();

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
  const sinceDate = since ? new Date(since) : null;

  // Cap the load: fetch the most-recent 200 (desc + take), then flip back to
  // chronological order for display. Prevents an unbounded read on a thread
  // that a participant inflates. Messages of the other side that wait for
  // (or were withheld after) staff review never leave the server.
  const messages = await prisma.message.findMany({
    where: {
      threadId: params.id,
      AND: [
        visibleToParticipant(session.user.id),
        ...(sinceDate && !isNaN(sinceDate.getTime()) ? [{ createdAt: { gt: sinceDate } }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    // Only the author id and role are needed: identities are never returned (see below).
    select: { id: true, body: true, createdAt: true, authorId: true, author: { select: { role: true } } },
  });
  messages.reverse();

  // Mark inbound messages as read (held ones already carry readAt).
  await prisma.message.updateMany({
    where: {
      threadId: params.id,
      readAt: null,
      authorId: { not: session.user.id },
    },
    data: { readAt: new Date() },
  });

  // Same masking as the inbox page (src/app/app/inbox/[id]/page.tsx): a buyer
  // only ever sees "<Site> Supplier", a seller only "<Site> Buyer", staff
  // "<Site> team" — no real names, no emails, not even in this polling payload.
  return NextResponse.json({
    messages: participantMessages(
      messages.map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, authorId: m.authorId, authorRole: m.author.role })),
      { viewerId: session.user.id, viewerIsBuyer: thread.buyerId === session.user.id, site: siteName() },
    ),
  });
}
