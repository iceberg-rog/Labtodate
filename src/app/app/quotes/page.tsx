import Link from 'next/link';
import {
  FileText, ArrowRight, Inbox, MessageSquare, Sparkles, CheckCheck,
  Clock, CreditCard, XCircle, Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { computeDealState, type DealState } from '@/lib/quotes/deal-state';
import { InstrumentIllustration, ILLUSTRATIONS, type IllustrationName } from '@/components/illustrations/instruments';

export const dynamic = 'force-dynamic';

function fmtMoney(cents: number, ccy = 'EUR'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(cents / 100);
}

function smartDate(d: Date | null | undefined): string {
  if (!d) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400e3);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Visual map per computed deal-state — same shape as the orders page (stripe
 * + badge + icon + label + contextual primary CTA). Keeps the buyer's quote
 * queue legible at-a-glance and pulls the next-action right onto the row.
 */
type StateVisual = {
  stripe: string;
  badge: string;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  ctaLabel?: string;
  ctaHref?: (q: { id: string; orderNumber: string | null }) => string;
};
const STATE_VISUAL: Record<DealState, StateVisual> = {
  awaiting_supplier: {
    stripe: 'before:bg-amber-400',
    badge: 'bg-amber-100 text-amber-900 border-amber-200',
    Icon: Clock,
    label: 'Waiting for supplier',
  },
  awaiting_buyer: {
    stripe: 'before:bg-sky-400',
    badge: 'bg-sky-50 text-sky-900 border-sky-200',
    Icon: MessageSquare,
    label: 'Supplier replied · your move',
    ctaLabel: 'Open thread',
    ctaHref: (q) => `/app/quotes/${q.id}`,
  },
  proforma_sent: {
    stripe: 'before:bg-sky-500',
    badge: 'bg-sky-100 text-sky-900 border-sky-200',
    Icon: Sparkles,
    label: 'Proforma received · your decision',
    ctaLabel: 'Complete purchase',
    ctaHref: (q) => q.orderNumber ? `/app/orders/${q.orderNumber}/payment` : `/app/quotes/${q.id}`,
  },
  won_payment_pending: {
    stripe: 'before:bg-purple-500',
    badge: 'bg-purple-50 text-purple-900 border-purple-200',
    Icon: CreditCard,
    label: 'Awaiting your payment',
    ctaLabel: 'Complete purchase',
    ctaHref: (q) => q.orderNumber ? `/app/orders/${q.orderNumber}/payment` : `/app/quotes/${q.id}`,
  },
  won_paid: {
    stripe: 'before:bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-900 border-emerald-200',
    Icon: CheckCheck,
    label: 'Won · paid',
    ctaLabel: 'Open order',
    ctaHref: (q) => q.orderNumber ? `/app/orders/${q.orderNumber}` : `/app/quotes/${q.id}`,
  },
  won_no_order: {
    stripe: 'before:bg-emerald-400',
    badge: 'bg-emerald-50 text-emerald-900 border-emerald-200',
    Icon: CheckCheck,
    label: 'Accepted',
  },
  lost_declined: {
    stripe: 'before:bg-red-400',
    badge: 'bg-red-50 text-red-900 border-red-200',
    Icon: XCircle,
    label: 'You declined',
  },
  lost_closed: {
    stripe: 'before:bg-slate-400',
    badge: 'bg-slate-100 text-slate-700 border-slate-200',
    Icon: XCircle,
    label: 'Closed',
  },
  unknown: {
    stripe: 'before:bg-slate-300',
    badge: 'bg-slate-100 text-slate-700 border-slate-200',
    Icon: FileText,
    label: 'Quote',
  },
};

function resolveIllustration(category: string | null | undefined): IllustrationName {
  if (!category) return 'detector';
  const n = category.toLowerCase();
  if (/mass spec|lcms|gcms|\bms\b|spectromet/.test(n)) return 'massspec';
  if (/microscop|imaging/.test(n)) return 'microscope';
  if (/centrifug/.test(n)) return 'centrifuge';
  if (/balance|sample prep/.test(n)) return 'balance';
  if (/autosampler/.test(n)) return 'autosampler';
  if (/\bgc\b|gas chromatograph/.test(n)) return 'gc';
  if (/hplc|\blc\b/.test(n)) return 'hplc';
  if (/pump|fluidic|vacuum/.test(n)) return 'pcr';
  if (/spectroscop|aas|ir|uv|nir|nmr/.test(n)) return 'detector';
  if (category in ILLUSTRATIONS) return category as IllustrationName;
  return 'detector';
}

export default async function BuyerQuotesPage(props: { searchParams: Promise<{ filter?: string }> }) {
  const searchParams = await props.searchParams;
  const session = await requireSession({ redirectTo: '/app/quotes' });
  const filter = searchParams.filter ?? 'all';

  const items = await prisma.sourcingRequest.findMany({
    where: {
      OR: [
        { submittedById: session.user.id },
        { buyerEmail: session.user.email },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    // images: needed so the row thumbnail renders the real product photo
    // when the quote is anchored to a marketplace listing — only quotes
    // submitted via "Let Us Find It" without a product fall back to the
    // category-derived illustration.
    include: { product: { select: { title: true, slug: true, illustration: true, images: true } } },
  });

  const linked = items.length > 0
    ? await prisma.order.findMany({
        where: { sourcingRequestId: { in: items.map((q) => q.id) } },
        select: { sourcingRequestId: true, status: true, orderNumber: true },
      })
    : [];
  const linkedByQuote = new Map(linked.map((o) => [o.sourcingRequestId!, o]));

  // Enrich each item with computed deal-state once so we can reuse it for
  // both filter counts and rendering without recomputing per pill.
  const enriched = items.map((q) => {
    const lo = linkedByQuote.get(q.id);
    const deal = computeDealState({
      status: q.status,
      lastReplyByStaff: q.lastReplyByStaff,
      proformaNumber: q.proformaNumber,
      linkedOrder: lo ? { status: lo.status } : null,
    });
    return { q, deal, orderNumber: lo?.orderNumber ?? null };
  });

  const isActive = (s: DealState) =>
    s === 'awaiting_supplier' || s === 'awaiting_buyer' || s === 'proforma_sent' || s === 'won_payment_pending';
  const isWon = (s: DealState) => s === 'won_paid' || s === 'won_no_order';
  const isLost = (s: DealState) => s === 'lost_declined' || s === 'lost_closed';

  const counts = {
    all: enriched.length,
    active: enriched.filter((e) => isActive(e.deal.state)).length,
    won: enriched.filter((e) => isWon(e.deal.state)).length,
    lost: enriched.filter((e) => isLost(e.deal.state)).length,
  };

  // Lifetime quoted value across all WON quotes — the buyer's procurement
  // spend through the platform. Same shape as orders' lifetimeCents.
  const lifetimeQuotedCents = enriched
    .filter((e) => isWon(e.deal.state) && e.q.quotedPriceCents != null)
    .reduce((s, e) => s + (e.q.quotedPriceCents ?? 0), 0);

  const visible = enriched.filter((e) => {
    if (filter === 'all') return true;
    if (filter === 'active') return isActive(e.deal.state);
    if (filter === 'won') return isWon(e.deal.state);
    if (filter === 'lost') return isLost(e.deal.state);
    return true;
  });

  const filterTabs: Array<{ key: string; label: string; count: number }> = [
    { key: 'all',    label: 'All',    count: counts.all },
    { key: 'active', label: 'Active', count: counts.active },
    { key: 'won',    label: 'Won',    count: counts.won },
    { key: 'lost',   label: 'Lost',   count: counts.lost },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My quotes</h1>
        <p className="text-muted-foreground mt-1">
          {counts.all === 0
            ? 'You haven\'t sent a sourcing request yet.'
            : <>
                {counts.all} quote{counts.all === 1 ? '' : 's'}
                {counts.won > 0 && <> · <strong className="text-foreground">{counts.won} won</strong></>}
                {lifetimeQuotedCents > 0 && <> · <strong className="text-foreground">{fmtMoney(lifetimeQuotedCents, 'EUR')}</strong> won-deal value</>}
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
                href={t.key === 'all' ? '/app/quotes' : `/app/quotes?filter=${t.key}`}
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
            <Inbox className="h-7 w-7" />
          </div>
          <p className="text-lg font-bold">No quotes yet</p>
          <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
            Need a price on a specific instrument? Our team sources it from verified suppliers, usually within 1 business day.
          </p>
          <div className="mt-5 flex gap-3 justify-center flex-wrap">
            <Button asChild className="rounded-full font-semibold"><Link href="/let-us-find-it">Request a quote</Link></Button>
            <Button asChild variant="outline" className="rounded-full font-semibold"><Link href="/marketplace">Browse instruments</Link></Button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <Search className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            No quotes in <strong>{filter}</strong>.{' '}
            <Link href="/app/quotes" className="text-primary font-semibold underline-offset-4 hover:underline">Show all</Link>
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map(({ q, deal, orderNumber }) => {
            const vis = STATE_VISUAL[deal.state];
            const Icon = vis.Icon;
            const ref = q.proformaNumber ?? `RFQ-${q.id.slice(-6).toUpperCase()}`;
            const imgUrl = q.product?.images?.[0] ?? null;
            const illust = resolveIllustration(q.product?.illustration ?? q.productCategory);
            const title = q.product?.title ?? q.productCategory ?? 'General sourcing request';

            // Smart status line — one sentence per state telling the buyer
            // what's happening and what (if anything) they should do.
            let statusLine = `Opened ${smartDate(q.createdAt)}`;
            if (deal.state === 'awaiting_supplier') {
              statusLine = `Opened ${smartDate(q.createdAt)} · supplier typically replies within 1 business day`;
            } else if (deal.state === 'awaiting_buyer') {
              statusLine = `Supplier replied ${smartDate(q.lastReplyAt ?? q.updatedAt)} · they're drafting a formal quote`;
            } else if (deal.state === 'proforma_sent') {
              statusLine = `Proforma ${ref} · valid until ${q.validUntilAt ? q.validUntilAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}`;
            } else if (deal.state === 'won_payment_pending') {
              statusLine = `Order ${orderNumber} · awaiting your bank-transfer receipt`;
            } else if (deal.state === 'won_paid') {
              statusLine = `Order ${orderNumber} · paid ${smartDate(q.updatedAt)}`;
            } else if (deal.state === 'won_no_order') {
              statusLine = `Accepted ${smartDate(q.updatedAt)}`;
            } else if (deal.state === 'lost_declined') {
              statusLine = `Declined ${smartDate(q.updatedAt)}`;
            } else if (deal.state === 'lost_closed') {
              statusLine = `Closed ${smartDate(q.updatedAt)}`;
            }

            // Where does the row's main clickable target go? Won quotes
            // bypass the quote thread (it auto-redirects to the order
            // anyway); active quotes open the thread.
            const primaryHref =
              vis.ctaHref?.({ id: q.id, orderNumber })
              ?? (isWon(deal.state) && orderNumber ? `/app/orders/${orderNumber}` : `/app/quotes/${q.id}`);

            return (
              <li
                key={q.id}
                className={`relative rounded-2xl border border-border bg-card overflow-hidden transition-shadow hover:shadow-[0_10px_30px_-15px_rgba(15,79,64,0.25)]
                  before:content-[''] before:absolute before:inset-y-0 before:left-0 before:w-1 ${vis.stripe}`}
              >
                <div className="pl-5 pr-5 py-4 grid grid-cols-[64px_minmax(0,1fr)_auto] gap-4 items-start">
                  {/* Thumbnail — real product photo if the quote is
                      anchored to a marketplace listing, otherwise a
                      category-matched illustration. */}
                  <div className="h-16 w-16 rounded-xl bg-gradient-to-br from-[hsl(82_55%_95%)] to-[hsl(168_30%_94%)] border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
                    {imgUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      (<img src={imgUrl} alt="" className="w-full h-full object-cover" />)
                    ) : (
                      <InstrumentIllustration name={illust} className="h-12 w-12" />
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {ref}
                      </span>
                      <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${vis.badge}`}>
                        <Icon className="h-3 w-3" />
                        {vis.label}
                      </span>
                    </div>
                    <h3 className="font-bold text-[15px] leading-tight truncate">{title}</h3>
                    <p className="text-xs text-muted-foreground mt-1 truncate">{statusLine}</p>
                  </div>

                  <div className="text-right flex flex-col items-end gap-1 flex-shrink-0">
                    {q.quotedPriceCents != null ? (
                      <p className="text-lg font-bold tabular-nums leading-none">
                        {fmtMoney(q.quotedPriceCents, q.quotedCurrency ?? 'EUR')}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">awaiting quote</p>
                    )}
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground tabular-nums">
                      {new Date(q.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                </div>
                <div className="border-t border-border bg-foreground/[0.015] px-5 py-2.5 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    {vis.ctaLabel && vis.ctaHref && (
                      <Link
                        href={vis.ctaHref({ id: q.id, orderNumber })}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90"
                      >
                        {vis.ctaLabel} <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    )}
                    {q.proformaNumber && (
                      <Link
                        href={`/app/quotes/${q.id}/proforma`}
                        className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted"
                      >
                        <FileText className="h-3.5 w-3.5" /> Proforma
                      </Link>
                    )}
                  </div>
                  <Link
                    href={primaryHref}
                    className="text-xs font-semibold text-primary inline-flex items-center gap-1 hover:gap-2 transition-all"
                  >
                    {isWon(deal.state) && orderNumber ? 'View order' : 'Open'} <ArrowRight className="h-3.5 w-3.5" />
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
