import Link from 'next/link';
import {
  LifeBuoy,
  Inbox,
  Hourglass,
  CircleCheck,
  Lock,
  Trash2,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireCapability, getServerSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { TicketStatus, Prisma } from '@prisma/client';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { TicketBulkList } from '@/components/admin/TicketBulkList';
import type { TicketRowProps } from '@/components/admin/TicketRow';

export const dynamic = 'force-dynamic';

const TAB_STATUSES: Array<{ key: string; label: string; statusFilter?: TicketStatus[] }> = [
  { key: 'open', label: 'Open', statusFilter: ['OPEN', 'WAITING_ON_SUPPORT'] },
  { key: 'waiting_customer', label: 'Waiting on customer', statusFilter: ['WAITING_ON_CUSTOMER'] },
  { key: 'resolved', label: 'Resolved', statusFilter: ['RESOLVED'] },
  { key: 'closed', label: 'Closed', statusFilter: ['CLOSED'] },
  { key: 'spam', label: 'Spam', statusFilter: ['SPAM'] },
  { key: 'all', label: 'All', statusFilter: undefined },
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
  OPEN: 0, WAITING_ON_SUPPORT: 0, WAITING_ON_CUSTOMER: 1, PENDING: 1, RESOLVED: 2, CLOSED: 3, SPAM: 4,
};

export default async function AdminTicketsPage({
  searchParams,
}: {
  searchParams: { tab?: string; q?: string; view?: string; assignee?: string; priority?: string; sort?: string };
}) {
  await requireCapability('tickets:view');
  const session = await getServerSession();
  const q = (searchParams.q ?? '').trim();
  const tab = TAB_STATUSES.find((t) => t.key === searchParams.tab) ?? TAB_STATUSES[0];
  const view = searchParams.view === 'archived' ? 'archived' : '';
  const assignee = searchParams.assignee ?? '';
  const priority = searchParams.priority ?? '';
  const sortRaw = searchParams.sort ?? '';
  const sort: SortKey = (SORT_OPTIONS.find((s) => s.key === sortRaw)?.key ?? 'urgency') as SortKey;

  // Build query: respect tab/view/assignee/priority/search.
  const where: Prisma.SupportTicketWhereInput = {
    ...(view === 'archived' ? { archivedAt: { not: null } } : { archivedAt: null }),
    ...(tab.statusFilter ? { status: { in: tab.statusFilter } } : {}),
    ...(assignee === 'me' && session?.user.id ? { assignedToId: session.user.id } : {}),
    ...(assignee === 'unassigned' ? { assignedToId: null } : {}),
    ...(priority ? { priority } : {}),
    ...(q
      ? {
          OR: [
            { ref: { contains: q, mode: 'insensitive' } },
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { subject: { contains: q, mode: 'insensitive' } },
            { category: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  // Sort: fetch a wider slice (200) for urgency/SLA so post-sort top-100 truly
  // reflects the overall queue, not just the most recent 100 createdAt rows.
  const orderByForFetch =
    sort === 'oldest'
      ? [{ createdAt: 'asc' as const }]
      : [{ createdAt: 'desc' as const }];
  const ticketsRaw = await prisma.supportTicket.findMany({
    where,
    orderBy: orderByForFetch,
    take: sort === 'urgency' || sort === 'sla' ? 200 : 100,
    include: {
      submittedBy: {
        select: {
          id: true,
          name: true,
          email: true,
          company: { select: { name: true } },
        },
      },
      assignedTo: {
        select: { id: true, name: true, email: true },
      },
      messages: { select: { fromStaff: true, attachments: true, isInternalNote: true } },
    },
  });

  // Apply post-fetch sort for urgency / SLA, then trim to 100.
  const sortedTickets = (() => {
    if (sort === 'urgency') {
      return [...ticketsRaw].sort((a, b) => {
        const pa = PRIORITY_WEIGHT[a.priority] ?? 9;
        const pb = PRIORITY_WEIGHT[b.priority] ?? 9;
        if (pa !== pb) return pa - pb;
        const sa = STATUS_WEIGHT[a.status] ?? 9;
        const sb = STATUS_WEIGHT[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        // tie-break: earliest dueAt (more overdue first), else newest
        const da = a.dueAt?.getTime() ?? Infinity;
        const db = b.dueAt?.getTime() ?? Infinity;
        if (da !== db) return da - db;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });
    }
    if (sort === 'sla') {
      return [...ticketsRaw].sort((a, b) => {
        const da = a.dueAt?.getTime() ?? Infinity;
        const db = b.dueAt?.getTime() ?? Infinity;
        return da - db;
      });
    }
    return ticketsRaw;
  })();
  const tickets = sortedTickets.slice(0, 100);

  // Buyer intel (LTV + paid count) for tickets with a registered submitter.
  const buyerIds = Array.from(new Set(tickets.map((t) => t.submittedBy?.id).filter(Boolean) as string[]));
  const intelByBuyer = new Map<string, { paidCount: number; lifetimeCents: number }>();
  if (buyerIds.length > 0) {
    const stats = await prisma.order.groupBy({
      by: ['buyerId'],
      where: { buyerId: { in: buyerIds }, status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] } },
      _sum: { totalCents: true },
      _count: { _all: true },
    });
    for (const s of stats) {
      intelByBuyer.set(s.buyerId, { paidCount: s._count._all, lifetimeCents: s._sum.totalCents ?? 0 });
    }
  }

  // Linked-commerce labels resolved in one round-trip.
  const orderIds = Array.from(new Set(tickets.map((t) => t.orderId).filter(Boolean) as string[]));
  const rfqIds = Array.from(new Set(tickets.map((t) => t.sourcingRequestId).filter(Boolean) as string[]));
  const [linkedOrders, linkedRfqs] = await Promise.all([
    orderIds.length > 0
      ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true, status: true } })
      : [],
    rfqIds.length > 0
      ? prisma.sourcingRequest.findMany({ where: { id: { in: rfqIds } }, select: { id: true, proformaNumber: true, status: true } })
      : [],
  ]);
  const orderById = new Map(linkedOrders.map((o) => [o.id, o]));
  const rfqById = new Map(linkedRfqs.map((r) => [r.id, r]));

  // Counts for the chips — archived + my queue + unassigned. Independent of
  // current filters so the chip badge always reflects total backlog.
  const [archivedCount, myCount, unassignedCount, urgentOrVipCount] = await Promise.all([
    prisma.supportTicket.count({ where: { archivedAt: { not: null } } }),
    session?.user.id
      ? prisma.supportTicket.count({ where: { archivedAt: null, assignedToId: session.user.id, status: { in: ['OPEN', 'WAITING_ON_SUPPORT'] } } })
      : 0,
    prisma.supportTicket.count({ where: { archivedAt: null, assignedToId: null, status: { in: ['OPEN', 'WAITING_ON_SUPPORT'] } } }),
    prisma.supportTicket.count({ where: { archivedAt: null, priority: { in: ['VIP', 'URGENT'] }, status: { in: ['OPEN', 'WAITING_ON_SUPPORT'] } } }),
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
    return sp.toString() ? `/admin/tickets?${sp}` : '/admin/tickets';
  }

  return (
    <div className="space-y-6">
      <AutoRefresh />

      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
            <LifeBuoy className="h-7 w-7 text-primary" /> Support tickets
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {`${tickets.length} ticket${tickets.length === 1 ? '' : 's'} ${view === 'archived' ? 'archived' : `· ${tab.label.toLowerCase()}`}${q ? ` · matching "${q}"` : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <SignalChip label="VIP/Urgent" value={urgentOrVipCount} tone={urgentOrVipCount > 0 ? 'red' : 'neutral'} href={href({ priority: 'URGENT', view: '' })} />
          <SignalChip label="My queue" value={myCount} tone={myCount > 0 ? 'amber' : 'neutral'} href={href({ assignee: 'me', view: '' })} />
          <SignalChip label="Unassigned" value={unassignedCount} tone={unassignedCount > 0 ? 'amber' : 'neutral'} href={href({ assignee: 'unassigned', view: '' })} />
        </div>
      </div>

      {/* Search + sort */}
      <form method="GET" className="flex gap-2 flex-wrap items-center">
        {searchParams.tab && <input type="hidden" name="tab" value={searchParams.tab} />}
        {view && <input type="hidden" name="view" value={view} />}
        {assignee && <input type="hidden" name="assignee" value={assignee} />}
        {priority && <input type="hidden" name="priority" value={priority} />}
        <input
          name="q"
          defaultValue={q}
          placeholder="Search ref, name, email, subject, company, order number…"
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
          <a
            href="/admin/tickets"
            className="inline-flex items-center px-3 h-10 rounded-full text-xs font-semibold bg-foreground/5 hover:bg-foreground/10"
          >
            Reset
          </a>
        )}
      </form>

      {/* Status tabs */}
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

      {/* Active filter pills */}
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

      {/* Rows */}
      {tickets.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <Inbox className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No tickets match this view</p>
          <p className="text-sm text-muted-foreground mt-2">Try a different tab or clear the filters.</p>
        </div>
      ) : (
        <TicketBulkList
          rows={tickets.map((t): TicketRowProps => {
            const intel = t.submittedBy?.id ? intelByBuyer.get(t.submittedBy.id) : null;
            const lastMsg = t.messages[t.messages.length - 1];
            const attachmentCount = t.messages.reduce((s, m) => s + (m.attachments?.length ?? 0), 0);
            const internalNoteCount = t.messages.filter((m) => m.isInternalNote).length;
            const linkedOrder = t.orderId ? orderById.get(t.orderId) : null;
            const linkedRfq = t.sourcingRequestId ? rfqById.get(t.sourcingRequestId) : null;
            return {
              id: t.id,
              ref_: t.ref,
              subject: t.subject,
              name: t.name,
              email: t.email,
              company: t.submittedBy?.company?.name ?? null,
              category: t.category,
              status: t.status,
              priority: t.priority,
              dueAtISO: t.dueAt?.toISOString() ?? null,
              createdAtISO: t.createdAt.toISOString(),
              lastReplyAtISO: t.lastReplyAt?.toISOString() ?? null,
              lastReplyByStaff: t.lastReplyByStaff,
              customerType: t.customerType as 'REGISTERED' | 'GUEST',
              assignee: t.assignedTo
                ? { id: t.assignedTo.id, name: t.assignedTo.name, email: t.assignedTo.email }
                : null,
              myUserId: session?.user.id ?? null,
              attachmentCount,
              internalNoteCount,
              messageCount: t.messages.length,
              isRegistered: !!t.submittedBy,
              lifetimeCents: intel?.lifetimeCents ?? 0,
              paidOrderCount: intel?.paidCount ?? 0,
              linkedOrder,
              linkedRfq,
              archived: !!t.archivedAt,
              lastBodyPreview: lastMsg?.fromStaff ? null : null,
            };
          })}
          view={view === 'archived' ? 'archived' : 'active'}
          canDelete={await hasCapability('tickets:delete')}
        />
      )}
    </div>
  );
}

function SignalChip({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: number;
  tone: 'red' | 'amber' | 'neutral';
  href: string;
}) {
  const cls = tone === 'red'
    ? 'border-red-200 bg-red-50 text-red-800'
    : tone === 'amber'
    ? 'border-amber-200 bg-amber-50 text-amber-800'
    : 'border-border bg-card text-muted-foreground';
  const icon = tone === 'red' ? <AlertCircle className="h-3 w-3" /> : tone === 'amber' ? <Hourglass className="h-3 w-3" /> : <CircleCheck className="h-3 w-3" />;
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full border font-semibold ${cls}`}
    >
      {icon} {label} <span className="tabular-nums">{value}</span>
    </Link>
  );
}
