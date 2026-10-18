import Link from 'next/link';
import { MessageSquare, Inbox, Headphones, Sparkles, Archive, ArrowRight, Star, Clock, ShieldCheck, UserCircle2, Lock } from 'lucide-react';
import { hasCapability, requireCapability } from '@/lib/auth-server';
import { AdminSearch, AdminPager } from '@/components/admin/AdminListControls';
import {
  ARCHIVE_FILTERS, ARCHIVE_OUTCOME_LABEL, ARCHIVE_PAGE_SIZE, archiveCounts, archiveFilterOf, archiveOutcome, archiveSummary, listArchive,
  type ArchiveFilter, type ArchiveOutcome,
} from '@/lib/assistant/actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Chat archive' };

/**
 * Chat archive: the transcripts of the former on-site chat, read-only. The
 * chat was removed (support runs on tickets only), so nothing on this page or
 * the transcript page can answer, claim or close a conversation.
 */
const FILTER_ICON: Record<ArchiveFilter, React.ComponentType<{ className?: string }>> = {
  all: Inbox,
  unanswered: Headphones,
  team: ShieldCheck,
  ai: Sparkles,
  closed: Archive,
};

const OUTCOME_VIS: Record<ArchiveOutcome, { stripe: string; pill: string }> = {
  unanswered: { stripe: 'before:bg-amber-500',   pill: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800' },
  team:       { stripe: 'before:bg-emerald-500', pill: 'bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800' },
  ai:         { stripe: 'before:bg-violet-400',  pill: 'bg-violet-50 text-violet-900 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-800' },
  closed:     { stripe: 'before:bg-slate-400',   pill: 'bg-muted text-muted-foreground border-border' },
  ended:      { stripe: 'before:bg-slate-300',   pill: 'bg-muted text-muted-foreground border-border' },
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
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default async function AdminChatArchivePage(
  props: {
    searchParams: Promise<{ tab?: string; q?: string; page?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireCapability('messages:view');
  const filter = archiveFilterOf(searchParams.tab);
  const filterLabel = ARCHIVE_FILTERS.find((f) => f.key === filter)?.label ?? 'All';
  const q = (searchParams.q ?? '').trim();
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);

  const [counts, { total, rows }, canTickets] = await Promise.all([archiveCounts(), listArchive({ filter, q, page }), hasCapability('tickets:view')]);
  const totalPages = Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Chat archive</h1>
        <p className="text-muted-foreground mt-1">
          Transcripts of the former on-site chat. {total} {total === 1 ? 'conversation' : 'conversations'} · {filterLabel.toLowerCase()}
          {q ? ` · matching "${q}"` : ''}
          {totalPages > 1 ? ` · page ${page}/${totalPages}` : ''}
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-foreground/[0.02] p-4 text-sm text-muted-foreground flex gap-3 items-start">
        <Lock className="h-4 w-4 mt-0.5 flex-shrink-0 text-foreground" />
        <p>
          <strong className="text-foreground">Read-only.</strong> The on-site chat is switched off — customers contact you
          through {canTickets ? <Link href="/admin/tickets" className="underline">support tickets</Link> : 'support tickets'}. These transcripts cannot be
          answered, claimed or closed; to follow up, e-mail the customer where a transcript shows a valid address.
        </p>
      </div>

      <SummaryStrip />

      <AdminSearch
        basePath="/admin/messages"
        q={q}
        params={{ tab: filter !== 'all' ? filter : undefined }}
        placeholder="Search subject, customer name, email, message…"
      />

      <div className="flex gap-2 flex-wrap">
        {ARCHIVE_FILTERS.map((f) => {
          const active = f.key === filter;
          const FIcon = FILTER_ICON[f.key];
          return (
            <Link
              key={f.key}
              href={f.key === 'all' ? '/admin/messages' : `/admin/messages?tab=${f.key}`}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold transition ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <FIcon className="h-3.5 w-3.5" />
              {f.label}
              <span className={`tabular-nums ${active ? 'opacity-80' : 'opacity-60'}`}>{counts[f.key] ?? 0}</span>
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary inline-flex items-center justify-center mb-4">
            <MessageSquare className="h-7 w-7" />
          </div>
          <p className="text-lg font-bold">{q || filter !== 'all' ? 'No matching transcripts' : 'No chat transcripts'}</p>
          <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
            {q || filter !== 'all'
              ? 'Try another filter or search.'
              : 'There are no transcripts from the former on-site chat. New customer questions arrive as support tickets.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((c) => {
            const outcome = archiveOutcome(c);
            const vis = OUTCOME_VIS[outcome];
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
                          {ARCHIVE_OUTCOME_LABEL[outcome]}
                        </span>
                        {isGuest && (
                          <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-muted text-muted-foreground border border-border px-1.5 py-0.5">
                            guest
                          </span>
                        )}
                        {c.rating != null && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-bold rounded-full bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800 px-1.5 py-0.5">
                            <Star className="h-3 w-3 fill-amber-500 text-amber-500" /> {c.rating}/5
                          </span>
                        )}
                      </div>
                      <h3 className="font-bold text-[15px] leading-tight truncate">{c.subject ?? 'Untitled conversation'}</h3>
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        {last ? (
                          <>
                            <span className="font-medium text-foreground">{last.role === 'user' ? 'Customer: ' : last.role === 'admin' ? 'Team: ' : last.role === 'assistant' ? 'AI: ' : ''}</span>
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
                          <Clock className="h-3 w-3" /> last message {smartDate(c.lastMessageAt)}
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

      <AdminPager basePath="/admin/messages" page={page} totalPages={totalPages} total={total} q={q} tab={filter !== 'all' ? filter : undefined} />
    </div>
  );
}

/** Archive totals: conversations, unanswered requests, team-answered, ratings, last chat. */
async function SummaryStrip() {
  const s = await archiveSummary();
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      <StatCell label="Conversations" value={s.total.toString()} hint={s.firstAt ? `since ${smartDate(s.firstAt)}` : 'none'} />
      <StatCell label="Unanswered" value={s.unanswered.toString()} hint="asked for a person" tone={s.unanswered > 0 ? 'amber' : 'default'} />
      <StatCell label="Answered by the team" value={s.team.toString()} hint={s.team === 1 ? 'conversation' : 'conversations'} />
      <StatCell label="Avg rating" value={s.avgRating ? `${s.avgRating.toFixed(1)} / 5` : '—'} hint={`${s.rated} rated`} />
      <StatCell label="Last chat" value={s.lastAt ? smartDate(s.lastAt) : '—'} hint="last message" />
    </div>
  );
}

function StatCell({ label, value, hint, tone = 'default' }: { label: string; value: string; hint?: string; tone?: 'default' | 'amber' }) {
  const palette: Record<string, string> = {
    default: 'bg-card border-border',
    amber: 'bg-amber-50/60 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800',
  };
  return (
    <div className={`rounded-2xl border p-4 ${palette[tone]}`}>
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums mt-1">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}
