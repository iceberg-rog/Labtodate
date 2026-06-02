import { FileText, Inbox, LifeBuoy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireCapability, getServerSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { QuoteStatus, Prisma } from '@prisma/client';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { QuoteBulkList } from '@/components/admin/QuoteBulkList';
import type { QuoteRowProps } from '@/components/admin/QuoteRow';

export const dynamic = 'force-dynamic';

/**
 * Tab definitions for the operator queue. The "waiting" tab is special: it
 * carves out only deals where a formal proforma has been issued and we are
 * now waiting on the buyer to pay/decline. Without it, those deals were
 * hiding inside "Open" alongside fresh inbound RFQs that still need a reply.
 *
 * `extraWhere` is merged into the Prisma WHERE so the tab can layer in
 * filters that don't fit the simple status[] shape.
 */
const TAB_STATUSES: Array<{
  key: string;
  label: string;
  statusFilter?: QuoteStatus[];
  extraWhere?: Prisma.SourcingRequestWhereInput;
}> = [
  {
    key: 'open',
    label: 'Open',
    statusFilter: ['PENDING', 'RESPONDED'],
    // Hide proforma-sent deals from Open (they belong to Waiting). A deal
    // is in Open while either nobody's quoted yet, or staff is still mid-
    // negotiation with text-only replies.
    extraWhere: { proformaNumber: null },
  },
  {
    key: 'waiting',
    label: 'Waiting',
    statusFilter: ['RESPONDED'],
    extraWhere: { proformaNumber: { not: null } },
  },
  { key: 'won',      label: 'Won',      statusFilter: ['ACCEPTED'] },
  { key: 'lost',     label: 'Lost',     statusFilter: ['DECLINED', 'CLOSED'] },
  { key: 'all',      label: 'All',      statusFilter: undefined },
];

const SORT_OPTIONS = [
  { key: 'urgency', label: 'Urgency' },
  { key: 'sla',     label: 'SLA · soonest' },
  { key: 'newest',  label: 'Newest' },
  { key: 'oldest',  label: 'Oldest' },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]['key'];
const PRIORITY_WEIGHT: Record<string, number> = { VIP: 0, URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
const STATUS_WEIGHT: Record<string, number> = {
  PENDING: 0, RESPONDED: 1, ACCEPTED: 2, DECLINED: 3, CLOSED: 4,
};

export default async function AdminQuotesPage(
  props: {
    searchParams: Promise<{
      tab?: string; q?: string; view?: string; assignee?: string; priority?: string; sort?: string;
    }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireCapability('quotes:view');
  const session = await getServerSession();
  const q = (searchParams.q ?? '').trim();
  const tab = TAB_STATUSES.find((t) => t.key === searchParams.tab) ?? TAB_STATUSES[0];
  const view = searchParams.view === 'archived' ? 'archived' : '';
  const assignee = searchParams.assignee ?? '';
  const priority = searchParams.priority ?? '';
  const sort: SortKey = (SORT_OPTIONS.find((s) => s.key === searchParams.sort)?.key ?? 'urgency') as SortKey;

  const where: Prisma.SourcingRequestWhereInput = {
    ...(view === 'archived' ? { archivedAt: { not: null } } : { archivedAt: null }),
    ...(tab.statusFilter ? { status: { in: tab.statusFilter } } : {}),
    ...(tab.extraWhere ?? {}),
    ...(assignee === 'me' && session?.user.id ? { assignedToId: session.user.id } : {}),
    ...(assignee === 'unassigned' ? { assignedToId: null } : {}),
    ...(priority ? { priority } : {}),
    ...(q
      ? {
          OR: [
            { buyerName: { contains: q, mode: 'insensitive' as const } },
            { buyerEmail: { contains: q, mode: 'insensitive' as const } },
            { companyName: { contains: q, mode: 'insensitive' as const } },
            { description: { contains: q, mode: 'insensitive' as const } },
            { productCategory: { contains: q, mode: 'insensitive' as const } },
            { proformaNumber: { contains: q, mode: 'insensitive' as const } },
            { product: { title: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  // For urgency/sla, fetch wider then sort post-fetch
  const orderByForFetch =
    sort === 'oldest' ? [{ createdAt: 'asc' as const }] : [{ createdAt: 'desc' as const }];
  const fetchTake = sort === 'urgency' || sort === 'sla' ? 200 : 100;

  const itemsRaw = await prisma.sourcingRequest.findMany({
    where,
    orderBy: orderByForFetch,
    take: fetchTake,
    include: {
      product: { select: { title: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
      submittedBy: { select: { id: true } },
      messages: { select: { fromStaff: true, attachments: true, isInternalNote: true } },
    },
  });

  // Batch: paid-order counts + lifetime per buyer, and linked-order status per quote.
  const buyerIds = Array.from(new Set(itemsRaw.map((q) => q.submittedBy?.id).filter(Boolean) as string[]));
  const buyerStats = new Map<string, { paidCount: number; lifetimeCents: number }>();
  if (buyerIds.length > 0) {
    const agg = await prisma.order.groupBy({
      by: ['buyerId'],
      where: { buyerId: { in: buyerIds }, status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] } },
      _sum: { totalCents: true },
      _count: { _all: true },
    });
    for (const a of agg) {
      buyerStats.set(a.buyerId, { paidCount: a._count._all, lifetimeCents: a._sum.totalCents ?? 0 });
    }
  }
  const quoteIds = itemsRaw.map((q) => q.id);
  const linkedOrders = quoteIds.length > 0
    ? await prisma.order.findMany({
        where: { sourcingRequestId: { in: quoteIds } },
        select: { sourcingRequestId: true, status: true },
      })
    : [];
  const linkedByQuote = new Map<string, string>();
  for (const lo of linkedOrders) {
    if (lo.sourcingRequestId) linkedByQuote.set(lo.sourcingRequestId, lo.status);
  }
  const adminCandidates = await prisma.user.findMany({
    where: { OR: [{ role: 'ADMIN' }, { role: 'SELLER' }] },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
    take: 30,
  });

  const sortedItems = (() => {
    if (sort === 'urgency') {
      return [...itemsRaw].sort((a, b) => {
        const pa = PRIORITY_WEIGHT[a.priority] ?? 9;
        const pb = PRIORITY_WEIGHT[b.priority] ?? 9;
        if (pa !== pb) return pa - pb;
        const sa = STATUS_WEIGHT[a.status] ?? 9;
        const sb = STATUS_WEIGHT[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        const da = a.dueAt?.getTime() ?? Infinity;
        const db = b.dueAt?.getTime() ?? Infinity;
        if (da !== db) return da - db;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });
    }
    if (sort === 'sla') {
      return [...itemsRaw].sort((a, b) => {
        const da = a.dueAt?.getTime() ?? Infinity;
        const db = b.dueAt?.getTime() ?? Infinity;
        return da - db;
      });
    }
    return itemsRaw;
  })();
  const items = sortedItems.slice(0, 100);

  const [archivedCount, myCount, unassignedCount, urgentVipCount] = await Promise.all([
    prisma.sourcingRequest.count({ where: { archivedAt: { not: null } } }),
    session?.user.id
      ? prisma.sourcingRequest.count({ where: { archivedAt: null, assignedToId: session.user.id, status: { in: ['PENDING', 'RESPONDED'] } } })
      : 0,
    prisma.sourcingRequest.count({ where: { archivedAt: null, assignedToId: null, status: { in: ['PENDING', 'RESPONDED'] } } }),
    prisma.sourcingRequest.count({ where: { archivedAt: null, priority: { in: ['VIP', 'URGENT'] }, status: { in: ['PENDING', 'RESPONDED'] } } }),
  ]);

  function href(over: Partial<{ tab: string; view: string; assignee: string; priority: string; q: string; sort: string }>) {
    const sp = new URLSearchParams();
    const merged = {
      tab: over.tab !== undefined ? over.tab : (searchParams.tab ?? ''),
      view: over.view !== undefined ? over.view : view,
      assignee: over.assignee !== undefined ? over.assignee : assignee,
      priority: over.priority !== undefined ? over.priority : priority,
      q: over.q !== undefined ? over.q : q,
      sort: over.sort !== undefined ? over.sort : (sort === 'urgency' ? '' : sort),
    };
    if (merged.tab && merged.tab !== 'open') sp.set('tab', merged.tab);
    if (merged.view) sp.set('view', merged.view);
    if (merged.assignee) sp.set('assignee', merged.assignee);
    if (merged.priority) sp.set('priority', merged.priority);
    if (merged.q) sp.set('q', merged.q);
    if (merged.sort) sp.set('sort', merged.sort);
    return sp.toString() ? `/admin/quotes?${sp}` : '/admin/quotes';
  }

  return (
    <div className="space-y-6">
      <AutoRefresh />

      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
            <FileText className="h-7 w-7 text-primary" /> Quote requests
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {`${items.length} request${items.length === 1 ? '' : 's'} ${view === 'archived' ? 'archived' : `· ${tab.label.toLowerCase()}`}${q ? ` · matching "${q}"` : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <SignalChip label="VIP/Urgent" value={urgentVipCount} tone={urgentVipCount > 0 ? 'red' : 'neutral'} href={href({ priority: 'URGENT', view: '' })} />
          <SignalChip label="My queue" value={myCount} tone={myCount > 0 ? 'amber' : 'neutral'} href={href({ assignee: 'me', view: '' })} />
          <SignalChip label="Unassigned" value={unassignedCount} tone={unassignedCount > 0 ? 'amber' : 'neutral'} href={href({ assignee: 'unassigned', view: '' })} />
        </div>
      </div>

      <form method="GET" className="flex gap-2 flex-wrap items-center">
        {searchParams.tab && <input type="hidden" name="tab" value={searchParams.tab} />}
        {view && <input type="hidden" name="view" value={view} />}
        {assignee && <input type="hidden" name="assignee" value={assignee} />}
        {priority && <input type="hidden" name="priority" value={priority} />}
        <input
          name="q"
          defaultValue={q}
          placeholder="Search buyer, email, item, proforma, category…"
          className="flex-1 min-w-[260px] h-10 px-3 rounded-lg border border-input bg-background text-sm"
        />
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="hidden sm:inline">Sort:</span>
          <select
            name="sort"
            defaultValue={sort}
            className="h-10 px-2 rounded-lg border border-input bg-background text-sm font-semibold"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" className="rounded-full font-semibold">Search</Button>
        {(q || assignee || priority || view || sort !== 'urgency') && (
          <a href="/admin/quotes" className="inline-flex items-center px-3 h-10 rounded-full text-xs font-semibold bg-foreground/5 hover:bg-foreground/10">
            Reset
          </a>
        )}
      </form>

      <div className="flex gap-1.5 flex-wrap border-b border-border pb-2">
        {TAB_STATUSES.map((t) => (
          <a
            key={t.key}
            href={href({ tab: t.key, view: '' })}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
              tab.key === t.key && !view
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card border-border text-foreground hover:bg-foreground/5'
            }`}
          >
            {t.label}
          </a>
        ))}
        <a
          href={href({ view: 'archived', tab: 'all' })}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
            view === 'archived'
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-card border-border text-foreground hover:bg-foreground/5'
          }`}
        >
          Archived <span className="opacity-60 tabular-nums">{archivedCount}</span>
        </a>
      </div>

      {(assignee || priority) && (
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="text-muted-foreground">Active filters:</span>
          {assignee && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-primary/10 text-primary font-semibold">
              Assignee: {assignee === 'me' ? 'me' : 'unassigned'}
              <a href={href({ assignee: '' })} className="ml-1 opacity-60 hover:opacity-100">×</a>
            </span>
          )}
          {priority && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-100 text-amber-800 font-semibold">
              Priority: {priority}
              <a href={href({ priority: '' })} className="ml-1 opacity-60 hover:opacity-100">×</a>
            </span>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <Inbox className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No quote requests match this view</p>
          <p className="text-sm text-muted-foreground mt-2">Try a different tab or clear the filters.</p>
        </div>
      ) : (
        <QuoteBulkList
          rows={items.map((sr): QuoteRowProps => {
            const attachmentCount = sr.messages.reduce((s, m) => s + (m.attachments?.length ?? 0), 0);
            const internalNoteCount = sr.messages.filter((m) => m.isInternalNote).length;
            const ref = sr.proformaNumber ?? `RFQ-${sr.id.slice(-6).toUpperCase()}`;
            const stats = sr.submittedBy ? buyerStats.get(sr.submittedBy.id) : null;
            return {
              id: sr.id,
              ref_: ref,
              subject: sr.product?.title ?? sr.productCategory ?? 'General sourcing request',
              buyerName: sr.buyerName,
              buyerEmail: sr.buyerEmail,
              company: sr.companyName,
              status: sr.status,
              lastReplyByStaff: sr.lastReplyByStaff,
              priority: sr.priority,
              dueAtISO: sr.dueAt?.toISOString() ?? null,
              createdAtISO: sr.createdAt.toISOString(),
              lastReplyAtISO: sr.lastReplyAt?.toISOString() ?? null,
              customerType: sr.customerType as 'REGISTERED' | 'GUEST',
              assignee: sr.assignedTo
                ? { id: sr.assignedTo.id, name: sr.assignedTo.name, email: sr.assignedTo.email }
                : null,
              myUserId: session?.user.id ?? null,
              attachmentCount,
              internalNoteCount,
              messageCount: sr.messages.length,
              productTitle: sr.product?.title ?? null,
              productCategory: sr.productCategory,
              quotedPriceCents: sr.quotedPriceCents,
              quotedCurrency: sr.quotedCurrency,
              proformaNumber: sr.proformaNumber,
              archived: !!sr.archivedAt,
              isRegistered: !!sr.submittedBy,
              buyerPaidOrders: stats?.paidCount ?? 0,
              buyerLifetimeCents: stats?.lifetimeCents ?? 0,
              linkedOrderStatus: linkedByQuote.get(sr.id) ?? null,
              admins: adminCandidates,
            };
          })}
          view={view === 'archived' ? 'archived' : 'active'}
          canDelete={await hasCapability('quotes:delete')}
        />
      )}
    </div>
  );
}

function SignalChip({
  label, value, tone, href,
}: { label: string; value: number; tone: 'red' | 'amber' | 'neutral'; href: string }) {
  const cls = tone === 'red'
    ? 'bg-red-50 text-red-800 border-red-200'
    : tone === 'amber'
    ? 'bg-amber-50 text-amber-800 border-amber-200'
    : 'bg-card text-muted-foreground border-border';
  return (
    <a href={href} className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-xs font-semibold hover:opacity-90 ${cls}`}>
      <LifeBuoy className="h-3 w-3" />
      <span>{label}</span>
      <span className="tabular-nums font-bold">{value}</span>
    </a>
  );
}
