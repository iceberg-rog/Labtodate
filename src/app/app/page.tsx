import Link from 'next/link';
import { Package, FileText, MessageSquare, Heart, ArrowRight } from 'lucide-react';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function AppDashboardPage() {
  const session = await requireSession({ redirectTo: '/app' });
  const role = (session.user as { role?: string }).role || 'BUYER';
  const userId = session.user.id;

  const [orders, quotes, unread, wishlistCount] = await Promise.all([
    prisma.order.count({ where: { buyerId: userId, status: { in: ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED'] } } }),
    prisma.sourcingRequest.count({
      where: {
        OR: [{ submittedById: userId }, { buyerEmail: session.user.email }],
        status: { in: ['PENDING', 'RESPONDED'] },
      },
    }),
    prisma.message.count({
      where: {
        thread: { OR: [{ buyerId: userId }, { sellerId: userId }] },
        readAt: null,
        authorId: { not: userId },
      },
    }),
    prisma.wishlistItem.count({ where: { userId } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Welcome back, {session.user.name.split(' ')[0]}</h1>
        <p className="text-muted-foreground mt-1">
          Role:{' '}
          <span className="inline-flex items-center rounded-full bg-accent/15 text-primary px-2 py-0.5 text-xs font-bold uppercase tracking-wider">
            {role}
          </span>
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Package} label="Active orders" value={String(orders)} href="/app/orders" />
        <StatCard icon={FileText} label="Open quotes" value={String(quotes)} href="/app/quotes" />
        <StatCard icon={MessageSquare} label="Unread messages" value={String(unread)} href="/app/inbox" />
        <StatCard icon={Heart} label="Wishlist items" value={String(wishlistCount)} href="/app/wishlist" />
      </div>

      <div className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">Quick actions</h2>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/marketplace" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:gap-2 transition-all">
            Browse marketplace <ArrowRight className="h-4 w-4" />
          </Link>
          <span className="text-muted-foreground">·</span>
          <Link href="/let-us-find-it" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:gap-2 transition-all">
            Request a quote <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  href: string;
}) {
  return (
    <Link href={href} className="rounded-2xl border border-border bg-card p-5 hover:border-primary/40 hover:shadow-md transition-all">
      <Icon className="h-5 w-5 text-muted-foreground mb-3" />
      <div className="text-3xl font-bold tracking-tight tabular-nums" style={{ letterSpacing: '-0.035em' }}>
        {value}
      </div>
      <div className="text-sm font-medium mt-0.5">{label}</div>
    </Link>
  );
}
