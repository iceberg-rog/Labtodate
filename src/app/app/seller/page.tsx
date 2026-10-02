import Link from 'next/link';
import { Package, BarChart3, FileText, Plus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import type { OrderStatus } from '@prisma/client';

export const dynamic = 'force-dynamic';

// Same "paid" set and company scope as /app/seller/payouts, so the two agree.
const PAID: OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

export default async function SellerDashboardPage() {
  const session = await requireSession({
    roles: ['SELLER', 'ADMIN'],
    redirectTo: '/app/seller',
  });

  const role = (session.user as { role?: string }).role;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [productsCount, publishedCount, pendingQuotes, me] = await Promise.all([
    prisma.product.count({ where: { sellerId: session.user.id } }),
    prisma.product.count({ where: { sellerId: session.user.id, status: 'PUBLISHED' } }),
    // Same scope as the quote inbox: admins see every request.
    prisma.sourcingRequest.count({
      where: { status: 'PENDING', ...(role === 'ADMIN' ? {} : { assignedToId: session.user.id }) },
    }),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { companyId: true } }),
  ]);
  const recentSales = me?.companyId
    ? await prisma.orderItem.findMany({
        where: {
          product: { companyId: me.companyId },
          order: {
            status: { in: PAID },
            OR: [{ paidAt: { gte: since } }, { paidAt: null, createdAt: { gte: since } }],
          },
        },
        select: { priceCentsSnapshot: true, quantity: true, order: { select: { currency: true } } },
      })
    : [];
  const revenue30d = recentSales.reduce((sum, i) => sum + i.priceCentsSnapshot * i.quantity, 0);
  const revenueCurrency = recentSales[0]?.order.currency || 'EUR';

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Seller panel</h1>
          <p className="text-muted-foreground mt-1">Manage your listings, respond to quotes, and track orders.</p>
        </div>
        <Button asChild className="rounded-full font-semibold">
          <Link href="/app/seller/products/new">
            <Plus className="h-4 w-4" /> New listing
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard icon={Package} label="Listings" value={String(productsCount)} hint={`${publishedCount} live`} href="/app/seller/products" />
        <StatCard
          icon={FileText}
          label="Pending quotes"
          value={String(pendingQuotes)}
          hint={pendingQuotes === 1 ? 'Request awaiting your reply' : 'Requests awaiting your reply'}
          href="/app/seller/inbox"
        />
        <StatCard
          icon={BarChart3}
          label="Revenue (30d)"
          value={me?.companyId ? formatPrice(revenue30d, revenueCurrency) : '—'}
          hint={me?.companyId ? 'Paid orders in the last 30 days, before commission' : 'No seller company linked to your account'}
          href="/app/seller/payouts"
        />
      </div>

      <div className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">Quick actions</h2>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/app/seller/products" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:gap-2 transition-all">
            View all listings <ArrowRight className="h-4 w-4" />
          </Link>
          <span className="text-muted-foreground">·</span>
          <Link href="/app/seller/products/new" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:gap-2 transition-all">
            Add a product <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Signed in as <strong>{session.user.email}</strong>
      </p>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint: string;
  href?: string;
}) {
  const inner = (
    <div className="rounded-2xl border border-border bg-card p-5 hover:border-primary/40 transition-colors">
      <Icon className="h-5 w-5 text-muted-foreground mb-3" />
      <div className="text-2xl font-bold tracking-tight tabular-nums" style={{ letterSpacing: '-0.03em' }}>
        {value}
      </div>
      <div className="text-sm font-medium mt-0.5">{label}</div>
      <div className="text-xs text-muted-foreground mt-1">{hint}</div>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}
