import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight, MessageCircle } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Read-only admin view of a buyer ↔ seller MessageThread. The user profile's
 * "Seller conversations" rows used to link to /admin/messages?q=<subject>,
 * which only searches AI-assistant chats, so these threads were invisible in
 * admin. Viewing here does NOT mark anything as read for the participants.
 */
export default async function AdminThreadPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  await requireCapability('messages:view');

  const thread = await prisma.messageThread.findUnique({
    where: { id: params.id },
    include: {
      buyer: { select: { id: true, name: true, email: true } },
      seller: { select: { id: true, name: true, email: true } },
      product: { select: { title: true, slug: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, createdAt: true, readAt: true, authorId: true },
      },
    },
  });
  if (!thread) notFound();

  const who = (authorId: string) =>
    authorId === thread.buyerId ? 'Buyer' : authorId === thread.sellerId ? 'Seller' : 'Staff';

  return (
    <div className="space-y-6 max-w-3xl">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
        <Link href="/admin/messages" className="hover:text-foreground">Messages</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">Buyer ↔ seller conversation</span>
      </nav>

      <div>
        <h1 className="text-2xl font-bold tracking-tight inline-flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-primary" /> {thread.subject || 'Conversation'}
        </h1>
        <div className="mt-2 grid sm:grid-cols-2 gap-2 text-sm">
          <p>
            <span className="text-muted-foreground">Buyer: </span>
            <Link href={`/admin/users/${thread.buyer.id}`} className="text-primary hover:underline">
              {thread.buyer.name}
            </Link>{' '}
            <span className="text-xs text-muted-foreground">{thread.buyer.email}</span>
          </p>
          <p>
            <span className="text-muted-foreground">Seller: </span>
            <Link href={`/admin/users/${thread.seller.id}`} className="text-primary hover:underline">
              {thread.seller.name}
            </Link>{' '}
            <span className="text-xs text-muted-foreground">{thread.seller.email}</span>
          </p>
          {thread.product && (
            <p className="sm:col-span-2">
              <span className="text-muted-foreground">Product: </span>
              <Link href={`/marketplace/${thread.product.slug}`} target="_blank" className="text-primary hover:underline">
                {thread.product.title}
              </Link>
            </p>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          Read-only. Participants see each other only as “Verified Supplier” / “Buyer”.
        </p>
      </div>

      <ul className="space-y-3">
        {thread.messages.length === 0 && (
          <li className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground text-center">
            No messages in this conversation.
          </li>
        )}
        {thread.messages.map((m) => {
          const role = who(m.authorId);
          return (
            <li
              key={m.id}
              className={`rounded-2xl border p-4 ${
                role === 'Buyer' ? 'border-border bg-card' : 'border-primary/30 bg-primary/5 sm:ml-10'
              }`}
            >
              <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground mb-1.5">
                <span className="font-bold uppercase tracking-wider">{role}</span>
                <span className="tabular-nums">
                  {m.createdAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                  {m.readAt ? ' · read' : ' · unread'}
                </span>
              </div>
              <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
