import Link from 'next/link';
import {
  Package,
  ShieldCheck,
  FileText,
  ArrowRight,
  Banknote,
  LifeBuoy,
  Truck,
  AlertTriangle,
  Boxes,
  Clock,
  TrendingUp,
  ShoppingBag,
  Wrench,
  ShieldOff,
  Target,
  Percent,
} from 'lucide-react';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { OrderStatus } from '@prisma/client';
import { LineChart } from '@/components/admin/Charts';
import { BulkShipButton } from '@/components/admin/BulkShipButton';

export const dynamic = 'force-dynamic';
export const revalidate = 30;

const PAID: OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
const FULFIL_PENDING: OrderStatus[] = ['PAID', 'PROCESSING'];
const DAY = 864e5;
const FULFIL_SLA_HOURS = 48;

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return email;
  const head = name.length <= 2 ? name : name.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(2, Math.min(6, name.length - 2)))}@${domain}`;
}

function timeAgo(d: Date, nowMs: number): string {
  const diff = nowMs - d.getTime();
  if (diff < 3600e3) return `${Math.max(1, Math.floor(diff / 60_000))}m`;
  if (diff < DAY) return `${Math.floor(diff / 3600e3)}h`;
  return `${Math.floor(diff / DAY)}d`;
}

function pct(num: number, den: number): string {
  if (den === 0) return '—';
  return `${Math.round((num / den) * 100)}%`;
}

function delta(curr: number, prev: number): { sign: '+' | '−' | '·'; pct: string; tone: 'good' | 'bad' | 'flat' } {
  if (prev === 0 && curr === 0) return { sign: '·', pct: '0%', tone: 'flat' };
  if (prev === 0) return { sign: '+', pct: 'new', tone: 'good' };
  const change = (curr - prev) / prev;
  const sign = change > 0 ? '+' : change < 0 ? '−' : '·';
  const tone = change > 0.02 ? 'good' : change < -0.02 ? 'bad' : 'flat';
  return { sign, pct: `${Math.abs(Math.round(change * 100))}%`, tone };
}

export default async function AdminDashboardPage() {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  const now = Date.now();
  const since30 = new Date(now - 30 * DAY);
  const since14 = new Date(now - 14 * DAY);
  const since7 = new Date(now - 7 * DAY);
  const ticketStale = new Date(now - 24 * 3600e3);
  const quoteStale = new Date(now - 48 * 3600e3);
  const since24h = new Date(now - 24 * 3600e3);

  const [
    fulfilPending,
    pendingProducts,
    pendingSells,
    quotesStale,
    ticketsStale,
    lastCopyStock,
    rangeOrders,
    errors24,
    errorTrend,
    catalogLive,
    usersTotal,
    usersPriorWeek,
    quotesOpenAll,
    quotesAllWindow,
    shippedAnalytics,
  ] = await Promise.all([
    prisma.order.findMany({
      where: { status: { in: FULFIL_PENDING } },
      orderBy: { createdAt: 'asc' },
      take: 6,
      select: {
        id: true,
        orderNumber: true,
        totalCents: true,
        currency: true,
        status: true,
        createdAt: true,
        buyer: { select: { name: true } },
        items: { select: { quantity: true, titleSnapshot: true } },
      },
    }),
    prisma.product.count({ where: { status: 'PENDING_REVIEW' } }),
    prisma.sellSubmission.count({ where: { status: 'PENDING' } }),
    prisma.sourcingRequest.findMany({
      where: { status: 'PENDING', createdAt: { lt: quoteStale } },
      orderBy: { createdAt: 'asc' },
      take: 6,
      select: { id: true, description: true, buyerName: true, buyerEmail: true, createdAt: true },
    }),
    prisma.supportTicket.findMany({
      where: {
        status: { in: ['OPEN', 'PENDING'] },
        updatedAt: { lt: ticketStale },
      },
      orderBy: { updatedAt: 'asc' },
      take: 6,
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { fromStaff: true, createdAt: true },
        },
      },
    }),
    prisma.product.findMany({
      where: { status: 'PUBLISHED', quantity: { gt: 0, lte: 1 } },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: { slug: true, title: true, priceCents: true, currency: true, quantity: true },
    }),
    prisma.order.findMany({
      where: { createdAt: { gte: since30 } },
      select: { totalCents: true, status: true, createdAt: true, currency: true },
    }),
    prisma.errorLog.count({ where: { createdAt: { gte: since24h } } }),
    prisma.errorLog.findMany({
      where: { createdAt: { gte: since24h } },
      select: { createdAt: true },
    }),
    prisma.product.count({ where: { status: 'PUBLISHED' } }),
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: since14, lt: since7 } } }),
    prisma.sourcingRequest.count({ where: { status: { in: ['PENDING', 'RESPONDED'] } } }),
    prisma.sourcingRequest.findMany({
      where: { createdAt: { gte: since30 } },
      select: { status: true, createdAt: true },
    }),
    prisma.order.findMany({
      where: { shippedAt: { not: null }, createdAt: { gte: since30 } },
      select: { createdAt: true, shippedAt: true },
    }),
  ]);

  const usersThisWeek = await prisma.user.count({ where: { createdAt: { gte: since7 } } });

  // Filter tickets to those genuinely awaiting reply (last message from buyer
  // or no reply at all).
  const awaitingTickets = ticketsStale.filter((t) => {
    const last = t.messages[0];
    return !last || !last.fromStaff;
  });

  // Bucket revenue + order counts into daily points for the sparkline.
  const days = 30;
  const rev: number[] = new Array(days).fill(0);
  const ord: number[] = new Array(days).fill(0);
  let nonZeroRevDays = 0;
  for (const o of rangeOrders) {
    const age = Math.floor((now - o.createdAt.getTime()) / DAY);
    const i = days - 1 - age;
    if (i < 0 || i >= days) continue;
    if (PAID.includes(o.status)) rev[i] += o.totalCents;
    ord[i] += 1;
  }
  for (const v of rev) if (v > 0) nonZeroRevDays++;
  const sparkRevenue = rev.map((v, i) => ({
    label: i === 0 || i === days - 1 ? `-${days - 1 - i}d` : '',
    value: v,
  }));
  const revenue7 = rev.slice(-7).reduce((s, v) => s + v, 0);
  const revenuePrior7 = rev.slice(-14, -7).reduce((s, v) => s + v, 0);
  const revenue30 = rev.reduce((s, v) => s + v, 0);
  const orders7 = ord.slice(-7).reduce((s, v) => s + v, 0);
  const ordersPrior7 = ord.slice(-14, -7).reduce((s, v) => s + v, 0);
  const currency = rangeOrders[0]?.currency ?? 'EUR';

  // AOV (paid+ orders, last 7d)
  const paidLast7 = rangeOrders.filter(
    (o) => PAID.includes(o.status) && o.createdAt >= since7,
  );
  const aov7 = paidLast7.length === 0 ? 0 : Math.round(paidLast7.reduce((s, o) => s + o.totalCents, 0) / paidLast7.length);

  // Fulfilment SLA: orders shipped within 48h of creation, over last 30d.
  const slaTotal = shippedAnalytics.length;
  const slaHit = shippedAnalytics.filter(
    (o) => o.shippedAt && (o.shippedAt.getTime() - o.createdAt.getTime()) <= FULFIL_SLA_HOURS * 3600e3,
  ).length;

  // Quote→order conversion: ACCEPTED / total quotes in 30d window.
  const quoteTotal = quotesAllWindow.length;
  const quoteAccepted = quotesAllWindow.filter((q) => q.status === 'ACCEPTED').length;

  // Error sparkline (hourly buckets, 24h).
  const hours = 24;
  const errSeries: number[] = new Array(hours).fill(0);
  for (const e of errorTrend) {
    const age = Math.floor((now - e.createdAt.getTime()) / 3600e3);
    const i = hours - 1 - age;
    if (i >= 0 && i < hours) errSeries[i] += 1;
  }
  const sparkErr = errSeries.map((v, i) => ({
    label: i === 0 || i === hours - 1 ? `-${hours - 1 - i}h` : '',
    value: v,
  }));

  // Tile data assembled once so we can split into action / all-clear groups.
  const tiles = [
    {
      key: 'fulfil',
      icon: <Truck className="h-4 w-4" />,
      label: 'Awaiting fulfilment',
      value: fulfilPending.length,
      href: '/admin/orders?awaiting=1',
      tone: fulfilPending.length > 0 ? 'amber' : 'neutral',
      sub: fulfilPending.length > 0 ? `oldest ${timeAgo(fulfilPending[0].createdAt, now)} ago` : 'all caught up',
    },
    {
      key: 'approvals',
      icon: <ShieldCheck className="h-4 w-4" />,
      label: 'Pending approvals',
      value: pendingProducts,
      href: '/admin/products?status=PENDING_REVIEW',
      tone: pendingProducts > 0 ? 'amber' : 'neutral',
      sub: pendingProducts > 0 ? 'new seller listings' : 'none waiting',
    },
    {
      key: 'tickets',
      icon: <LifeBuoy className="h-4 w-4" />,
      label: 'Tickets stale > 24h',
      value: awaitingTickets.length,
      href: '/admin/tickets?status=OPEN',
      tone: awaitingTickets.length > 0 ? 'red' : 'neutral',
      sub: awaitingTickets.length > 0 ? `oldest ${timeAgo(awaitingTickets[0].updatedAt, now)} ago` : 'all replied',
    },
    {
      key: 'quotes',
      icon: <FileText className="h-4 w-4" />,
      label: 'Quotes pending > 48h',
      value: quotesStale.length,
      href: '/admin/quotes?status=PENDING',
      tone: quotesStale.length > 0 ? 'red' : 'neutral',
      sub: quotesStale.length > 0 ? `oldest ${timeAgo(quotesStale[0].createdAt, now)} ago` : 'all replied',
    },
    {
      key: 'sells',
      icon: <Wrench className="h-4 w-4" />,
      label: 'Sell submissions',
      value: pendingSells,
      href: '/admin/sell?status=PENDING',
      tone: pendingSells > 0 ? 'amber' : 'neutral',
      sub: pendingSells > 0 ? 'new offers' : 'none waiting',
    },
    {
      key: 'errors',
      icon: <AlertTriangle className="h-4 w-4" />,
      label: 'Errors · 24h',
      value: errors24,
      href: '/admin/errors',
      tone: errors24 > 10 ? 'red' : errors24 > 0 ? 'amber' : 'neutral',
      sub: errors24 === 0 ? 'clean window' : 'review log',
    },
    {
      key: 'lastcopy',
      icon: <Boxes className="h-4 w-4" />,
      label: 'Last-copy stock',
      value: lastCopyStock.length,
      href: '/admin/products?status=PUBLISHED&qty=lastcopy',
      tone: lastCopyStock.length > 0 ? 'amber' : 'neutral',
      sub: lastCopyStock.length > 0 ? 'qty = 1' : 'no critical items',
    },
  ];

  const actionTiles = tiles.filter((t) => t.value > 0);
  const clearTiles = tiles.filter((t) => t.value === 0);

  const dRev7 = delta(revenue7, revenuePrior7);
  const dOrd7 = delta(orders7, ordersPrior7);
  const dUsers7 = delta(usersThisWeek, usersPriorWeek);

  // BUG-012 fix: this string is produced in a Server Component, so without an
  // explicit timeZone `toLocaleTimeString` silently uses the SERVER's timezone
  // and every viewer sees the server-local clock mislabelled as their own. We
  // pin it to UTC and label it so the value is deterministic (no SSR/client TZ
  // drift) and honest. The `suppressHydrationWarning` on the wrapper span below
  // remains as defence-in-depth.
  const lastRefreshed = new Date(now).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC';

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1 inline-flex items-center gap-2 flex-wrap text-sm">
            Signed in as <strong className="text-foreground">{maskEmail(session.user.email)}</strong>
            <span className="text-muted-foreground/60">·</span>
            {/* BUG-012 fix: SSR-rendered `toLocaleTimeString` uses the server
              * timezone; client hydration sees a different value when the user
              * is in a different TZ, triggering React #418/#423/#425. We tell
              * React it's OK for this exact subtree to differ — the second
              * render on the client will display the correct local time. */}
            <span className="inline-flex items-center gap-1" suppressHydrationWarning>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              live · refreshed {lastRefreshed}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <KpiChip label="Users" value={String(usersTotal)} delta={dUsers7} />
          <KpiChip label="Live listings" value={String(catalogLive)} />
          <KpiChip label="Open quotes" value={String(quotesOpenAll)} />
        </div>
      </div>

      {/* === Action queue (only tiles with work; cleared ones collapsed below) === */}
      <section className="space-y-3">
        {actionTiles.length > 0 ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xs uppercase tracking-[0.18em] font-bold text-muted-foreground">
                Needs attention ({actionTiles.length})
              </h2>
              {fulfilPending.length > 0 && <BulkShipButton count={fulfilPending.length} />}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {actionTiles.map((t) => {
                const { key, ...rest } = t;
                return <QueueTile key={key} {...rest} />;
              })}
              {/* Revenue card always present in action row as positive context */}
              <QueueTile
                key="rev7"
                icon={<ShoppingBag className="h-4 w-4" />}
                label="Orders · 7d"
                value={orders7}
                href="/admin/orders"
                tone="emerald"
                sub={`${formatPrice(revenue7, currency)} · ${dRev7.sign}${dRev7.pct} rev`}
              />
            </div>
          </>
        ) : (
          <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-6 flex items-center gap-4">
            <span className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-emerald-100 text-emerald-700">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <p className="text-lg font-bold text-emerald-900">Inbox clean · nothing waiting on you</p>
              <p className="text-sm text-emerald-800 mt-0.5">
                No fulfilment, approvals, tickets, quotes, sells, errors or last-copy items. Last 7d: {orders7} orders · {formatPrice(revenue7, currency)} ({dRev7.sign}{dRev7.pct} vs prior).
              </p>
            </div>
          </div>
        )}

        {clearTiles.length > 0 && (
          <p className="text-[11px] text-muted-foreground inline-flex items-center gap-2 flex-wrap">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 inline-block" />
            <span className="font-semibold text-emerald-700">Clear:</span>
            {clearTiles.map((t, i) => (
              <span key={t.key} className="inline-flex items-center gap-1">
                <Link href={t.href} className="hover:text-foreground hover:underline underline-offset-2">
                  {t.label.toLowerCase()}
                </Link>
                {i < clearTiles.length - 1 && <span className="opacity-40">·</span>}
              </span>
            ))}
          </p>
        )}
      </section>

      {/* === Operational KPIs (delta vs prior period) === */}
      <section>
        <h2 className="text-xs uppercase tracking-[0.18em] font-bold text-muted-foreground mb-3">
          Operational metrics · last 7d
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi
            icon={<Banknote className="h-4 w-4" />}
            label="Revenue"
            value={formatPrice(revenue7, currency)}
            delta={dRev7}
          />
          <Kpi
            icon={<ShoppingBag className="h-4 w-4" />}
            label="Orders placed"
            value={String(orders7)}
            delta={dOrd7}
          />
          <Kpi
            icon={<Target className="h-4 w-4" />}
            label={`Fulfilment SLA (${FULFIL_SLA_HOURS}h)`}
            value={slaTotal === 0 ? '—' : pct(slaHit, slaTotal)}
            footnote={slaTotal === 0 ? 'no shipped orders in 30d' : `${slaHit} of ${slaTotal} shipped in time (30d)`}
            tone={slaTotal === 0 ? 'flat' : slaHit / slaTotal >= 0.9 ? 'good' : slaHit / slaTotal >= 0.7 ? 'flat' : 'bad'}
          />
          <Kpi
            icon={<Percent className="h-4 w-4" />}
            label="Quote → order"
            value={quoteTotal === 0 ? '—' : pct(quoteAccepted, quoteTotal)}
            footnote={quoteTotal === 0 ? 'no quotes in 30d' : `${quoteAccepted} of ${quoteTotal} accepted (30d)`}
            tone={quoteTotal === 0 ? 'flat' : quoteAccepted / quoteTotal >= 0.3 ? 'good' : 'flat'}
          />
          <Kpi
            icon={<TrendingUp className="h-4 w-4" />}
            label="Avg order value"
            value={aov7 === 0 ? '—' : formatPrice(aov7, currency)}
            footnote={paidLast7.length === 0 ? 'no paid orders this week' : `from ${paidLast7.length} paid order${paidLast7.length === 1 ? '' : 's'}`}
          />
          <Kpi
            icon={<Package className="h-4 w-4" />}
            label="Live listings"
            value={String(catalogLive)}
            footnote={`${lastCopyStock.length} last-copy`}
          />
          <Kpi
            icon={<FileText className="h-4 w-4" />}
            label="Open quotes"
            value={String(quotesOpenAll)}
            footnote={`${quoteTotal} new in 30d`}
          />
          <Kpi
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Errors · 24h"
            value={String(errors24)}
            footnote={errors24 === 0 ? 'clean window' : 'investigate'}
            tone={errors24 === 0 ? 'good' : errors24 > 10 ? 'bad' : 'flat'}
          />
        </div>
      </section>

      {/* === Trend charts (only when there's data) === */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs uppercase tracking-[0.18em] font-bold text-muted-foreground inline-flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" /> Revenue · last 30 days
            </h2>
            <Link href="/admin/analytics" className="text-xs font-semibold text-primary hover:underline">
              Full analytics →
            </Link>
          </div>
          {nonZeroRevDays < 3 ? (
            <div className="rounded-2xl border-2 border-dashed border-border bg-card p-6 text-center">
              <p className="text-sm font-semibold">Not enough revenue history for a trend yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                {`Only ${nonZeroRevDays} day${nonZeroRevDays === 1 ? '' : 's'} with paid orders in the last 30. Chart appears once ≥3 days have revenue.`}
              </p>
              <p className="text-xs text-muted-foreground mt-2 tabular-nums">
                Window total: <strong className="text-foreground">{formatPrice(revenue30, currency)}</strong>
              </p>
            </div>
          ) : (
            <LineChart
              data={sparkRevenue}
              height={140}
              yFormat={(n) => formatPrice(n, currency)}
              caption={`${formatPrice(revenue30, currency)} total · ${formatPrice(revenue7, currency)} last 7d (${dRev7.sign}${dRev7.pct} vs prior)`}
            />
          )}
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs uppercase tracking-[0.18em] font-bold text-muted-foreground inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> Errors · last 24 hours
            </h2>
            <Link href="/admin/errors" className="text-xs font-semibold text-primary hover:underline">
              Error log →
            </Link>
          </div>
          {errors24 === 0 ? (
            <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50/60 p-6 text-center">
              <ShieldOff className="h-7 w-7 mx-auto text-emerald-700 mb-2" />
              <p className="text-sm font-bold text-emerald-900">No errors in the last 24 hours</p>
              <p className="text-xs text-emerald-800 mt-1">
                Application is healthy. Error log catches uncaught server exceptions + webhook failures.
              </p>
            </div>
          ) : (
            <LineChart
              data={sparkErr}
              height={140}
              color="#ef4444"
              caption={`${errors24} error event${errors24 === 1 ? '' : 's'} in the window.`}
            />
          )}
        </div>
      </section>

      {/* === Drill panels === */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {fulfilPending.length > 0 && (
          <DrillPanel
            title="Orders to fulfil"
            icon={<Truck className="h-4 w-4 text-amber-700" />}
            cta={{ href: '/admin/orders?awaiting=1', label: 'Open queue' }}
          >
            {fulfilPending.map((o) => {
              const ageH = Math.floor((now - o.createdAt.getTime()) / 3600e3);
              const breach = ageH > FULFIL_SLA_HOURS;
              return (
                <Link
                  key={o.id}
                  href={`/admin/orders?q=${o.orderNumber}`}
                  className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-foreground/[0.03]"
                >
                  <span className="text-[10px] font-mono bg-foreground/5 px-1.5 py-0.5 rounded">
                    {o.orderNumber}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{o.buyer.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {o.items[0]?.titleSnapshot ?? '—'}
                      {o.items.length > 1 ? ` +${o.items.length - 1} more` : ''}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-bold tabular-nums">{formatPrice(o.totalCents, o.currency)}</p>
                    <p className={`text-[11px] inline-flex items-center gap-1 ${breach ? 'text-red-700 font-bold' : 'text-muted-foreground'}`}>
                      <Clock className="h-3 w-3" /> {timeAgo(o.createdAt, now)}
                      {breach && ' · SLA breach'}
                    </p>
                  </div>
                </Link>
              );
            })}
          </DrillPanel>
        )}

        {awaitingTickets.length > 0 && (
          <DrillPanel
            title="Customers waiting for reply"
            icon={<LifeBuoy className="h-4 w-4 text-red-700" />}
            cta={{ href: '/admin/tickets?status=OPEN', label: 'Open tickets' }}
          >
            {awaitingTickets.map((t) => (
              <Link
                key={t.id}
                href={`/admin/tickets?q=${t.ref}`}
                className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-foreground/[0.03]"
              >
                <span className="text-[10px] font-mono bg-foreground/5 px-1.5 py-0.5 rounded">
                  {t.ref}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{t.subject}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {t.name} ({t.email})
                  </p>
                </div>
                <p className="text-[11px] text-red-700 font-semibold inline-flex items-center gap-1 flex-shrink-0">
                  <Clock className="h-3 w-3" /> {timeAgo(t.updatedAt, now)}
                </p>
              </Link>
            ))}
          </DrillPanel>
        )}

        {quotesStale.length > 0 && (
          <DrillPanel
            title="Quotes pending reply"
            icon={<FileText className="h-4 w-4 text-red-700" />}
            cta={{ href: '/admin/quotes?status=PENDING', label: 'Pending quotes' }}
          >
            {quotesStale.map((q) => (
              <Link
                key={q.id}
                href={`/app/seller/inbox/${q.id}`}
                className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-foreground/[0.03]"
              >
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{q.buyerName} ({q.buyerEmail})</p>
                  <p className="text-xs text-muted-foreground truncate">{q.description}</p>
                </div>
                <p className="text-[11px] text-red-700 font-semibold inline-flex items-center gap-1 flex-shrink-0">
                  <Clock className="h-3 w-3" /> {timeAgo(q.createdAt, now)}
                </p>
              </Link>
            ))}
          </DrillPanel>
        )}

        {lastCopyStock.length > 0 && (
          <DrillPanel
            title="Last-copy in stock"
            icon={<Boxes className="h-4 w-4 text-amber-700" />}
            cta={{ href: '/admin/products?status=PUBLISHED&qty=lastcopy', label: 'Last-copy list' }}
          >
            {lastCopyStock.map((p) => (
              <Link
                key={p.slug}
                href={`/marketplace/${p.slug}`}
                target="_blank"
                className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-foreground/[0.03]"
              >
                <Package className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <p className="text-sm font-semibold truncate flex-1">{p.title}</p>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 tabular-nums">
                  qty {p.quantity}
                </span>
                {p.priceCents !== null && (
                  <span className="text-xs font-bold tabular-nums text-muted-foreground">
                    {formatPrice(p.priceCents, p.currency)}
                  </span>
                )}
              </Link>
            ))}
          </DrillPanel>
        )}
      </section>
    </div>
  );
}

function KpiChip({
  label,
  value,
  delta: d,
}: {
  label: string;
  value: string;
  delta?: { sign: '+' | '−' | '·'; pct: string; tone: 'good' | 'bad' | 'flat' };
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
      {label}: <span className="tabular-nums">{value}</span>
      {d && d.sign !== '·' && (
        <span
          className={`text-[10px] font-bold ${d.tone === 'good' ? 'text-emerald-700' : d.tone === 'bad' ? 'text-red-700' : 'text-muted-foreground'}`}
        >
          {d.sign}
          {d.pct}
        </span>
      )}
    </span>
  );
}

function QueueTile({
  icon,
  label,
  value,
  sub,
  href,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub?: string;
  href: string;
  tone: string;
}) {
  const ring =
    tone === 'red'
      ? 'border-red-200 bg-red-50/60'
      : tone === 'amber'
        ? 'border-amber-200 bg-amber-50/60'
        : tone === 'emerald'
          ? 'border-emerald-200 bg-emerald-50/60'
          : 'border-border bg-card';
  const text =
    tone === 'red'
      ? 'text-red-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'emerald'
          ? 'text-emerald-700'
          : 'text-foreground';
  return (
    <Link
      href={href}
      className={`group relative rounded-2xl border ${ring} p-4 transition-shadow hover:shadow-md flex flex-col gap-2`}
    >
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-bold text-muted-foreground">
        {icon} <span className="truncate">{label}</span>
      </div>
      <span className={`text-3xl font-bold tabular-nums ${text}`} style={{ letterSpacing: '-0.03em' }}>
        {value}
      </span>
      {/* BUG-012 fix: `sub` may contain a relative time string like
        * "oldest 2h ago" rendered server-side; the client computes a value a
        * few seconds different and hydration mismatches. suppressHydrationWarning
        * silences the diff for this leaf node only. */}
      {sub && (
        <p className="text-[11px] text-muted-foreground" suppressHydrationWarning>
          {sub}
        </p>
      )}
      <ArrowRight
        className={`absolute bottom-3 right-3 h-4 w-4 ${text} opacity-30 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all`}
      />
    </Link>
  );
}

function Kpi({
  icon,
  label,
  value,
  delta: d,
  footnote,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  delta?: { sign: '+' | '−' | '·'; pct: string; tone: 'good' | 'bad' | 'flat' };
  footnote?: string;
  tone?: 'good' | 'bad' | 'flat';
}) {
  const accent =
    (d?.tone ?? tone) === 'good'
      ? 'text-emerald-700'
      : (d?.tone ?? tone) === 'bad'
        ? 'text-red-700'
        : 'text-foreground';
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
        {icon} {label}
      </div>
      <p className="text-2xl font-bold tabular-nums mt-1" style={{ letterSpacing: '-0.025em' }}>
        {value}
      </p>
      <div className="flex items-center gap-2 mt-1">
        {d && d.sign !== '·' && (
          <span className={`text-[10px] font-bold ${accent}`}>
            {d.sign}{d.pct}
          </span>
        )}
        {footnote && <p className="text-[11px] text-muted-foreground truncate">{footnote}</p>}
      </div>
    </div>
  );
}

function DrillPanel({
  title,
  icon,
  cta,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  cta: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-bold inline-flex items-center gap-2">
          {icon} {title}
        </h3>
        <Link href={cta.href} className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-0.5">
          {cta.label} <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
