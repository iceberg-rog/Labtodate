import {
  TrendingUp,
  Package,
  Users,
  Banknote,
  ShoppingCart,
  FileText,
  Wrench,
  LifeBuoy,
} from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { OrderStatus, QuoteStatus } from '@prisma/client';
import { LineChart, BarList, FunnelChart, Donut } from '@/components/admin/Charts';

export const dynamic = 'force-dynamic';
export const revalidate = 60;

const PAID: OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

type Range = '7d' | '30d' | '90d';

function bucketsFor(range: Range): { since: Date; days: number; granularityDays: number } {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const granularityDays = range === '90d' ? 7 : 1;
  return { since: new Date(Date.now() - days * 864e5), days, granularityDays };
}

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: { range?: string };
}) {
  await requireCapability('analytics:view');
  const range = (searchParams.range === '7d' || searchParams.range === '90d' ? searchParams.range : '30d') as Range;
  const { since, days, granularityDays } = bucketsFor(range);

  const [
    aggAll,
    aggRange,
    paidCount,
    orders30Count,
    users30,
    productsLive,
    byStatus,
    topCats,
    rangeOrders,
    rangeNewUsers,
    rangeQuotes,
    rangeSells,
    rangeTickets,
    topProducts,
  ] = await Promise.all([
    prisma.order.aggregate({ _sum: { totalCents: true }, _avg: { totalCents: true }, where: { status: { in: PAID } } }),
    prisma.order.aggregate({ _sum: { totalCents: true }, where: { status: { in: PAID }, createdAt: { gte: since } } }),
    prisma.order.count({ where: { status: { in: PAID } } }),
    prisma.order.count({ where: { createdAt: { gte: since } } }),
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.product.count({ where: { status: 'PUBLISHED' } }),
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.category.findMany({
      select: { name: true, _count: { select: { products: { where: { status: 'PUBLISHED' } } } } },
      orderBy: { products: { _count: 'desc' } },
      take: 8,
    }),
    prisma.order.findMany({
      where: { createdAt: { gte: since } },
      select: { totalCents: true, currency: true, status: true, createdAt: true },
    }),
    prisma.user.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true },
    }),
    prisma.sourcingRequest.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, createdAt: true },
    }),
    prisma.sellSubmission.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, createdAt: true },
    }),
    prisma.supportTicket.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, createdAt: true },
    }),
    prisma.orderItem.groupBy({
      by: ['productId'],
      where: { order: { status: { in: PAID }, createdAt: { gte: since } } },
      _sum: { quantity: true, priceCentsSnapshot: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 8,
    }),
  ]);

  const revenueAll = aggAll._sum.totalCents ?? 0;
  const revenueRange = aggRange._sum.totalCents ?? 0;
  const aov = Math.round(aggAll._avg.totalCents ?? 0);
  const currency = rangeOrders[0]?.currency ?? 'EUR';

  // Bucket revenue + new users into the time series.
  const buckets = Math.ceil(days / granularityDays);
  const rev: number[] = new Array(buckets).fill(0);
  const ord: number[] = new Array(buckets).fill(0);
  const usr: number[] = new Array(buckets).fill(0);
  function idx(d: Date) {
    const ageDays = (Date.now() - d.getTime()) / 864e5;
    return Math.min(buckets - 1, Math.max(0, buckets - 1 - Math.floor(ageDays / granularityDays)));
  }
  for (const o of rangeOrders) {
    if (PAID.includes(o.status)) rev[idx(o.createdAt)] += o.totalCents;
    ord[idx(o.createdAt)] += 1;
  }
  for (const u of rangeNewUsers) usr[idx(u.createdAt)] += 1;

  const labelFor = (i: number) => {
    const ageDays = (buckets - 1 - i) * granularityDays;
    const d = new Date(Date.now() - ageDays * 864e5);
    if (granularityDays === 7) {
      return `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`;
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const revData = rev.map((v, i) => ({ label: labelFor(i), value: v }));
  const ordData = ord.map((v, i) => ({ label: labelFor(i), value: v }));
  const usrData = usr.map((v, i) => ({ label: labelFor(i), value: v }));

  // Top product titles for the bar list.
  const productIds = topProducts.map((p) => p.productId).filter((id): id is string => !!id);
  const productMap = new Map(
    (await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, title: true, slug: true },
    })).map((p) => [p.id, p]),
  );
  const topProductRows = topProducts
    .map((p) => {
      const meta = p.productId ? productMap.get(p.productId) : null;
      const units = p._sum?.quantity ?? 0;
      // priceCentsSnapshot is per-unit at order time; multiply by units sold to
      // estimate revenue in this window (the groupBy sum is the snapshot price
      // total across rows, which equals unitsSold × price for that product).
      const revCents = p._sum?.priceCentsSnapshot ?? 0;
      return {
        label: meta?.title ?? '(deleted product)',
        value: units,
        sub: `${formatPrice(revCents, currency)} revenue`,
      };
    })
    .filter((r) => r.value > 0);

  // Order status donut.
  const statusColors: Record<string, string> = {
    PENDING_PAYMENT: '#f59e0b',
    PAID: '#0E4F40',
    PROCESSING: '#3b82f6',
    SHIPPED: '#8b5cf6',
    DELIVERED: '#10b981',
    CANCELED: '#94a3b8',
    REFUNDED: '#ef4444',
  };
  const statusDonut = byStatus
    .map((s) => ({
      label: s.status.replace(/_/g, ' ').toLowerCase(),
      value: s._count._all,
      color: statusColors[s.status] ?? '#cbd5e1',
    }))
    .filter((d) => d.value > 0);

  // Sourcing/quote funnel.
  const quoteStageCounts = (st: QuoteStatus) => rangeQuotes.filter((q) => q.status === st).length;
  const totalQuotes = rangeQuotes.length;
  const accepted = quoteStageCounts('ACCEPTED');
  const replied = quoteStageCounts('RESPONDED') + accepted + quoteStageCounts('DECLINED');
  const funnel = [
    { label: 'Quote requests received', value: totalQuotes },
    { label: 'Replied to', value: replied },
    { label: 'Accepted', value: accepted },
  ];

  // Top categories.
  const categoryBars = topCats
    .filter((c) => c._count.products > 0)
    .map((c) => ({ label: c.name, value: c._count.products }));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground mt-1">
            Live metrics from real data — no fabricated numbers. Window: last {days} days.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-border bg-card p-1">
          {(['7d', '30d', '90d'] as Range[]).map((r) => (
            <a
              key={r}
              href={`/admin/analytics?range=${r}`}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                range === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {r}
            </a>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat icon={<Banknote className="h-5 w-5" />} label="Revenue all-time (paid+)" value={formatPrice(revenueAll, currency)} sub={`${paidCount} paid orders`} />
        <Stat icon={<TrendingUp className="h-5 w-5" />} label={`Revenue · last ${days}d`} value={formatPrice(revenueRange, currency)} accent />
        <Stat icon={<ShoppingCart className="h-5 w-5" />} label="Avg order value" value={formatPrice(aov, currency)} />
        <Stat icon={<Users className="h-5 w-5" />} label={`New users · ${days}d`} value={String(users30)} />
        <Stat icon={<Package className="h-5 w-5" />} label={`Orders · ${days}d`} value={String(orders30Count)} />
        <Stat icon={<Package className="h-5 w-5" />} label="Live listings" value={String(productsLive)} />
        <Stat icon={<FileText className="h-5 w-5" />} label={`Quote requests · ${days}d`} value={String(rangeQuotes.length)} />
        <Stat icon={<LifeBuoy className="h-5 w-5" />} label={`Tickets opened · ${days}d`} value={String(rangeTickets.length)} />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="lg:col-span-2">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground mb-3">
            Revenue trend
          </h2>
          <LineChart
            data={revData}
            yFormat={(n) => formatPrice(n, currency)}
            caption={`Paid orders only — totals per ${granularityDays === 1 ? 'day' : 'week'}.`}
          />
        </div>

        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground mb-3">
            Orders created
          </h2>
          <LineChart
            data={ordData}
            caption="All orders (pending + paid + canceled), placed per bucket."
            color="#3b82f6"
          />
        </div>

        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground mb-3">
            New signups
          </h2>
          <LineChart
            data={usrData}
            caption="Fresh user accounts created in the window."
            color="#8b5cf6"
          />
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <BarList
          caption={`Top products · last ${days}d (units sold)`}
          data={topProductRows}
          valueFormat={(n) => `${n} unit${n === 1 ? '' : 's'}`}
        />
        <BarList
          caption="Top categories (live listings)"
          data={categoryBars}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <FunnelChart
          caption={`Quote-to-accept funnel · ${days}d`}
          stages={funnel}
        />
        <Donut
          caption="Orders by status (all time)"
          centerLabel="orders"
          data={statusDonut}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="rounded-2xl border border-border bg-card p-5">
          <h3 className="text-sm font-bold mb-3 inline-flex items-center gap-2">
            <Wrench className="h-4 w-4 text-primary" /> Sell submissions · {days}d
          </h3>
          <ul className="space-y-1.5 text-sm">
            {(['PENDING', 'RESPONDED', 'ACCEPTED', 'DECLINED', 'CLOSED'] as const).map((s) => {
              const n = rangeSells.filter((x) => x.status === s).length;
              return (
                <li key={s} className="flex justify-between">
                  <span className="text-muted-foreground capitalize">{s.toLowerCase()}</span>
                  <span className="font-bold tabular-nums">{n}</span>
                </li>
              );
            })}
            <li className="flex justify-between pt-1.5 border-t border-border">
              <span className="font-semibold">Total</span>
              <span className="font-bold tabular-nums">{rangeSells.length}</span>
            </li>
          </ul>
        </div>
        <div className="rounded-2xl border border-border bg-card p-5">
          <h3 className="text-sm font-bold mb-3 inline-flex items-center gap-2">
            <LifeBuoy className="h-4 w-4 text-primary" /> Tickets · {days}d
          </h3>
          <ul className="space-y-1.5 text-sm">
            {(['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] as const).map((s) => {
              const n = rangeTickets.filter((x) => x.status === s).length;
              return (
                <li key={s} className="flex justify-between">
                  <span className="text-muted-foreground capitalize">{s.toLowerCase()}</span>
                  <span className="font-bold tabular-nums">{n}</span>
                </li>
              );
            })}
            <li className="flex justify-between pt-1.5 border-t border-border">
              <span className="font-semibold">Total</span>
              <span className="font-bold tabular-nums">{rangeTickets.length}</span>
            </li>
          </ul>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-foreground/[0.02] p-5 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">What this dashboard counts (and what it doesn’t)</p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li><strong>Revenue</strong> = sum of order totals once the order reached PAID or later. Pending payments don’t count.</li>
          <li><strong>Top products by units</strong> counts ordered quantity in this window, not all-time.</li>
          <li><strong>Page views, search history, AI-chat sessions</strong> are not tracked yet — adding them requires opt-in event logging.</li>
        </ul>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`rounded-2xl border p-5 ${accent ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'}`}>
      <div className={accent ? 'text-primary' : 'text-primary'}>{icon}</div>
      <p className={`text-2xl font-bold mt-2 tabular-nums ${accent ? 'text-primary' : ''}`}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}
