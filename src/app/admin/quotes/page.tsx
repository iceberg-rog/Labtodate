import { FileText, Inbox, LifeBuoy, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireCapability, getServerSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { QuoteStatus, Prisma } from '@prisma/client';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { QuoteBulkList } from '@/components/admin/QuoteBulkList';
import type { QuoteRowProps } from '@/components/admin/QuoteRow';
import { ensureSettingsLoaded } from '@/lib/settings';
import { offerAmounts } from '@/lib/quotes/pricing';
import { QUOTE_REF, isQuoteRef } from '@/lib/quotes/offer';
import { LIVE_REFUNDS_SELECT } from '@/lib/finance/held';
import { partPaidLine, queuePage, queueTab, sortQueue, type QueueSort } from '@/components/quotes/quote-view';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Quote requests' };

/**
 * Tab definitions for the operator queue. "Open" = nothing priced yet (new
 * requests and text-only negotiation). "Offer sent" = an offer is on the table
 * and the buyer has to accept or decline it (expired offers included, so staff
 * can re-send). "Accepted" = the buyer accepted: an order + proforma exist and
 * we wait for the payment. The key stays `waiting` so old links keep working.
 *
 * `extraWhere` is merged into the Prisma WHERE so the tab can layer in
 * filters that don't fit the simple status[] shape.
 */
// An order that still commits the buyer: paid / shipped, or a receipt in review.
const PAID_FAMILY = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;
const TAB_STATUSES: Array<{
  key: string;
  label: string;
  statusFilter?: QuoteStatus[];
  extraWhere?: Prisma.SourcingRequestWhereInput;
  /** Not a tab button — the view the header signal chips link to. */
  hidden?: boolean;
}> = [
  {
    key: 'open',
    label: 'Open',
    statusFilter: ['PENDING', 'RESPONDED'],
    // A deal is Open while nobody has priced it yet (or staff is still
    // negotiating with text-only replies). Priced deals live in "Offer sent".
    extraWhere: { quotedPriceCents: null },
  },
  {
    key: 'review',
    label: 'Supplier prices to review',
    statusFilter: ['PENDING', 'RESPONDED'],
    extraWhere: { sellerProposalStatus: 'PENDING' },
  },
  {
    key: 'waiting',
    label: 'Offer sent',
    statusFilter: ['RESPONDED'],
    // Only offers really waiting for the buyer: legacy rows whose old order was
    // already paid or has a receipt in review are a deal (Accepted / Won).
    extraWhere: {
      quotedPriceCents: { not: null },
      OR: [
        { order: { is: null } },
        { order: { is: { status: 'CANCELED' } } },
        { order: { is: { status: 'PENDING_PAYMENT', paymentSubmittedAt: null } } },
      ],
    },
  },
  {
    key: 'won',
    label: 'Accepted · awaiting payment',
    extraWhere: {
      OR: [
        { status: 'ACCEPTED', order: { is: { status: 'PENDING_PAYMENT' } } },
        { status: 'ACCEPTED', order: { is: null } },
        { status: 'RESPONDED', order: { is: { status: 'PENDING_PAYMENT', paymentSubmittedAt: { not: null } } } },
      ],
    },
  },
  {
    key: 'paid',
    label: 'Won · paid / on terms',
    statusFilter: ['ACCEPTED', 'RESPONDED'],
    extraWhere: { order: { is: { status: { in: [...PAID_FAMILY] } } } },
  },
  {
    key: 'lost',
    label: 'Lost',
    extraWhere: {
      OR: [
        { status: { in: ['DECLINED', 'CLOSED'] } },
        { order: { is: { status: { in: ['CANCELED', 'REFUNDED'] } } }, status: 'ACCEPTED' },
      ],
    },
  },
  { key: 'all',      label: 'All',      statusFilter: undefined },
  // Open + Offer sent together: every live deal. The VIP/Urgent, My queue and
  // Unassigned chips count exactly this set, so they link here — linking to
  // Open hid the proforma'd deals they had counted.
  { key: 'active',   label: 'Open + waiting', statusFilter: ['PENDING', 'RESPONDED'], hidden: true },
];
// The statuses the signal chips count (= the 'active' tab).
const ACTIVE_STATUSES: QuoteStatus[] = ['PENDING', 'RESPONDED'];

const SORT_OPTIONS = [
  { key: 'urgency', label: 'Urgency' },
  { key: 'sla',     label: 'SLA · soonest' },
  { key: 'newest',  label: 'Newest' },
  { key: 'oldest',  label: 'Oldest' },
] as const satisfies ReadonlyArray<{ key: QueueSort; label: string }>;
type SortKey = QueueSort;
const PRIORITY_WEIGHT: Record<string, number> = { VIP: 0, URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
// The "VIP/Urgent" chip: one definition for its count and its list.
const HOT_PRIORITIES = ['VIP', 'URGENT'];
/** Rows per page of the queue. */
const PER_PAGE = 50;

export default async function AdminQuotesPage(
  props: {
    searchParams: Promise<{
      tab?: string; q?: string; prevq?: string; view?: string; assignee?: string; priority?: string; sort?: string; page?: string;
    }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireCapability('quotes:view');
  await ensureSettingsLoaded();
  const session = await getServerSession();
  const q = (searchParams.q ?? '').trim();
  // A search looks at every deal: a new search (another text than `prevq`,
  // the one shown) lists the matches of all tabs — a buyer's e-mail finds
  // their closed and won quotes too, a PRO- reference the accepted one. Each
  // tab shows how many matches it holds; clicking one narrows the search to
  // it. Re-sorting or Search with the same text stays on the tab.
  const tabKey = queueTab({ tab: searchParams.tab, q, prevq: searchParams.prevq }, TAB_STATUSES.map((t) => t.key));
  const tab = TAB_STATUSES.find((t) => t.key === tabKey) ?? TAB_STATUSES[0];
  // The tab the URL asked for and is shown — the form keeps it (a new search drops it).
  const urlTab = searchParams.tab === tab.key ? tab.key : '';
  const view = searchParams.view === 'archived' ? 'archived' : '';
  const assignee = searchParams.assignee ?? '';
  // One or more priorities, comma-separated (the VIP/Urgent chip sends both);
  // unknown values are ignored.
  const priorities = Array.from(new Set(
    (searchParams.priority ?? '')
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p in PRIORITY_WEIGHT),
  ));
  const priority = priorities.join(',');
  const sort: SortKey = (SORT_OPTIONS.find((s) => s.key === searchParams.sort)?.key ?? 'urgency') as SortKey;

  // The filters shared by every tab (the tab adds its own status scope).
  const filterWhere = (archived: boolean): Prisma.SourcingRequestWhereInput => ({
    ...(archived ? { archivedAt: { not: null } } : { archivedAt: null }),
    ...(assignee === 'me' && session?.user.id ? { assignedToId: session.user.id } : {}),
    ...(assignee === 'unassigned' ? { assignedToId: null } : {}),
    ...(priorities.length ? { priority: { in: priorities } } : {}),
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
            // The order and every document of the deal: order no., proforma
            // revisions, invoice, credit notes — what a bank line or a buyer quotes.
            {
              order: {
                is: {
                  OR: [
                    { orderNumber: { contains: q, mode: 'insensitive' as const } },
                    { proformaNumber: { contains: q, mode: 'insensitive' as const } },
                    { documents: { some: { number: { contains: q, mode: 'insensitive' as const } } } },
                  ],
                },
              },
            },
            // The list shows "RFQ-XXXXXX" (last 6 of the id) — make that searchable.
            ...(isQuoteRef(q) ? [{ id: { endsWith: q.slice(-6).toLowerCase() } }] : []),
          ],
        }
      : {}),
  });
  const tabWhere = (t: (typeof TAB_STATUSES)[number]): Prisma.SourcingRequestWhereInput => ({
    ...(t.statusFilter ? { status: { in: t.statusFilter } } : {}),
    ...(t.extraWhere ?? {}),
  });
  const where: Prisma.SourcingRequestWhereInput = { AND: [filterWhere(view === 'archived'), tabWhere(tab)] };

  // Pages of PER_PAGE over every match. Newest / oldest page in SQL; urgency
  // and SLA (priority + status weights) sort the light keys of every match,
  // then load the rows of one page — so page 3 is right however many there are.
  const include = {
    product: { select: { title: true } },
    assignedTo: { select: { id: true, name: true, email: true } },
    submittedBy: { select: { id: true } },
    messages: { select: { fromStaff: true, attachments: true, isInternalNote: true } },
  } satisfies Prisma.SourcingRequestInclude;
  const requestedPage = Number(searchParams.page ?? '1');
  let total: number;
  let pg: ReturnType<typeof queuePage>;
  let itemsRaw: Prisma.SourcingRequestGetPayload<{ include: typeof include }>[];
  if (sort === 'urgency' || sort === 'sla') {
    const keys = sortQueue(
      await prisma.sourcingRequest.findMany({ where, select: { id: true, priority: true, status: true, dueAt: true, createdAt: true } }),
      sort,
    );
    total = keys.length;
    pg = queuePage(total, requestedPage, PER_PAGE);
    const ids = keys.slice(pg.skip, pg.skip + PER_PAGE).map((k) => k.id);
    const rows = ids.length ? await prisma.sourcingRequest.findMany({ where: { id: { in: ids } }, include }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    itemsRaw = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  } else {
    total = await prisma.sourcingRequest.count({ where });
    pg = queuePage(total, requestedPage, PER_PAGE);
    itemsRaw = await prisma.sourcingRequest.findMany({
      where,
      orderBy: [{ createdAt: sort === 'oldest' ? 'asc' : 'desc' }, { id: 'asc' }],
      skip: pg.skip,
      take: PER_PAGE,
      include,
    });
  }

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
        select: { sourcingRequestId: true, status: true, paymentSubmittedAt: true, totalCents: true, currency: true, amountPaidCents: true, refunds: LIVE_REFUNDS_SELECT },
      })
    : [];
  const linkedByQuote = new Map<string, { status: string; proof: boolean; totalCents: number; partPaid: string | null }>();
  for (const lo of linkedOrders) {
    if (lo.sourcingRequestId) {
      linkedByQuote.set(lo.sourcingRequestId, {
        status: lo.status, proof: !!lo.paymentSubmittedAt, totalCents: lo.totalCents,
        partPaid: lo.status === 'PENDING_PAYMENT' ? partPaidLine(lo) : null,
      });
    }
  }
  const adminCandidates = await prisma.user.findMany({
    where: { OR: [{ role: 'ADMIN' }, { role: 'SELLER' }] },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
    take: 30,
  });

  const items = itemsRaw;
  const [canAssign, canArchive] = await Promise.all([hasCapability('quotes:assign'), hasCapability('quotes:archive')]);

  const [archivedCount, myCount, unassignedCount, urgentVipCount] = await Promise.all([
    prisma.sourcingRequest.count({ where: { archivedAt: { not: null } } }),
    session?.user.id
      ? prisma.sourcingRequest.count({ where: { archivedAt: null, assignedToId: session.user.id, status: { in: ACTIVE_STATUSES } } })
      : 0,
    prisma.sourcingRequest.count({ where: { archivedAt: null, assignedToId: null, status: { in: ACTIVE_STATUSES } } }),
    prisma.sourcingRequest.count({ where: { archivedAt: null, priority: { in: HOT_PRIORITIES }, status: { in: ACTIVE_STATUSES } } }),
  ]);
  // While searching, every tab (and Archived) shows how many of its deals
  // match, so a hit outside the tab being viewed is visible from it.
  const visibleTabs = TAB_STATUSES.filter((t) => !t.hidden || tab.key === t.key);
  const [tabMatchCounts, archivedMatchCount] = q
    ? await Promise.all([
        Promise.all(visibleTabs.map((t) => prisma.sourcingRequest.count({ where: { AND: [filterWhere(false), tabWhere(t)] } })))
          .then((counts) => new Map(visibleTabs.map((t, i) => [t.key, counts[i]]))),
        prisma.sourcingRequest.count({ where: filterWhere(true) }),
      ])
    : [null, null];

  // Any other change starts again at page 1; only the pager passes a page.
  function href(over: Partial<{ tab: string; view: string; assignee: string; priority: string; q: string; sort: string; page: number }>) {
    const sp = new URLSearchParams();
    const merged = {
      tab: over.tab !== undefined ? over.tab : urlTab,
      view: over.view !== undefined ? over.view : view,
      assignee: over.assignee !== undefined ? over.assignee : assignee,
      priority: over.priority !== undefined ? over.priority : priority,
      q: over.q !== undefined ? over.q : q,
      sort: over.sort !== undefined ? over.sort : (sort === 'urgency' ? '' : sort),
    };
    // 'open' is the default — except while searching, whose default is 'all'.
    if (merged.tab && (merged.tab !== 'open' || merged.q)) sp.set('tab', merged.tab);
    if (merged.view) sp.set('view', merged.view);
    if (merged.assignee) sp.set('assignee', merged.assignee);
    if (merged.priority) sp.set('priority', merged.priority);
    if (merged.q) sp.set('q', merged.q);
    if (merged.sort) sp.set('sort', merged.sort);
    if (over.page && over.page > 1) sp.set('page', String(over.page));
    return sp.toString() ? `/admin/quotes?${sp}` : '/admin/quotes';
  }
  const shownFrom = total === 0 ? 0 : pg.skip + 1;
  const shownTo = pg.skip + items.length;

  return (
    <div className="space-y-6">
      <AutoRefresh />

      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
            <FileText className="h-7 w-7 text-primary" /> Quote requests
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {`${total} request${total === 1 ? '' : 's'} ${view === 'archived' ? 'archived' : `· ${tab.label.toLowerCase()}`}${q ? ` · matching "${q}"` : ''}${pg.pages > 1 ? ` · ${shownFrom}–${shownTo} shown (page ${pg.page} of ${pg.pages})` : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs flex-wrap">
          {/* Each chip links to exactly the set it counts: live deals (Open +
              waiting, not archived) with that filter alone. */}
          <SignalChip label="VIP/Urgent" value={urgentVipCount} tone={urgentVipCount > 0 ? 'red' : 'neutral'} href={href({ tab: 'active', view: '', priority: HOT_PRIORITIES.join(','), assignee: '', q: '' })} />
          <SignalChip label="My queue" value={myCount} tone={myCount > 0 ? 'amber' : 'neutral'} href={href({ tab: 'active', view: '', assignee: 'me', priority: '', q: '' })} />
          <SignalChip label="Unassigned" value={unassignedCount} tone={unassignedCount > 0 ? 'amber' : 'neutral'} href={href({ tab: 'active', view: '', assignee: 'unassigned', priority: '', q: '' })} />
        </div>
      </div>

      {/* A new search starts across every tab (the text differs from prevq); the
          tab chips then narrow it. Re-sorting keeps the tab. */}
      <form method="GET" className="flex gap-2 flex-wrap items-center">
        {urlTab && <input type="hidden" name="tab" value={urlTab} />}
        <input type="hidden" name="prevq" value={q} />
        {view && <input type="hidden" name="view" value={view} />}
        {assignee && <input type="hidden" name="assignee" value={assignee} />}
        {priority && <input type="hidden" name="priority" value={priority} />}
        <input
          name="q"
          defaultValue={q}
          placeholder="Search buyer, email, item, RFQ- / PF- / INV- / L2D- ref…"
          className="flex-1 min-w-0 basis-[16rem] h-10 px-3 rounded-lg border border-input bg-background text-sm"
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
        {visibleTabs.map((t) => (
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
            {tabMatchCounts && <span className="opacity-60 tabular-nums"> {tabMatchCounts.get(t.key) ?? 0}</span>}
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
          Archived <span className="opacity-60 tabular-nums">{archivedMatchCount ?? archivedCount}</span>
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
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 font-semibold">
              Priority: {priorities.join(' / ')}
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
            const ref = sr.proformaNumber ?? QUOTE_REF(sr.id);
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
              validUntilISO: sr.validUntilAt?.toISOString() ?? null,
              offerTotalCents: (() => {
                const lo = linkedByQuote.get(sr.id);
                if (lo && lo.status !== 'CANCELED') return lo.totalCents;
                return sr.quotedPriceCents != null ? offerAmounts(sr).totalCents : null;
              })(),
              offerTotalExclVat: (() => {
                const lo = linkedByQuote.get(sr.id);
                if (lo && lo.status !== 'CANCELED') return false;
                return sr.quotedPriceCents != null && !offerAmounts(sr).vatDecided;
              })(),
              proposalPending: sr.sellerProposalStatus === 'PENDING',
              lostReason: sr.lostReason,
              archived: !!sr.archivedAt,
              isRegistered: !!sr.submittedBy,
              buyerPaidOrders: stats?.paidCount ?? 0,
              buyerLifetimeCents: stats?.lifetimeCents ?? 0,
              linkedOrderStatus: linkedByQuote.get(sr.id)?.status ?? null,
              linkedOrderProof: linkedByQuote.get(sr.id)?.proof ?? false,
              partPaidLabel: linkedByQuote.get(sr.id)?.partPaid ?? null,
              admins: adminCandidates,
              canAssign,
              canArchive,
            };
          })}
          view={view === 'archived' ? 'archived' : 'active'}
          canDelete={await hasCapability('quotes:delete')}
        />
      )}

      {pg.pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between gap-3 flex-wrap text-xs" data-testid="quotes-pager">
          <span className="text-muted-foreground tabular-nums">{shownFrom}–{shownTo} of {total}</span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {pg.page > 1 ? (
              <a href={href({ page: pg.page - 1 })} className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-border bg-card font-semibold hover:bg-foreground/5">
                <ChevronLeft className="h-3.5 w-3.5" /> Previous
              </a>
            ) : null}
            {Array.from({ length: pg.pages }, (_, i) => i + 1)
              .filter((n) => n === 1 || n === pg.pages || Math.abs(n - pg.page) <= 2)
              .map((n, i, arr) => (
                <span key={n} className="inline-flex items-center gap-1.5">
                  {i > 0 && n - arr[i - 1] > 1 && <span className="text-muted-foreground">…</span>}
                  <a
                    href={href({ page: n })}
                    aria-current={n === pg.page ? 'page' : undefined}
                    className={`inline-flex items-center justify-center h-8 min-w-8 px-2.5 rounded-full border font-semibold tabular-nums ${
                      n === pg.page ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border hover:bg-foreground/5'
                    }`}
                  >
                    {n}
                  </a>
                </span>
              ))}
            {pg.page < pg.pages ? (
              <a href={href({ page: pg.page + 1 })} className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-border bg-card font-semibold hover:bg-foreground/5">
                Next <ChevronRight className="h-3.5 w-3.5" />
              </a>
            ) : null}
          </div>
        </nav>
      )}
    </div>
  );
}

function SignalChip({
  label, value, tone, href,
}: { label: string; value: number; tone: 'red' | 'amber' | 'neutral'; href: string }) {
  const cls = tone === 'red'
    ? 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
    : tone === 'amber'
    ? 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800'
    : 'bg-card text-muted-foreground border-border';
  return (
    <a href={href} className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-xs font-semibold hover:opacity-90 ${cls}`}>
      <LifeBuoy className="h-3 w-3" />
      <span>{label}</span>
      <span className="tabular-nums font-bold">{value}</span>
    </a>
  );
}
