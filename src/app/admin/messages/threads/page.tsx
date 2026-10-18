import Link from 'next/link';
import { ArrowRight, Clock, EyeOff, Inbox, MessageCircle, MessageSquare, ShieldAlert, Hourglass, Ticket } from 'lucide-react';
import { Prisma } from '@prisma/client';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingEnum } from '@/lib/settings';
import { settingDef } from '@/lib/settings/defs';
import { siteName } from '@/lib/brand/identity';
import { AdminSearch, AdminPager } from '@/components/admin/AdminListControls';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { CONTACT_REMOVED, HELD_PREFIX, WITHHELD_PREFIX, deliveryState, mediationMode, messageText } from '@/lib/messages/mediation';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Buyer-supplier threads' };

const PAGE_SIZE = 50;

/**
 * Every buyer ↔ supplier “Message seller” conversation, for the team that
 * mediates them: held supplier messages (Staff review mode), conversations
 * where contact details were removed, ones the supplier has not answered,
 * and a filter per supplier. Staff reply and release on the thread page.
 */
const VIEWS = [
  { key: 'all', label: 'All', Icon: Inbox },
  { key: 'held', label: 'Waiting for release', Icon: Hourglass },
  { key: 'masked', label: 'Contact details removed', Icon: ShieldAlert },
  { key: 'unanswered', label: 'Unanswered', Icon: Clock },
] as const;
type ViewKey = (typeof VIEWS)[number]['key'];

/** Threads whose latest message (withheld ones aside) is the buyer's: the supplier or staff still owe a reply. */
async function unansweredThreadIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT t."id" FROM "MessageThread" t
    JOIN LATERAL (
      SELECT m."authorId" FROM "Message" m
      WHERE m."threadId" = t."id" AND m."body" NOT LIKE ${`${WITHHELD_PREFIX}%`}
      ORDER BY m."createdAt" DESC LIMIT 1
    ) last ON true
    WHERE last."authorId" = t."buyerId"`);
  return rows.map((r) => r.id);
}

function viewWhere(view: ViewKey, unanswered: string[]): Prisma.MessageThreadWhereInput {
  if (view === 'held') return { messages: { some: { body: { startsWith: HELD_PREFIX } } } };
  if (view === 'masked') return { messages: { some: { body: { contains: CONTACT_REMOVED } } } };
  if (view === 'unanswered') return { id: { in: unanswered } };
  return {};
}

function smartDate(d: Date): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  const days = Math.floor(mins / (24 * 60));
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default async function AdminThreadsPage(props: {
  searchParams: Promise<{ view?: string; supplier?: string; q?: string; page?: string }>;
}) {
  const searchParams = await props.searchParams;
  await requireCapability('messages:view');
  await ensureSettingsLoaded();
  const site = siteName();
  const view: ViewKey = VIEWS.find((v) => v.key === searchParams.view)?.key ?? 'all';
  const supplier = (searchParams.supplier ?? '').trim().slice(0, 64);
  const q = (searchParams.q ?? '').trim().slice(0, 120);
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const mode = mediationMode(settingEnum('MESSAGE_MEDIATION_MODE'));
  const modeLabel = settingDef('MESSAGE_MEDIATION_MODE')?.options?.find((o) => o.value === mode)?.label ?? mode;

  const ci = { contains: q, mode: 'insensitive' as const };
  const base: Prisma.MessageThreadWhereInput = {
    ...(supplier ? { sellerId: supplier } : {}),
    ...(q
      ? {
          OR: [
            { subject: ci },
            { product: { title: ci } },
            { buyer: { OR: [{ name: ci }, { email: ci }] } },
            { seller: { OR: [{ name: ci }, { email: ci }] } },
            { messages: { some: { body: ci } } },
          ],
        }
      : {}),
  };

  const unanswered = await unansweredThreadIds();
  const counts: Record<string, number> = {};
  for (const v of VIEWS) counts[v.key] = await prisma.messageThread.count({ where: { AND: [base, viewWhere(v.key, unanswered)] } });
  const where: Prisma.MessageThreadWhereInput = { AND: [base, viewWhere(view, unanswered)] };

  const [total, threads, suppliersRaw] = await Promise.all([
    prisma.messageThread.count({ where }),
    prisma.messageThread.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, subject: true, lastMessageAt: true, buyerId: true, sellerId: true,
        buyer: { select: { name: true, email: true } },
        seller: { select: { name: true, email: true, role: true, company: { select: { name: true } } } },
        product: { select: { title: true } },
        _count: { select: { messages: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, authorId: true } },
      },
    }),
    prisma.messageThread.groupBy({ by: ['sellerId'], _count: { _all: true } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const ids = threads.map((t) => t.id);

  const [heldBy, maskedBy, movedRows, supplierUsers] = await Promise.all([
    prisma.message.groupBy({ by: ['threadId'], where: { threadId: { in: ids }, body: { startsWith: HELD_PREFIX } }, _count: { _all: true } }),
    prisma.message.groupBy({ by: ['threadId'], where: { threadId: { in: ids }, body: { contains: CONTACT_REMOVED } }, _count: { _all: true } }),
    prisma.auditLog.findMany({ where: { action: 'message.thread_to_ticket', target: { in: ids } }, select: { target: true, meta: true } }),
    prisma.user.findMany({
      where: { id: { in: suppliersRaw.map((s) => s.sellerId) } },
      select: { id: true, name: true, email: true, company: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  const held = new Map(heldBy.map((r) => [r.threadId, r._count._all]));
  const masked = new Map(maskedBy.map((r) => [r.threadId, r._count._all]));
  const moved = new Map<string, string>();
  for (const r of movedRows) {
    try {
      const ref = (JSON.parse(r.meta ?? '') as { ref?: unknown }).ref;
      if (r.target && typeof ref === 'string') moved.set(r.target, ref);
    } catch {
      /* unreadable row — no badge */
    }
  }
  const unansweredSet = new Set(unanswered);
  const filterParams = { view: view !== 'all' ? view : undefined, supplier: supplier || undefined };
  const tabHref = (key: ViewKey) => {
    const sp = new URLSearchParams();
    if (key !== 'all') sp.set('view', key);
    if (supplier) sp.set('supplier', supplier);
    if (q) sp.set('q', q);
    const s = sp.toString();
    return s ? `/admin/messages/threads?${s}` : '/admin/messages/threads';
  };

  return (
    <div className="space-y-5">
      <AutoRefresh />
      <div>
        <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <MessageCircle className="h-6 w-6 text-primary" /> Buyer-supplier threads
        </h1>
        <p className="text-muted-foreground mt-1">
          “Message seller” conversations on supplier listings. {total} {total === 1 ? 'conversation' : 'conversations'}
          {q ? ` matching “${q}”` : ''}{totalPages > 1 ? ` · page ${page}/${totalPages}` : ''}
        </p>
        <p className="text-xs text-muted-foreground mt-2 max-w-3xl">
          Participants see each other only as “{site} Supplier” / “{site} Buyer”; replies from here show as “{site} team”.
          Mediation: <strong className="text-foreground">{modeLabel}</strong> —{' '}
          <Link href="/admin/settings?tab=Suppliers" className="text-primary hover:underline">Settings → Suppliers</Link>.
          Questions about your own stock are support tickets, not threads.
        </p>
      </div>

      <AdminSearch basePath="/admin/messages/threads" q={q} params={filterParams} placeholder="Search product, buyer, supplier, message…" />

      <div className="flex gap-2 flex-wrap items-center">
        {VIEWS.map((v) => {
          const active = v.key === view;
          const VIcon = v.Icon;
          return (
            <Link
              key={v.key}
              href={tabHref(v.key)}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold transition ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <VIcon className="h-3.5 w-3.5" />
              {v.label}
              <span className={`tabular-nums ${active ? 'opacity-80' : 'opacity-60'}`}>{counts[v.key] ?? 0}</span>
            </Link>
          );
        })}
        <form method="GET" className="flex items-center gap-2 ml-auto">
          {view !== 'all' && <input type="hidden" name="view" value={view} />}
          {q && <input type="hidden" name="q" value={q} />}
          <label htmlFor="supplier-filter" className="text-xs text-muted-foreground">Supplier</label>
          <select
            id="supplier-filter"
            name="supplier"
            defaultValue={supplier}
            className="h-8 rounded-full border border-border bg-card px-3 text-xs max-w-[16rem]"
          >
            <option value="">All suppliers</option>
            {supplierUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.company?.name ? `${u.company.name} — ` : ''}{u.name || u.email}
              </option>
            ))}
          </select>
          <button type="submit" className="h-8 px-3 rounded-full text-xs font-semibold bg-foreground/5 hover:bg-foreground/10">Apply</button>
        </form>
      </div>

      {threads.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-bold">Nothing here</p>
          <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
            {view === 'held'
              ? 'No supplier message is waiting for release.'
              : 'When a buyer uses “Message seller” on a supplier listing, the conversation shows up here.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {threads.map((t) => {
            const last = t.messages[0];
            const lastWho = !last ? '' : last.authorId === t.buyerId ? 'Buyer: ' : last.authorId === t.sellerId ? 'Supplier: ' : 'Staff: ';
            const lastState = last ? deliveryState(last.body) : 'DELIVERED';
            const heldCount = held.get(t.id) ?? 0;
            const maskedCount = masked.get(t.id) ?? 0;
            const movedRef = moved.get(t.id);
            return (
              <li key={t.id} className="rounded-2xl border border-border bg-card overflow-hidden">
                <Link href={`/admin/messages/threads/${t.id}`} className="block hover:bg-foreground/[0.02]">
                  <div className="px-5 py-4 grid grid-cols-[minmax(0,1fr)_auto] gap-4 items-start">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">MSG-{t.id.slice(-6).toUpperCase()}</span>
                        {heldCount > 0 && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800">
                            <Hourglass className="h-3 w-3" /> {heldCount} waiting for release
                          </span>
                        )}
                        {maskedCount > 0 && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800">
                            <EyeOff className="h-3 w-3" /> contact details removed ×{maskedCount}
                          </span>
                        )}
                        {unansweredSet.has(t.id) && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-muted text-muted-foreground border-border">
                            <Clock className="h-3 w-3" /> unanswered
                          </span>
                        )}
                        {movedRef && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-sky-50 text-sky-900 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800">
                            <Ticket className="h-3 w-3" /> moved to {movedRef}
                          </span>
                        )}
                      </div>
                      <h3 className="font-bold text-[15px] leading-tight truncate">{t.product?.title ?? t.subject ?? 'Conversation'}</h3>
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        {last ? (
                          <>
                            <span className="font-medium text-foreground">{lastWho}</span>
                            {messageText(last.body).slice(0, 140)}
                            {lastState === 'HELD' ? ' (waiting for release)' : lastState === 'WITHHELD' ? ' (not delivered)' : ''}
                          </>
                        ) : '—'}
                      </p>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1.5 flex-wrap">
                        <span>
                          Buyer <strong className="text-foreground">{t.buyer.name || t.buyer.email}</strong>
                        </span>
                        <span>
                          Supplier <strong className="text-foreground">{t.seller.company?.name || t.seller.name || t.seller.email}</strong>
                          {t.seller.role === 'ADMIN' ? ' (staff account)' : ''}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <MessageSquare className="h-3 w-3" /> {t._count.messages}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {smartDate(t.lastMessageAt)}
                        </span>
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-1" />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <AdminPager basePath="/admin/messages/threads" page={page} totalPages={totalPages} total={total} q={q} params={filterParams} />
    </div>
  );
}
