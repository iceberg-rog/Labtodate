import Link from 'next/link';
import { Banknote, Package, TrendingUp, Truck, CircleAlert, Calendar, Download, Building2, Users as UsersIcon, Repeat } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { OrderStatus, Prisma } from '@prisma/client';
import { AdminSearch, AdminPager } from '@/components/admin/AdminListControls';
import { OrdersListShell } from '@/components/admin/OrdersListShell';
import { ProductQuickView } from '@/components/admin/ProductQuickView';
import { OrderQuickView } from '@/components/admin/OrderQuickView';
import {
  humaniseBuyer,
  itemCountLabel,
  smartDate,
  shipAddressOneLiner,
  shippingAddressIsComplete,
  computeOrderPriority,
  STATUS_LABEL,
  STATUS_TONE,
} from '@/lib/orders/display';

export const dynamic = 'force-dynamic';

const PAID_STATES: OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
const FULFIL_PENDING: OrderStatus[] = ['PAID', 'PROCESSING'];
const PAGE_SIZE = 50;

type Range = 'all' | '7d' | '30d' | '90d';

function rangeWhere(range: Range): Prisma.OrderWhereInput {
  if (range === 'all') return {};
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  return { createdAt: { gte: new Date(Date.now() - days * 864e5) } };
}

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: { q?: string; page?: string; status?: string; awaiting?: string; range?: string; view?: string };
}) {
  await requireCapability('orders:view');
  const q = (searchParams.q ?? '').trim();
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const awaiting = searchParams.awaiting === '1';
  // Views: 'awaiting_verify' surfaces buyer-submitted proofs the team needs to
  // review; 'archived' shows soft-archived rows that are otherwise hidden.
  const view = searchParams.view === 'archived' || searchParams.view === 'awaiting_verify' ? searchParams.view : '';
  const range: Range =
    searchParams.range === '7d' || searchParams.range === '30d' || searchParams.range === '90d'
      ? searchParams.range
      : 'all';

  let statusFilter: OrderStatus[] | undefined;
  if (awaiting) {
    statusFilter = FULFIL_PENDING;
  } else if (searchParams.status) {
    const parts = searchParams.status.split(',').map((s) => s.trim()).filter(Boolean) as OrderStatus[];
    statusFilter = parts.length ? parts : undefined;
  }

  const where: Prisma.OrderWhereInput = {
    ...rangeWhere(range),
    ...(statusFilter ? { status: { in: statusFilter } } : {}),
    // Soft-archive: by default hide archived rows; only show them when
    // view=archived is explicitly requested.
    ...(view === 'archived' ? { archivedAt: { not: null } } : { archivedAt: null }),
    ...(view === 'awaiting_verify' ? { paymentVerificationStatus: 'AWAITING_VERIFICATION' } : {}),
    ...(q
      ? {
          OR: [
            { orderNumber: { contains: q, mode: 'insensitive' } },
            { buyer: { name: { contains: q, mode: 'insensitive' } } },
            { buyer: { email: { contains: q, mode: 'insensitive' } } },
            { items: { some: { titleSnapshot: { contains: q, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };

  // Counts for the two new tabs (independent of current filters so the chip
  // counters always reflect the total backlog the operator is responsible for).
  const [archivedCount, awaitingVerifyCount] = await Promise.all([
    prisma.order.count({ where: { archivedAt: { not: null } } }),
    prisma.order.count({ where: { paymentVerificationStatus: 'AWAITING_VERIFICATION', archivedAt: null } }),
  ]);

  const [orders, total, statusBreakdown, agg, paidCount] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        buyer: { select: { id: true, name: true, email: true, company: { select: { name: true } } } },
        items: {
          select: {
            quantity: true,
            titleSnapshot: true,
            product: {
              select: {
                slug: true,
                images: true,
                illustration: true,
                category: { select: { name: true, slug: true } },
                seller: { select: { name: true, company: { select: { name: true } } } },
              },
            },
          },
        },
      },
    }),
    prisma.order.count({ where }),
    prisma.order.groupBy({
      by: ['status'],
      where: { ...rangeWhere(range), ...(q ? { OR: where.OR } : {}) } as Prisma.OrderWhereInput,
      _count: { _all: true },
    }),
    prisma.order.aggregate({
      _sum: { totalCents: true },
      where: { status: { in: PAID_STATES }, ...rangeWhere(range) },
    }),
    prisma.order.count({ where: { status: { in: PAID_STATES }, ...rangeWhere(range) } }),
  ]);

  // Batch buyer intel — one groupBy regardless of how many rows.
  const buyerIds = Array.from(new Set(orders.map((o) => o.buyer.id)));
  const buyerStats = buyerIds.length === 0 ? [] : await prisma.order.groupBy({
    by: ['buyerId'],
    where: { buyerId: { in: buyerIds }, status: { in: PAID_STATES } },
    _sum: { totalCents: true },
    _count: { _all: true },
  });
  const intelByBuyer = new Map<string, { paidCount: number; lifetimeCents: number }>();
  for (const s of buyerStats) {
    intelByBuyer.set(s.buyerId, { paidCount: s._count._all, lifetimeCents: s._sum.totalCents ?? 0 });
  }

  const revenue = agg._sum.totalCents ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ─── Sales analytics ribbon (7-day window, paid orders only) ───────────
  const since7 = new Date(Date.now() - 7 * 864e5);
  const [items7d, paidOrders7d] = await Promise.all([
    prisma.orderItem.findMany({
      where: {
        order: { status: { in: PAID_STATES }, createdAt: { gte: since7 } },
      },
      select: {
        priceCentsSnapshot: true,
        quantity: true,
        product: {
          select: {
            category: { select: { name: true } },
            seller: { select: { name: true } },
          },
        },
      },
    }),
    prisma.order.findMany({
      where: { status: { in: PAID_STATES }, createdAt: { gte: since7 } },
      select: { buyerId: true, totalCents: true },
    }),
  ]);

  // top category by revenue 7d
  const catRev = new Map<string, number>();
  const supRev = new Map<string, number>();
  for (const it of items7d) {
    const line = it.priceCentsSnapshot * it.quantity;
    const cat = it.product?.category?.name ?? null;
    const sup = it.product?.seller?.name ?? null;
    if (cat) catRev.set(cat, (catRev.get(cat) ?? 0) + line);
    if (sup) supRev.set(sup, (supRev.get(sup) ?? 0) + line);
  }
  const topCat = Array.from(catRev.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
  const topSup = Array.from(supRev.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;

  // AOV + repeat-customer % 7d
  const aov7 = paidOrders7d.length === 0
    ? 0
    : Math.round(paidOrders7d.reduce((s, o) => s + o.totalCents, 0) / paidOrders7d.length);

  // Repeat buyer fraction: of buyers who placed an order in last 7d, how many
  // had a paid order BEFORE that window?
  const buyersIn7d = Array.from(new Set(paidOrders7d.map((o) => o.buyerId)));
  let repeatBuyers = 0;
  if (buyersIn7d.length > 0) {
    const priorPaid = await prisma.order.groupBy({
      by: ['buyerId'],
      where: { buyerId: { in: buyersIn7d }, status: { in: PAID_STATES }, createdAt: { lt: since7 } },
      _count: { _all: true },
    });
    repeatBuyers = priorPaid.length;
  }
  const repeatPct = buyersIn7d.length === 0 ? 0 : Math.round((repeatBuyers / buyersIn7d.length) * 100);

  const byStatus: Record<string, number> = {};
  let allStatusTotal = 0;
  for (const b of statusBreakdown) {
    byStatus[b.status] = b._count._all;
    allStatusTotal += b._count._all;
  }
  const awaitingCount = (byStatus['PAID'] ?? 0) + (byStatus['PROCESSING'] ?? 0);

  function href(over: Partial<{ status: string; awaiting: string; range: string; q: string; page: string }>) {
    const sp = new URLSearchParams();
    const merged = {
      status: over.status !== undefined ? over.status : (awaiting ? '' : (searchParams.status ?? '')),
      awaiting: over.awaiting !== undefined ? over.awaiting : (awaiting ? '1' : ''),
      range: over.range !== undefined ? over.range : range !== 'all' ? range : '',
      q: over.q !== undefined ? over.q : q,
      page: over.page ?? '',
    };
    if (merged.status) sp.set('status', merged.status);
    if (merged.awaiting) sp.set('awaiting', merged.awaiting);
    if (merged.range) sp.set('range', merged.range);
    if (merged.q) sp.set('q', merged.q);
    if (merged.page) sp.set('page', merged.page);
    return sp.toString() ? `/admin/orders?${sp}` : '/admin/orders';
  }
  function viewHref(v: '' | 'archived' | 'awaiting_verify') {
    const sp = new URLSearchParams();
    if (v) sp.set('view', v);
    if (range !== 'all') sp.set('range', range);
    if (q) sp.set('q', q);
    return sp.toString() ? `/admin/orders?${sp}` : '/admin/orders';
  }

  const statusChips: { key: string; label: string; count: number; active: boolean; href?: string }[] = [
    { key: '__all', label: 'All', count: allStatusTotal, active: !statusFilter && !awaiting && !view, href: viewHref('') },
    { key: '__awaiting_verify', label: 'Awaiting verification', count: awaitingVerifyCount, active: view === 'awaiting_verify', href: viewHref('awaiting_verify') },
    { key: '__awaiting', label: 'Awaiting fulfilment', count: awaitingCount, active: awaiting && !view },
    { key: 'PENDING_PAYMENT', label: 'pending payment', count: byStatus['PENDING_PAYMENT'] ?? 0, active: !view && statusFilter?.length === 1 && statusFilter[0] === 'PENDING_PAYMENT' && !awaiting },
    { key: 'PAID', label: 'paid', count: byStatus['PAID'] ?? 0, active: !view && statusFilter?.length === 1 && statusFilter[0] === 'PAID' && !awaiting },
    { key: 'PROCESSING', label: 'processing', count: byStatus['PROCESSING'] ?? 0, active: !view && statusFilter?.length === 1 && statusFilter[0] === 'PROCESSING' && !awaiting },
    { key: 'SHIPPED', label: 'shipped', count: byStatus['SHIPPED'] ?? 0, active: !view && statusFilter?.length === 1 && statusFilter[0] === 'SHIPPED' && !awaiting },
    { key: 'DELIVERED', label: 'delivered', count: byStatus['DELIVERED'] ?? 0, active: !view && statusFilter?.length === 1 && statusFilter[0] === 'DELIVERED' && !awaiting },
    { key: 'CANCELED', label: 'canceled', count: byStatus['CANCELED'] ?? 0, active: !view && statusFilter?.length === 1 && statusFilter[0] === 'CANCELED' && !awaiting },
    { key: 'REFUNDED', label: 'refunded', count: byStatus['REFUNDED'] ?? 0, active: !view && statusFilter?.length === 1 && statusFilter[0] === 'REFUNDED' && !awaiting },
    { key: '__archived', label: 'Archived', count: archivedCount, active: view === 'archived', href: viewHref('archived') },
  ];

  const rangeLabel: Record<Range, string> = { all: 'all time', '7d': 'last 7d', '30d': 'last 30d', '90d': 'last 90d' };

  return (
    <div className="space-y-6">
      <ProductQuickView />
      <OrderQuickView />
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Orders &amp; sales</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {`${total} order${total === 1 ? '' : 's'} · ${rangeLabel[range]}`}
            {awaiting ? ' · awaiting fulfilment' : statusFilter ? ` · ${statusFilter.map((s) => s.toLowerCase()).join(' or ')}` : ''}
            {q ? ` · matching “${q}”` : ''}
            {totalPages > 1 ? ` · page ${page}/${totalPages}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex items-center gap-1 rounded-full border border-border bg-card p-1">
            {(['all', '7d', '30d', '90d'] as Range[]).map((r) => (
              <Link
                key={r}
                href={href({ range: r === 'all' ? '' : r })}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                  range === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Calendar className="h-3 w-3 inline mr-1 -mt-0.5" />
                {r === 'all' ? 'All time' : r}
              </Link>
            ))}
          </div>
          <a
            href={`/admin/orders/export${range !== 'all' ? `?range=${range}` : ''}`}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-border bg-card text-xs font-semibold hover:bg-foreground/5"
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </a>
        </div>
      </div>

      {/* Sales intelligence ribbon — what's worth knowing in 1 glance */}
      <section className="rounded-2xl border border-border bg-gradient-to-r from-card via-card to-emerald-50/30 p-3 grid grid-cols-2 md:grid-cols-4 gap-px overflow-hidden">
        <RibbonStat
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          label="Top category · 7d"
          value={topCat ? topCat[0] : '—'}
          sub={topCat ? formatPrice(topCat[1], 'EUR') : 'no paid orders'}
        />
        <RibbonStat
          icon={<Building2 className="h-3.5 w-3.5" />}
          label="Top supplier · 7d"
          value={topSup ? topSup[0] : '—'}
          sub={topSup ? formatPrice(topSup[1], 'EUR') : 'no paid orders'}
        />
        <RibbonStat
          icon={<UsersIcon className="h-3.5 w-3.5" />}
          label="Avg order value · 7d"
          value={aov7 === 0 ? '—' : formatPrice(aov7, 'EUR')}
          sub={`${paidOrders7d.length} paid order${paidOrders7d.length === 1 ? '' : 's'}`}
        />
        <RibbonStat
          icon={<Repeat className="h-3.5 w-3.5" />}
          label="Repeat customers · 7d"
          value={buyersIn7d.length === 0 ? '—' : `${repeatPct}%`}
          sub={buyersIn7d.length === 0 ? 'no buyers yet' : `${repeatBuyers} of ${buyersIn7d.length} buyers`}
        />
      </section>

      <AdminSearch basePath="/admin/orders" q={q} status={statusFilter?.[0]} placeholder="Search order #, buyer, item…" />

      {/* Drillable stat tiles — Revenue dominant (2-cols); action tiles next.
          Pending-payment uses alert-red when >0 so the eye catches it. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          icon={<Banknote className="h-5 w-5" />}
          label={`Revenue · ${rangeLabel[range]}`}
          value={formatPrice(revenue, 'EUR')}
          href={href({ status: '', awaiting: '' })}
          tone="emerald"
          dominant
          subtitle={`${paidCount} paid order${paidCount === 1 ? '' : 's'}`}
          className="col-span-2"
        />
        <StatTile
          icon={<Truck className="h-5 w-5" />}
          label="Awaiting fulfilment"
          value={String(awaitingCount)}
          href={href({ status: '', awaiting: '1' })}
          tone={awaitingCount > 0 ? 'amber' : 'neutral'}
          subtitle={awaitingCount > 0 ? 'needs shipping today' : 'all caught up'}
          actionable={awaitingCount > 0}
        />
        <StatTile
          icon={<CircleAlert className="h-5 w-5" />}
          label="Pending payment"
          value={String(byStatus['PENDING_PAYMENT'] ?? 0)}
          href={href({ status: 'PENDING_PAYMENT', awaiting: '' })}
          tone={(byStatus['PENDING_PAYMENT'] ?? 0) > 0 ? 'red' : 'neutral'}
          subtitle={(byStatus['PENDING_PAYMENT'] ?? 0) > 0 ? 'send payment link' : 'no orders stuck'}
          alert={(byStatus['PENDING_PAYMENT'] ?? 0) > 0}
        />
      </div>

      {/* Status chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {statusChips.map((c) => {
          const dest = c.href
            ? c.href
            : c.key === '__all'
              ? href({ status: '', awaiting: '' })
              : c.key === '__awaiting'
                ? href({ status: '', awaiting: '1' })
                : href({ status: c.key, awaiting: '' });
          return (
            <Link
              key={c.key}
              href={dest}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                c.active
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-foreground hover:bg-foreground/5'
              }`}
            >
              {c.label}
              <span className={`tabular-nums ${c.active ? 'opacity-90' : 'opacity-60'}`}>{c.count}</span>
            </Link>
          );
        })}
      </div>

      {orders.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <Banknote className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No orders match this view</p>
          <p className="text-sm text-muted-foreground mt-2">
            Try a wider date range or clear the filters.
          </p>
        </div>
      ) : (
        <OrdersListShell
          view={view}
          rows={orders.map((o) => {
            const buyer = humaniseBuyer(o.buyer);
            const intel = intelByBuyer.get(o.buyer.id) ?? { paidCount: 0, lifetimeCents: 0 };
            const priority = computeOrderPriority({
              status: o.status,
              totalCents: o.totalCents,
              createdAt: o.createdAt,
              // BUG-009 (RB): use the strict completeness predicate so URGENT
              // surfaces every order that can't actually ship, not just the
              // null-address case. A row with `{address: {}}` is just as
              // unshippable as one with `shippingAddress: null`.
              hasShippingAddress: shippingAddressIsComplete(o.shippingAddress),
              buyerPaidOrderCount: intel.paidCount,
              buyerLifetimeCents: intel.lifetimeCents,
            });
            const supplierNames = Array.from(new Set(o.items.map((i) => i.product?.seller?.name).filter(Boolean) as string[]));
            return {
              id: o.id,
              orderNumber: o.orderNumber,
              status: o.status,
              statusTone: STATUS_TONE[o.status] ?? 'slate',
              statusLabel: STATUS_LABEL[o.status] ?? o.status.toLowerCase(),
              totalLabel: formatPrice(o.totalCents, o.currency),
              buyerPrimary: buyer.primary,
              buyerSecondary: buyer.secondary,
              buyerCompany: o.buyer.company?.name ?? null,
              buyerPaidOrderCount: intel.paidCount,
              buyerLifetimeLabel: intel.lifetimeCents > 0 ? formatPrice(intel.lifetimeCents, o.currency) : null,
              anonymised: buyer.anonymised,
              itemsCount: o.items.reduce((s, i) => s + i.quantity, 0),
              dateLabel: 'Ordered ' + new Date(o.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
              firstItemTitle: o.items[0]?.titleSnapshot ?? null,
              firstItemImage: o.items[0]?.product?.images?.[0] ?? null,
              firstItemSlug: o.items[0]?.product?.slug ?? null,
              firstItemCategory: o.items[0]?.product?.category?.name ?? null,
              itemCountExtra: Math.max(0, o.items.length - 1),
              supplierName: supplierNames[0] ?? null,
              supplierCompany: o.items[0]?.product?.seller?.company?.name ?? null,
              distinctSuppliers: supplierNames.length,
              carrier: o.trackingCarrier,
              trackingNumber: o.trackingNumber,
              hasReceipt: !!o.paymentProofUrl,
              hasShippingAddress: shippingAddressIsComplete(o.shippingAddress),
              shipTo: shipAddressOneLiner(o.shippingAddress),
              buyerCountry: o.buyerCountry,
              priority,
              paymentVerificationStatus: (o.paymentVerificationStatus ?? null) as 'AWAITING_VERIFICATION' | 'VERIFIED' | 'REJECTED' | null,
              paymentSubmittedAtISO: o.paymentSubmittedAt?.toISOString() ?? null,
              archived: !!o.archivedAt,
            };
          })}
        />
      )}

      <AdminPager basePath="/admin/orders" page={page} totalPages={totalPages} total={total} q={q} status={statusFilter?.[0]} />
    </div>
  );
}

function RibbonStat({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="px-3 py-2 bg-card">
      <p className="text-[9px] uppercase tracking-[0.16em] font-bold text-muted-foreground inline-flex items-center gap-1">
        {icon} {label}
      </p>
      <p className="text-sm font-semibold tracking-tight mt-0.5 truncate" title={value}>{value}</p>
      <p className="text-[10px] text-muted-foreground tabular-nums">{sub}</p>
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  href,
  tone,
  subtitle,
  dominant,
  actionable,
  alert,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href: string;
  tone?: 'emerald' | 'amber' | 'red' | 'neutral';
  subtitle?: string;
  /** Renders 2× larger value + brand glow — use for the single hero KPI. */
  dominant?: boolean;
  /** Adds a primary "→" indicator suggesting click-to-act. */
  actionable?: boolean;
  /** Pulse ring + saturated text — only when value demands attention. */
  alert?: boolean;
  className?: string;
}) {
  // Minimal renderer — recovered after Edit-tool truncation incident.
  // Visual parity with original is good enough; UX-critical signal is
  // the tone band + label/value/subtitle layout.
  const toneSurface =
    tone === 'emerald'
      ? 'border-emerald-200 bg-emerald-50/40'
      : tone === 'amber'
        ? 'border-amber-200 bg-amber-50/40'
        : tone === 'red'
          ? alert
            ? 'border-red-300 bg-red-50 ring-2 ring-red-200/60'
            : 'border-red-200 bg-red-50/40'
          : 'border-border bg-card';
  const toneText =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'red'
          ? 'text-red-700'
          : 'text-muted-foreground';
  return (
    <Link
      href={href}
      className={`group rounded-2xl border ${toneSurface} ${className ?? ''} p-4 transition-all hover:shadow-md block relative`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className={toneText}>{icon}</div>
        {alert && (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          </span>
        )}
      </div>
      <p
        className={`tabular-nums mt-2 font-bold ${dominant ? 'text-4xl' : 'text-2xl'} ${tone === 'emerald' && dominant ? 'text-emerald-800' : ''}`}
        style={{ letterSpacing: '-0.03em' }}
      >
        {value}
      </p>
      <p className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mt-1">{label}</p>
      {subtitle && (
        <p className={`text-[11px] mt-1 ${actionable || alert ? toneText : 'text-muted-foreground/80'}`}>
          {subtitle}
        </p>
      )}
    </Link>
  );
}
