import Link from 'next/link';
import { FileText, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function SellerInboxPage() {
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: '/app/seller/inbox' });
  const role = (session.user as { role?: string }).role;

  const items = await prisma.sourcingRequest.findMany({
    where: role === 'ADMIN' ? {} : { assignedToId: session.user.id },
    orderBy: { updatedAt: 'desc' },
    include: { product: { select: { title: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Quote inbox</h1>
        <p className="text-muted-foreground mt-1">
          {role === 'ADMIN' ? 'All sourcing requests across the platform.' : 'Quote requests routed to you.'}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <FileText className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No incoming requests</p>
          <p className="text-sm text-muted-foreground mt-2">Quote requests from buyers will appear here.</p>
        </div>
      ) : (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
          {items.map((q) => (
            <li key={q.id}>
              <Link href={`/app/seller/inbox/${q.id}`} className="p-5 flex items-center gap-4 hover:bg-foreground/5 transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">
                    {q.buyerName} · {q.buyerEmail}
                  </p>
                  <p className="font-semibold truncate">
                    {q.product?.title ?? q.productCategory ?? 'General sourcing request'}
                  </p>
                  <p className="text-sm text-muted-foreground line-clamp-1 mt-1">{q.description}</p>
                </div>
                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                  <StatusPill status={q.status} />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {new Date(q.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: 'PENDING' | 'RESPONDED' | 'ACCEPTED' | 'DECLINED' | 'CLOSED' }) {
  const map: Record<typeof status, { variant: 'success' | 'warning' | 'accent' | 'secondary'; label: string }> = {
    PENDING:   { variant: 'warning', label: 'New · awaiting reply' },
    RESPONDED: { variant: 'accent', label: 'You replied' },
    ACCEPTED:  { variant: 'success', label: 'Accepted' },
    DECLINED:  { variant: 'secondary', label: 'Declined' },
    CLOSED:    { variant: 'secondary', label: 'Closed' },
  };
  const m = map[status];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}
