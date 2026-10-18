import Link from 'next/link';
import { Package, BarChart3, FileText, Plus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatMoney, loadSupplierSales, saleStage, totalsByCurrency } from '@/lib/sellers/supplier-sales';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Seller panel' };

export default async function SellerDashboardPage() {
  const session = await requireSession({
    roles: ['SELLER', 'ADMIN'],
    redirectTo: '/app/seller',
  });

  const role = (session.user as { role?: string }).role;
  // Staff see other people's quotes / offers only with the permission for them (A31).
  const staffView = role === 'ADMIN' && (await hasCapability('quotes:view'));
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const mine = { sellerId: session.user.id };
  // Same scope as the quote inbox: admins see every request. Open = still
  // being negotiated (PENDING or RESPONDED), not archived.
  const quoteScope = { archivedAt: null, ...(staffView ? {} : { assignedToId: session.user.id }) };
  const [productsCount, liveCount, soldOutCount, inReviewCount, openQuotes, awaitingReply, sales] = await Promise.all([
    prisma.product.count({ where: mine }),
    // Live = published AND still in stock: a sold unit is not live (G1).
    prisma.product.count({ where: { ...mine, status: 'PUBLISHED', quantity: { gt: 0 } } }),
    prisma.product.count({ where: { ...mine, status: 'PUBLISHED', quantity: { lte: 0 } } }),
    prisma.product.count({ where: { ...mine, status: 'PENDING_REVIEW' } }),
    prisma.sourcingRequest.count({ where: { ...quoteScope, status: { in: ['PENDING', 'RESPONDED'] } } }),
    prisma.sourcingRequest.count({ where: { ...quoteScope, status: 'PENDING' } }),
    // Same sales and amounts as /app/seller/payouts: the supplier price, never our sell price.
    loadSupplierSales(session.user.id),
  ]);
  const recent = sales.filter((l) => (l.paidAt ?? new Date(0)) >= since);
  const recentTotals = totalsByCurrency(recent);
  const toDispatch = sales.filter((l) => saleStage(l) === 'paid');
  const listingsHint = [
    `${liveCount} live`,
    soldOutCount ? `${soldOutCount} sold out` : '',
    inReviewCount ? `${inReviewCount} in review` : '',
  ].filter(Boolean).join(' · ');

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
        <StatCard icon={Package} label="Listings" value={String(productsCount)} hint={listingsHint} href="/app/seller/products" />
        <StatCard
          icon={FileText}
          label="Open quotes"
          value={String(openQuotes)}
          hint={`${awaitingReply} awaiting ${staffView ? 'a reply' : 'your reply'}`}
          href="/app/seller/inbox"
        />
        <StatCard
          icon={BarChart3}
          label="Sales (30 days)"
          value={recentTotals.length ? recentTotals.map((t) => formatMoney(t.cents, t.currency)).join(' + ') : '—'}
          hint={`${recent.length} sold ${recent.length === 1 ? 'item' : 'items'} at your price, excl. VAT`}
          href="/app/seller/payouts"
        />
      </div>

      {toDispatch.length > 0 && (
        <div className="rounded-2xl border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-5">
          <h2 className="text-sm font-bold">Sold — prepare for dispatch ({toDispatch.length})</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {toDispatch.slice(0, 5).map((l) => (
              <li key={l.key} className="flex flex-wrap gap-x-2">
                <span className="font-mono text-xs text-muted-foreground">{l.orderNumber}</span>
                {l.quoteId ? (
                  <Link href={`/app/seller/inbox/${l.quoteId}`} className="font-semibold hover:text-primary" dir="auto">{l.title}</Link>
                ) : (
                  <span className="font-semibold" dir="auto">{l.title}</span>
                )}
                {l.quantity > 1 && <span className="text-muted-foreground">× {l.quantity}</span>}
              </li>
            ))}
          </ul>
          {toDispatch.length > 5 && (
            <Link href="/app/seller/payouts" className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary">
              All sales <ArrowRight className="h-4 w-4" />
            </Link>
          )}
        </div>
      )}

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
