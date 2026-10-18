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
import { requireCapability, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { OrderStatus, QuoteStatus } from '@prisma/client';
import { LineChart, BarList, FunnelChart, Donut } from '@/components/admin/Charts';
import {
  averageSale,
  formatByCurrency,
  loadRevenueEvents,
  revenueByCurrency,
  revenueSeries,
  SOLD_ORDER_STATUSES,
} from '@/lib/reports/revenue';
import { MARGIN_ITEM_SELECT, marginVatRateBp, orderMarginOf } from '@/lib/reports/margin-vat';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Analytics' };
export const revalidate = 60;

const PAID: OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

type Range = '7d' | '30d' | '90d';

function bucketsFor(range: Range): { since: Date; days: number; granularityDays: number } {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const granularityDays = range === '90d' ? 7 : 1;
  return { since: new Date(Date.now() - days * 864e5), days, granularityDays };
}

export default async function AdminAnalyticsPage(
  props: {
    searchParams: Promise<{ range?: string; freight?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireCapability('analytics:view');
  // A31: money figures (revenue, AOV, revenue per product) need finance:view;
  // analytics:view alone (ops, marketing) shows counts and trends only.
  const canMoney = await hasCapability('finance:view');
  const range = (searchParams.range === '7d' || searchParams.range === '90d' ? searchParams.range : '30d') as Range;
  // Revenue is goods excl. VAT; ?freight=1 adds the freight charged (excl. VAT).
  const freight = searchParams.freight === '1';
  const { since, days, granularityDays } = bucketsFor(range);
  const qs = (r: Range, f: boolean) => `/admin/analytics?range=${r}${f ? '&freight=1' : ''}`;

  const [
    revenueEvents,
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
  ] = await Promise.all([
    // All-time events (the all-time tile); the range figures are cut from them.
    canMoney ? loadRevenueEvents() : Promise.resolve([]),
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
      select: { createdAt: true },
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
  ]);

  // Revenue (lib/reports/revenue): per currency, excl. VAT, net of credit
  // notes, dated by the sale (paid, or invoiced on terms); never summed across currencies.
  const revenueAll = revenueByCurrency(revenueEvents, { freight });
  const revenueRange = revenueByCurrency(revenueEvents, { from: since, freight });
  const aov = averageSale(revenueAll);
  const creditedAll = revenueAll.filter((r) => r.creditedCents !== 0);
  const salesAll = revenueAll.reduce((s, r) => s + r.sales, 0);
  const revLabel = freight ? 'excl. VAT, incl. freight' : 'excl. VAT';

  // Bucket orders + new users into the time series (revenue: one series per currency).
  const buckets = Math.ceil(days / granularityDays);
  const ord: number[] = new Array(buckets).fill(0);
  const usr: number[] = new Array(buckets).fill(0);
  function idx(d: Date) {
    const ageDays = (Date.now() - d.getTime()) / 864e5;
    return Math.min(buckets - 1, Math.max(0, buckets - 1 - Math.floor(ageDays / granularityDays)));
  }
  for (const o of rangeOrders) ord[idx(o.createdAt)] += 1;
  for (const u of rangeNewUsers) usr[idx(u.createdAt)] += 1;

  const labelFor = (i: number) => {
    const ageDays = (buckets - 1 - i) * granularityDays;
    const d = new Date(Date.now() - ageDays * 864e5);
    if (granularityDays === 7) {
      return `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`;
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const nowMs = Date.now();
  const revSeries = revenueRange.map((r) => ({
    currency: r.currency,
    data: revenueSeries(revenueEvents, { currency: r.currency, now: nowMs, buckets, bucketMs: granularityDays * 864e5, freight })
      .map((v, i) => ({ label: labelFor(i), value: v })),
  }));
  const ordData = ord.map((v, i) => ({ label: labelFor(i), value: v }));
  const usrData = usr.map((v, i) => ({ label: labelFor(i), value: v }));

  // Top products: units on orders sold in the window that still stand, with
  // their sales excl. VAT per currency (unit price × units, not the unit price
  // once; margin-scheme units without the margin VAT inside their price).
  const soldInRange = await prisma.orderItem.findMany({
    where: {
      lineType: 'GOODS',
      order: {
        status: { in: [...SOLD_ORDER_STATUSES] },
        OR: [{ paidAt: { gte: since } }, { paidAt: null, createdAt: { gte: since } }, { documents: { some: { kind: 'INVOICE', issueDate: { gte: since } } } }],
      },
    },
    select: { ...MARGIN_ITEM_SELECT, productId: true, titleSnapshot: true, order: { select: { id: true, currency: true, vatTreatment: true } } },
  });
  // Settings are loaded with the revenue events (finance:view only, as the amounts).
  const marginRateBp = canMoney ? marginVatRateBp() : 0;
  const saleIds = new Set(revenueEvents.filter((e) => e.kind === 'SALE' && e.at.getTime() >= since.getTime()).map((e) => e.orderId));
  const topMap = new Map<string, { label: string; units: number; cents: Map<string, number> }>();
  for (const it of soldInRange) {
    // The sale date decides the window (without finance:view no events are loaded: the order window alone).
    if (canMoney && !saleIds.has(it.order.id)) continue;
    const key = it.productId ?? `title:${it.titleSnapshot}`;
    const row = topMap.get(key) ?? { label: it.titleSnapshot, units: 0, cents: new Map<string, number>() };
    row.units += it.quantity;
    const marginVat = it.order.vatTreatment === 'MARGIN_SCHEME' ? orderMarginOf([it], marginRateBp).vatCents : 0;
    row.cents.set(it.order.currency, (row.cents.get(it.order.currency) ?? 0) + it.priceCentsSnapshot * it.quantity - marginVat);
    topMap.set(key, row);
  }
  const topProductRows = [...topMap.values()]
    .sort((a, b) => b.units - a.units)
    .slice(0, 8)
    .map((r) => ({
      label: r.label,
      value: r.units,
      sub: canMoney
        ? `${formatByCurrency([...r.cents].map(([c, cents]) => ({ currency: c, cents })))} excl. VAT`
        : `${r.units} sold`,
    }));

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
        <div className="flex items-center gap-2 flex-wrap">
          {canMoney && (
            <div className="flex items-center gap-1 rounded-full border border-border bg-card p-1">
              {([false, true] as const).map((f) => (
                <a
                  key={String(f)}
                  href={qs(range, f)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                    freight === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {f ? 'Goods + freight' : 'Goods only'}
                </a>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1 rounded-full border border-border bg-card p-1">
            {(['7d', '30d', '90d'] as Range[]).map((r) => (
              <a
                key={r}
                href={qs(r, freight)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                  range === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {r}
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {canMoney ? (
          <>
            <Stat
              icon={<Banknote className="h-5 w-5" />}
              label={`Revenue all-time · ${revLabel}`}
              value={formatByCurrency(revenueAll)}
              sub={`${salesAll} sale${salesAll === 1 ? '' : 's'}${creditedAll.length ? ` · credit notes ${formatByCurrency(creditedAll.map((r) => ({ currency: r.currency, cents: r.creditedCents })))}` : ''}`}
            />
            <Stat icon={<TrendingUp className="h-5 w-5" />} label={`Revenue · last ${days}d · ${revLabel}`} value={formatByCurrency(revenueRange)} accent />
            <Stat icon={<ShoppingCart className="h-5 w-5" />} label={`Avg sale value · ${revLabel}`} value={aov.length ? formatByCurrency(aov) : '—'} sub="all time, before credit notes" />
          </>
        ) : (
          <Stat icon={<Banknote className="h-5 w-5" />} label="Paid orders (all time)" value={String(paidCount)} sub="Revenue needs the finance:view permission" />
        )}
        <Stat icon={<Users className="h-5 w-5" />} label={`New users · ${days}d`} value={String(users30)} />
        <Stat icon={<Package className="h-5 w-5" />} label={`Orders · ${days}d`} value={String(orders30Count)} />
        <Stat icon={<Package className="h-5 w-5" />} label="Live listings" value={String(productsLive)} />
        <Stat icon={<FileText className="h-5 w-5" />} label={`Quote requests · ${days}d`} value={String(rangeQuotes.length)} />
        <Stat icon={<LifeBuoy className="h-5 w-5" />} label={`Tickets opened · ${days}d`} value={String(rangeTickets.length)} />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {canMoney && (
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground">
            Revenue trend · {revLabel}
          </h2>
          {revSeries.length === 0 ? (
            <LineChart data={[]} caption="No sales or credit notes in this window." />
          ) : (
            revSeries.map((s) => (
              <LineChart
                key={s.currency}
                data={s.data}
                yFormat={(n) => formatPrice(n, s.currency)}
                caption={`${s.currency} · sales on their payment date (invoice date when sold on terms), minus credit notes on their date · per ${granularityDays === 1 ? 'day' : 'week'}.`}
              />
            ))
          )}
        </div>
        )}

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
            {/* Every status is in exactly one row, so the rows add up to Total. */}
            {([
              ['Awaiting support', ['OPEN', 'WAITING_ON_SUPPORT']],
              ['Waiting on customer', ['WAITING_ON_CUSTOMER', 'PENDING']],
              ['Resolved', ['RESOLVED']],
              ['Closed', ['CLOSED']],
              ['Spam', ['SPAM']],
            ] as const).map(([label, statuses]) => {
              const n = rangeTickets.filter((x) => (statuses as readonly string[]).includes(x.status)).length;
              return (
                <li key={label} className="flex justify-between">
                  <span className="text-muted-foreground">{label}</span>
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
          <li><strong>Revenue</strong> = the agreed goods price excl. VAT ({freight ? 'plus the freight charged, excl. VAT' : 'freight not included'}), counted when the order is paid, or invoiced on terms when that came first. Credit notes are deducted on their issue date. Pending payments don’t count.</li>
          <li><strong>Currencies</strong> are shown separately: no exchange rate is stored, so EUR and USD are never added up.</li>
          <li><strong>A refund of an overpayment</strong> (money paid in excess and sent back) doesn’t change revenue: revenue counts the invoiced amount, not the money received. Money refunded without a credit note beyond that is deducted.</li>
          <li><strong>Top products by units</strong> counts units on orders sold in this window that still stand (not canceled or refunded).</li>
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
