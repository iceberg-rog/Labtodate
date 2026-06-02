import Link from 'next/link';
import {
  MessageSquare, Inbox, Headphones, Sparkles, CheckCheck, Archive,
  ArrowRight, Star, Clock, ShieldCheck, UserCircle2,
} from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { AdminSearch, AdminPager } from '@/components/admin/AdminListControls';
import { AutoRefresh } from '@/components/util/AutoRefresh';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/**
 * Tabs split the queue by lifecycle stage. "Awaiting human" is the most
 * urgent — someone is sitting in the widget waiting for an operator.
 * "With me" filters to conversations the current admin claimed. Closed
 * groups CLOSED + ARCHIVED so historical conversations stay reachable.
 */
const TAB_DEFS: Array<{
  key: string;
  label: string;
  statusFilter?: string[];
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: 'awaiting', label: 'Awaiting human',  statusFilter: ['AWAITING_HUMAN'], Icon: Headphones },
  { key: 'with_me',  label: 'With me',         statusFilter: ['WITH_HUMAN'], Icon: ShieldCheck },
  { key: 'ai',       label: 'AI handling',     statusFilter: ['AI'], Icon: Sparkles },
  { key: 'closed',   label: 'Closed',          statusFilter: ['CLOSED', 'ARCHIVED'], Icon: Archive },
  { key: 'all',      label: 'All',             statusFilter: undefined, Icon: Inbox },
];

const STATUS_VIS: Record<string, { stripe: string; pill: string; label: string }> = {
  AI:               { stripe: 'before:bg-violet-400',  pill: 'bg-violet-50 text-violet-900 border-violet-200',     label: 'AI handling' },
  AWAITING_HUMAN:   { stripe: 'before:bg-amber-500',   pill: 'bg-amber-100 text-amber-900 border-amber-200',       label: 'Waiting for you' },
  WITH_HUMAN:       { stripe: 'before:bg-emerald-500', pill: 'bg-emerald-50 text-emerald-900 border-emerald-200',  label: 'Live · with human' },
  CLOSED:           { stripe: 'before:bg-slate-400',   pill: 'bg-slate-100 text-slate-700 border-slate-200',       label: 'Closed' },
  ARCHIVED:         { stripe: 'before:bg-slate-300',   pill: 'bg-slate-50 text-slate-600 border-slate-200',        label: 'Archived' },
};

function smartDate(d: Date | null | undefined): string {
  if (!d) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400e3);
  if (days === 0) {
    const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  }
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default async function AdminMessagesPage(
  props: {
    searchParams: Promise<{ tab?: string; q?: string; page?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireCapability('messages:view');
  const tab = TAB_DEFS.find((t) => t.key === searchParams.tab) ?? TAB_DEFS[0];
  const q = (searchParams.q ?? '').trim();
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);

  const where: Prisma.AssistantConversationWhereInput = {
    ...(tab.statusFilter ? { status: { in: tab.statusFilter } } : {}),
    ...(q
      ? {
          OR: [
            { subject: { contains: q, mode: 'insensitive' as const } },
            { guestName: { contains: q, mode: 'insensitive' as const } },
            { guestEmail: { contains: q, mode: 'insensitive' as const } },
            { user: { name: { contains: q, mode: 'insensitive' as const } } },
            { user: { email: { contains: q, mode: 'insensitive' as const } } },
            { messages: { some: { body: { contains: q, mode: 'insensitive' as const } } } },
          ],
        }
      : {}),
  };

  const counts: Record<string, number> = {};
  for (const t of TAB_DEFS) {
    counts[t.key] = await prisma.assistantConversation.count({
      where: { ...(t.statusFilter ? { status: { in: t.statusFilter } } : {}) },
    });
  }

  const [total, convs] = await Promise.all([
    prisma.assistantConversation.count({ where }),
    prisma.assistantConversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, status: true, subject: true, rating: true,
        guestName: true, guestEmail: true, assignedToId: true,
        user: { select: { name: true, email: true } },
        startedAt: true, lastMessageAt: true,
        _count: { select: { messages: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { role: true, body: true },
        },
      },
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <AutoRefresh />
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Messages</h1>
        <p className="text-muted-foreground mt-1">
          Customer chats — AI assistant + human handoff. {total} {total === 1 ? 'conversation' : 'conversations'} · {tab.label.toLowerCase()}
          {q ? ` · matching "${q}"` : ''}
          {totalPages > 1 ? ` · page ${page}/${totalPages}` : ''}
        </p>
      </div>

      {/* At-a-glance analytics — total, escalation rate, avg rating, today */}
      <AnalyticsStrip />

      <AdminSearch basePath="/admin/messages" q={q} placeholder="Search subject, customer name, email, message…" />

      <div className="flex gap-2 flex-wrap">
        {TAB_DEFS.map((t) => {
          const active = t.key === tab.key;
          const TIcon = t.Icon;
          return (
            <Link
              key={t.key}
              href={t.key === 'awaiting' ? '/admin/messages' : `/admin/messages?tab=${t.key}`}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold transition ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <TIcon className="h-3.5 w-3.5" />
              {t.label}
              <span className={`tabular-nums ${active ? 'opacity-80' : 'opacity-60'}`}>{counts[t.key] ?? 0}</span>
            </Link>
          );
        })}
      </div>

      {convs.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary inline-flex items-center justify-center mb-4">
            <MessageSquare className="h-7 w-7" />
          </div>
          <p className="text-lg font-bold">Nothing here</p>
          <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
            Customer chats from the floating <strong>lab2date Assistant</strong> on the public site land here.
            The AI answers within site scope; if a user requests a human, they jump into <em>Awaiting human</em>.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {convs.map((c) => {
            const vis = STATUS_VIS[c.status] ?? STATUS_VIS.AI;
            const last = c.messages[0];
            const customerName = c.user?.name || c.guestName || (c.guestEmail ?? 'Anonymous guest');
            const customerEmail = c.user?.email || c.guestEmail || null;
            const isGuest = !c.user;
            const ref = `CHT-${c.id.slice(-6).toUpperCase()}`;

            return (
              <li
                key={c.id}
                className={`relative rounded-2xl border border-border bg-card overflow-hidden transition-shadow hover:shadow-[0_10px_30px_-15px_rgba(15,79,64,0.25)]
                  before:content-[''] before:absolute before:inset-y-0 before:left-0 before:w-1 ${vis.stripe}`}
              >
                <Link href={`/admin/messages/${c.id}`} className="block hover:bg-foreground/[0.02]">
                  <div className="pl-5 pr-5 py-4 grid grid-cols-[minmax(0,1fr)_auto] gap-4 items-start">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{ref}</span>
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${vis.pill}`}>
                          {vis.label}
                        </span>
                        {isGuest && (
                          <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0.5">
                            guest
                          </span>
                        )}
                        {c.rating != null && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-bold rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5">
                            <Star className="h-3 w-3 fill-amber-500 text-amber-500" /> {c.rating}/5
                          </span>
                        )}
                      </div>
                      <h3 className="font-bold text-[15px] leading-tight truncate">{c.subject ?? 'New conversation'}</h3>
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        {last ? (
                          <>
                            <span className="font-medium text-foreground">{last.role === 'user' ? 'Them: ' : last.role === 'admin' ? 'Admin: ' : last.role === 'assistant' ? 'AI: ' : ''}</span>
                            {last.body.slice(0, 120)}
                          </>
                        ) : '—'}
                      </p>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1.5 flex-wrap">
                        <span className="inline-flex items-center gap-1">
                          <UserCircle2 className="h-3 w-3" />
                          <strong className="text-foreground">{customerName}</strong>
                          {customerEmail && <span className="ml-1">· {customerEmail}</span>}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <MessageSquare className="h-3 w-3" /> {c._count.messages} msg{c._count.messages === 1 ? '' : 's'}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {smartDate(c.lastMessageAt)}
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

      <AdminPager basePath="/admin/messages" page={page} totalPages={totalPages} total={total} q={q} tab={tab.key !== 'awaiting' ? tab.key : undefined} />
    </div>
  );
}

/**
 * At-a-glance analytics. Cheap aggregate queries — RSC, runs once per page
 * render. 5 cells: active right now, new today, all-time total, escalation
 * rate (% of conversations that reached a human), avg rating across rated
 * conversations.
 */
async function AnalyticsStrip() {
  const since24h = new Date(Date.now() - 24 * 3600_000);
  const [total, last24h, active, escalated, agg] = await Promise.all([
    prisma.assistantConversation.count(),
    prisma.assistantConversation.count({ where: { startedAt: { gte: since24h } } }),
    prisma.assistantConversation.count({ where: { status: { in: ['AI', 'AWAITING_HUMAN', 'WITH_HUMAN'] } } }),
    prisma.assistantConversation.count({ where: { assignedToId: { not: null } } }),
    prisma.assistantConversation.aggregate({ _avg: { rating: true }, _count: { rating: true }, where: { rating: { not: null } } }),
  ]);
  const escRate = total > 0 ? Math.round((escalated / total) * 100) : 0;
  const avgRating = agg._avg.rating ?? null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      <StatCell label="Active now" value={active.toString()} hint={active === 1 ? 'conversation' : 'conversations'} tone="emerald" />
      <StatCell label="New today" value={last24h.toString()} hint="last 24 hours" tone="sky" />
      <StatCell label="All-time" value={total.toString()} hint="conversations" />
      <StatCell label="Escalation rate" value={`${escRate}%`} hint="reached human" tone={escRate > 60 ? 'amber' : 'default'} />
      <StatCell label="Avg rating" value={avgRating ? `${avgRating.toFixed(1)} / 5` : '—'} hint={`${agg._count.rating} rated`} tone={avgRating && avgRating >= 4 ? 'emerald' : avgRating && avgRating < 3 ? 'red' : 'default'} />
    </div>
  );
}

function StatCell({ label, value, hint, tone = 'default' }: { label: string; value: string; hint?: string; tone?: 'default' | 'emerald' | 'sky' | 'amber' | 'red' }) {
  const palette: Record<string, string> = {
    default: 'bg-card border-border',
    emerald: 'bg-emerald-50/60 border-emerald-200',
    sky: 'bg-sky-50/60 border-sky-200',
    amber: 'bg-amber-50/60 border-amber-200',
    red: 'bg-red-50/60 border-red-200',
  };
  return (
    <div className={`rounded-2xl border p-4 ${palette[tone]}`}>
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums mt-1">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}
