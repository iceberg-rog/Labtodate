import Link from 'next/link';
import { MessageSquare, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const session = await requireSession({ redirectTo: '/app/inbox' });
  const userId = session.user.id;

  const threads = await prisma.messageThread.findMany({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
    orderBy: { lastMessageAt: 'desc' },
    include: {
      buyer: { select: { id: true, name: true, email: true } },
      seller: { select: { id: true, name: true, email: true } },
      product: { select: { title: true, slug: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, authorId: true, readAt: true, createdAt: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Inbox</h1>
        <p className="text-muted-foreground mt-1">Your buyer-seller conversations.</p>
      </div>

      {threads.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No conversations yet</p>
          <p className="text-sm text-muted-foreground mt-2">Start one from any product page.</p>
          <Button asChild className="rounded-full font-semibold mt-5">
            <Link href="/marketplace">Browse marketplace</Link>
          </Button>
        </div>
      ) : (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
          {threads.map((t) => {
            const isBuyer = t.buyerId === userId;
            // Identity is never exposed: a buyer only ever sees
            // "lab2date Verified Supplier"; a seller only "lab2date Buyer".
            const otherName = isBuyer ? 'lab2date Verified Supplier' : 'lab2date Buyer';
            const last = t.messages[0];
            const unread = last && last.authorId !== userId && !last.readAt;
            return (
              <li key={t.id}>
                <Link href={`/app/inbox/${t.id}`} className="flex items-center gap-4 p-5 hover:bg-foreground/5 transition-colors">
                  <div className="h-12 w-12 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center flex-shrink-0">
                    {isBuyer ? 'L2' : 'B'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className={`text-sm truncate ${unread ? 'font-bold' : 'font-semibold'}`}>
                        {otherName}
                      </p>
                      {last && (
                        <p className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
                          {new Date(last.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </p>
                      )}
                    </div>
                    {t.product && (
                      <p className="text-xs text-muted-foreground truncate">About: {t.product.title}</p>
                    )}
                    {last && (
                      <p className={`text-sm truncate mt-1 ${unread ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                        {last.authorId === userId ? 'You: ' : ''}
                        {last.body}
                      </p>
                    )}
                  </div>
                  {unread && <div className="h-2.5 w-2.5 rounded-full bg-accent flex-shrink-0" />}
                  <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
