import Link from 'next/link';
import { Package, BarChart3, FileText, Plus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function SellerDashboardPage() {
  const session = await requireSession({
    roles: ['SELLER', 'ADMIN'],
    redirectTo: '/app/seller',
  });

  const [productsCount, publishedCount] = await Promise.all([
    prisma.product.count({ where: { sellerId: session.user.id } }),
    prisma.product.count({ where: { sellerId: session.user.id, status: 'PUBLISHED' } }),
  ]);

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
        <StatCard icon={FileText} label="Pending quotes" value="0" hint="Phase 5 — Quotes" />
        <StatCard icon={BarChart3} label="Revenue (30d)" value="€0" hint="Phase 6 — Stripe" />
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
