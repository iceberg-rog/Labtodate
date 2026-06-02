import Link from 'next/link';
import {
  Package, ArrowRight, Truck, CheckCheck, Clock, CreditCard,
  XCircle, RefreshCcw, FileText, MapPin, Search, ShoppingBag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { InstrumentIllustration, ILLUSTRATIONS, type IllustrationName } from '@/components/illustrations/instruments';

export const dynamic = 'force-dynamic';

/**
 * Single source of truth for how each order status looks in the buyer list:
 * stripe color, badge palette, icon, human label, suggested next action.
 * Centralising it here keeps the row component declarative.
 */
type StatusVisual = {
  stripe: string;     // left rail color
  badge: string;      // pill bg/text
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  nextLabel?: string; // optional primary CTA (in addition to View detail)
  nextHref?: (orderNumber: string) => string;
};
const STATUS: Record<string, StatusVisual> = {
  PENDING_PAYMENT: {
    stripe: 'before:bg-amber-400',
    badge: 'bg-amber-100 text-amber-900 border-amber-200',
    Icon: Clock,
    label: 'Awaiting payment',
    nextLabel: 'Complete payment',
    nextHref: (n) => `/app/orders/${n}/payment`,
  },
  PAID: {
    stripe: 'before:bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-900 border-emerald-200',
    Icon: CreditCard,
    label: 'Paid',
  },
  PROCESSING: {
    stripe: 'before:bg-sky-400',
    badge: 'bg-sky-50 text-sky-900 border-sky-200',
    Icon: Package,
    label: 'Processing',
  },
  SHIPPED: {
    stripe: 'before:bg-violet-500',
    badge: 'bg-violet-50 text-violet-900 border-violet-200',
    Icon: Truck,
    label: 'Shipped',
  },
  DELIVERED: {
    stripe: 'before:bg-emerald-600',
    badge: 'bg-emerald-100 text-emerald-900 border-emerald-200',
    Icon: CheckCheck,
    label: 'Delivered',
  },
  CANCELED: {
    stripe: 'before:bg-slate-400',
    badge: 'bg-slate-100 text-slate-700 border-slate-200',
    Icon: XCircle,
    label: 'Canceled',
  },
  REFUNDED: {
    stripe: 'before:bg-slate-400',
    badge: 'bg-slate-100 text-slate-700 border-slate-200',
    Icon: RefreshCcw,
    label: 'Refunded',
  },
};

function resolveIllustration(name: string | null | undefined): IllustrationName {
  if (name && name in ILLUSTRATIONS) return name as IllustrationName;
  return 'detector';
}

function smartDate(d: Date | null | undefined): string {
  if (!d) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400e3);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default async function OrdersPage({ searchParams }: { searchParams: { filter?: string } }) {
  const session = await requireSession({ redirectTo: '/app/orders' });
  const filter = searchParams.filter ?? 'all';

  const orders = await prisma.order.findMany({
    where: { buyerId: session.user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      items: {
        include: {
          product: { select: { illustration: true, images: true } },
        },
      },
    },
  });

  // Summary: totals across all orders (filter-independent so the user always
  // sees their lifetime profile here — easier mental anchor than a
  // filter-dependent count that jumps when they toggle).
  const counts = {
    all: orders.length,
    active: orders.filter((o) => ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED'].includes(o.status)).length,
    delivered: orders.filter((o) => o.status === 'DELIVERED').length,
    canceled: orders.filter((o) => o.status === 'CANCELED' || o.status === 'REFUNDED').length,
  };
  const lifetimeCents = orders
    .filter((o) => ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(o.status))
    .reduce((s, o) => s + o.totalCents, 0);

  const visible = orders.filter((o) => {
    if (filter === 'all') return true;
    if (filter === 'active') return ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED'].includes(o.status);
    if (filter === 'delivered') return o.status === 'DELIVERED';
    if (filter === 'canceled') return o.status === 'CANCELED' || o.status === 'REFUNDED';
    return true;
  });

  const filterTabs: Array<{ key: string; label: string; count: number }> = [
    { key: 'all',       label: 'All',       count: counts.all },
    { key: 'active',    label: 'Active',    count: counts.active },
    { key: 'delivered', label: 'Delivered', count: counts.delivered },
    { key: 'canceled',  label: 'Canceled',  count: counts.canceled },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My orders</h1>
        <p className="text-muted-foreground mt-1">
          {counts.all === 0
            ? 'No orders yet.'
            : <>
                {counts.all} order{counts.all === 1 ? '' : 's'} ·{' '}
                <strong className="text-foreground">{formatPrice(lifetimeCents, 'EUR')}</strong>{' '}
                lifetime spend{counts.delivered > 0 && <> · {counts.delivered} delivered</>}
              </>
          }
        </p>
      </div>

      {counts.all > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {filterTabs.map((t) => {
            const active = filter === t.key;
            return (
              <Link
                key={t.key}
                href={t.key === 'all' ? '/app/orders' : `/app/orders?filter=${t.key}`}
                className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold transition ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card border border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {t.label}
                <span className={`tabular-nums ${active ? 'opacity-80' : 'opacity-60'}`}>{t.count}</span>
              </Link>
            );
          })}
        </div>
      )}

      {counts.all === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary inline-flex items-center justify-center mb-4">
            <ShoppingBag className="h-7 w-7" />
          </div>
          <p className="text-lg font-bold">No orders yet</p>
          <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
            Once you accept a quote or buy from the marketplace, your orders will appear here with live status, tracking and invoices.
          </p>
          <div className="mt-5 flex gap-3 justify-center flex-wrap">
            <Button asChild className="rounded-full font-semibold">
              <Link href="/marketplace">Browse marketplace</Link>
            </Button>
            <Button asChild variant="outline" className="rounded-full font-semibold">
              <Link href="/let-us-find-it">Request a quote</Link>
            </Button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <Search className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            No orders in <strong>{filter}</strong>.{' '}
            <Link href="/app/orders" className="text-primary font-semibold underline-offset-4 hover:underline">Show all</Link>
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((o) => {
            const vis = STATUS[o.status] ?? STATUS.PENDING_PAYMENT;
            const Icon = vis.Icon;
            const first = o.items[0];
            const imgUrl = first?.product?.images?.[0] ?? null;
            const illust = resolveIllustration(first?.product?.illustration);

            // Status-line under the title — a single sentence the human cares
            // about most for this state ("delivered May 26", "tracking …",
            // "we'll verify your receipt soon").
            let statusLine = `Placed ${smartDate(o.createdAt)}`;
            if (o.status === 'PENDING_PAYMENT' && o.paymentVerificationStatus === 'AWAITING_VERIFICATION') {
              statusLine = `Receipt uploaded ${smartDate(o.paymentSubmittedAt)} · we'll verify within 1 business day`;
            } else if (o.status === 'PENDING_PAYMENT') {
              statusLine = `Placed ${smartDate(o.createdAt)} · waiting for your bank-transfer receipt`;
            } else if (o.status === 'PAID') {
              statusLine = `Paid ${smartDate(o.paidAt)} · we're preparing your shipment`;
            } else if (o.status === 'SHIPPED' && o.trackingNumber) {
              statusLine = `Shipped ${smartDate(o.shippedAt)} · ${o.trackingCarrier ?? 'carrier'} ${o.trackingNumber}`;
            } else if (o.status === 'SHIPPED') {
              statusLine = `Shipped ${smartDate(o.shippedAt)}`;
            } else if (o.status === 'DELIVERED' && o.deliveredAt) {
              statusLine = `Delivered ${smartDate(o.deliveredAt)}${o.trackingCarrier ? ` via ${o.trackingCarrier}` : ''}`;
            } else if (o.status === 'CANCELED') {
              statusLine = `Canceled ${smartDate(o.updatedAt)}`;
            }

            return (
              <li
                key={o.id}
                className={`relative rounded-2xl border border-border bg-card overflow-hidden transition-shadow hover:shadow-[0_10px_30px_-15px_rgba(15,79,64,0.25)]
                  before:content-[''] before:absolute before:inset-y-0 before:left-0 before:w-1 ${vis.stripe}`}
              >
                <div className="pl-5 pr-5 py-4 grid grid-cols-[64px_minmax(0,1fr)_auto] gap-4 items-start">
                  {/* Thumbnail — real photo if available, otherwise an
                      InstrumentIllustration matching the product family. */}
                  <div className="h-16 w-16 rounded-xl bg-gradient-to-br from-[hsl(82_55%_95%)] to-[hsl(168_30%_94%)] border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
                    {imgUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imgUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <InstrumentIllustration name={illust} className="h-12 w-12" />
                    )}
                  </div>

                  {/* Title + meta + status line */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        #{o.orderNumber}
                      </span>
                      <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${vis.badge}`}>
                        <Icon className="h-3 w-3" />
                        {vis.label}
                      </span>
                    </div>
                    <h3 className="font-bold text-[15px] leading-tight truncate">
                      {first?.titleSnapshot ?? 'Order'}
                      {o.items.length > 1 && <span className="text-muted-foreground font-normal"> · +{o.items.length - 1} more</span>}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1">{statusLine}</p>
                  </div>

                  {/* Amount + secondary CTAs */}
                  <div className="text-right flex flex-col items-end gap-1 flex-shrink-0">
                    <p className="text-lg font-bold tabular-nums leading-none">{formatPrice(o.totalCents, o.currency)}</p>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{o.items.length} item{o.items.length === 1 ? '' : 's'}</p>
                  </div>
                </div>

                {/* Action bar — context-aware CTAs separated from the
                    informational row so the click target is unambiguous. */}
                <div className="border-t border-border bg-foreground/[0.015] px-5 py-2.5 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    {vis.nextLabel && vis.nextHref && (
                      <Link
                        href={vis.nextHref(o.orderNumber)}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90"
                      >
                        {vis.nextLabel} <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    )}
                    {['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(o.status) && (
                      <Link
                        href={`/app/orders/${o.orderNumber}/invoice`}
                        className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted"
                      >
                        <FileText className="h-3.5 w-3.5" /> Invoice
                      </Link>
                    )}
                    {o.status === 'SHIPPED' && (
                      <Link
                        href={`/app/orders/${o.orderNumber}`}
                        className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted"
                      >
                        <MapPin className="h-3.5 w-3.5" /> Track
                      </Link>
                    )}
                  </div>
                  <Link
                    href={`/app/orders/${o.orderNumber}`}
                    className="text-xs font-semibold text-primary inline-flex items-center gap-1 hover:gap-2 transition-all"
                  >
                    View detail <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
