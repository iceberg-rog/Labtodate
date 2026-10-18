import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft, Sparkles, ShieldCheck, MessageCircle,
  Star, UserCircle2, Mail, Clock, Hourglass, Paperclip, Lock,
} from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { ARCHIVE_OUTCOME_LABEL, archiveOutcome, followUpMailto, getArchivedConversation, type ArchiveOutcome } from '@/lib/assistant/actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Chat transcript' };

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
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const OUTCOME_VIS: Record<ArchiveOutcome, { ring: string; pill: string }> = {
  unanswered: { ring: 'ring-amber-300 dark:ring-amber-800',     pill: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800' },
  team:       { ring: 'ring-emerald-200 dark:ring-emerald-800', pill: 'bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800' },
  ai:         { ring: 'ring-violet-200 dark:ring-violet-800',   pill: 'bg-violet-50 text-violet-900 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-800' },
  closed:     { ring: 'ring-ring', pill: 'bg-muted text-muted-foreground border-border' },
  ended:      { ring: 'ring-ring', pill: 'bg-muted text-muted-foreground border-border' },
};

type ArchivedMessage = { id: string; role: string; authorId: string | null; body: string; attachments: string[]; createdAt: Date };

/**
 * One transcript of the former on-site chat, read-only: no reply box, no
 * claim and no close — the chat was removed (support runs on tickets only).
 */
export default async function AdminChatTranscriptPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  await requireCapability('messages:view');

  const found = await getArchivedConversation(params.id);
  if (!found) notFound();
  const { conv, staffNames } = found;

  const outcome = archiveOutcome(conv);
  const vis = OUTCOME_VIS[outcome];
  const ref = `CHT-${conv.id.slice(-6).toUpperCase()}`;
  const customerName = conv.user?.name || conv.guestName || conv.guestEmail || 'Anonymous guest';
  const customerEmail = conv.user?.email || conv.guestEmail || null;
  const followUp = followUpMailto(customerEmail);
  const isGuest = !conv.user;
  const assignedTo = conv.assignedToId ? staffNames[conv.assignedToId] ?? 'a former team member' : null;
  const closedBy = conv.closedById ? staffNames[conv.closedById] ?? 'a former team member' : null;

  return (
    <div className="space-y-4">
      <Link href="/admin/messages" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" /> Back to chat archive
      </Link>

      {/* Hero */}
      <section className={`rounded-2xl border-2 bg-card overflow-hidden ${vis.ring} ring-1 ring-inset`}>
        <div className="p-6 grid lg:grid-cols-[1fr_auto] gap-6 items-start">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="font-mono text-[11px] text-muted-foreground">{ref}</span>
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${vis.pill}`}>
                {ARCHIVE_OUTCOME_LABEL[outcome]}
              </span>
              {isGuest && (
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-muted text-muted-foreground border border-border px-1.5 py-0.5">
                  guest
                </span>
              )}
              {conv.rating != null && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-bold rounded-full bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800 px-2 py-0.5">
                  <Star className="h-3 w-3 fill-amber-500 text-amber-500" /> Rated {conv.rating}/5
                </span>
              )}
            </div>
            <h1 className="text-xl font-bold tracking-tight">{conv.subject ?? 'Untitled conversation'}</h1>
            <p className="text-sm text-muted-foreground mt-1.5 inline-flex items-center gap-1.5 flex-wrap">
              <UserCircle2 className="h-3.5 w-3.5" />
              <strong className="text-foreground">{customerName}</strong>
              {customerEmail && (<>· <Mail className="h-3 w-3" /> {customerEmail}</>)}
              <span>·</span>
              <Clock className="h-3 w-3" /> started {smartDate(conv.startedAt)}
            </p>
          </div>
          {assignedTo && (
            <p className="text-xs text-muted-foreground lg:text-right lg:min-w-[200px]">
              Handled by <strong className="text-foreground">{assignedTo}</strong>
            </p>
          )}
        </div>
      </section>

      <div className="grid xl:grid-cols-[1fr_320px] gap-4 items-start">
        {/* TRANSCRIPT */}
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
            <MessageCircle className="h-3.5 w-3.5 text-primary" />
            <h2 className="text-xs font-bold uppercase tracking-wider">Transcript</h2>
            <span className="text-xs text-muted-foreground">{conv.messages.length} message{conv.messages.length === 1 ? '' : 's'}</span>
          </div>
          <div className="p-5 space-y-3 max-h-[660px] overflow-y-auto bg-foreground/[0.02]">
            {conv.messages.map((m) => (
              <Bubble key={m.id} m={m} customerName={customerName} staffName={m.authorId ? staffNames[m.authorId] : undefined} />
            ))}
            {conv.messages.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">This conversation has no messages.</p>
            )}
          </div>
          <div className="border-t border-border bg-card px-5 py-4 text-xs text-muted-foreground flex gap-2 items-start">
            <Lock className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <p>
              Read-only archive: the on-site chat is switched off, so this conversation cannot be continued.{' '}
              {followUp ? (
                <>To follow up, e-mail <a href={followUp} className="underline">{customerEmail}</a>.</>
              ) : (
                'The customer left no valid e-mail address.'
              )}
            </p>
          </div>
        </section>

        {/* SIDEBAR */}
        <aside className="space-y-3 xl:sticky xl:top-20 xl:self-start">
          <SidebarCard title="Customer" icon={<UserCircle2 className="h-3.5 w-3.5 text-primary" />}>
            <div className="space-y-2 text-sm">
              <p className="font-semibold">{customerName}</p>
              {customerEmail && <p className="text-xs"><Mail className="h-3 w-3 inline mr-1" />{customerEmail}</p>}
              <p className="text-xs text-muted-foreground">
                {isGuest ? 'Guest without an account' : 'Signed-in account'}
              </p>
              {conv.user && (
                <p className="text-xs">
                  <span className="text-muted-foreground">Member since · </span>{smartDate(conv.user.createdAt)}
                </p>
              )}
            </div>
          </SidebarCard>

          <SidebarCard title="Timeline" icon={<Hourglass className="h-3.5 w-3.5 text-primary" />}>
            <ul className="text-xs space-y-1.5">
              <li><strong>Started</strong> · {smartDate(conv.startedAt)}</li>
              <li><strong>Last message</strong> · {smartDate(conv.lastMessageAt)}</li>
              {conv.closedAt && <li><strong>Closed</strong> · {smartDate(conv.closedAt)}{closedBy ? ` by ${closedBy}` : ''}</li>}
              {conv.ratedAt && <li><strong>Rated</strong> · {smartDate(conv.ratedAt)} ({conv.rating}/5)</li>}
              <li><strong>Messages</strong> · {conv.messages.length}</li>
            </ul>
          </SidebarCard>

          {conv.ratingNote && (
            <SidebarCard title="Customer feedback" icon={<Star className="h-3.5 w-3.5 text-amber-500" />}>
              <p className="text-xs italic">&ldquo;{conv.ratingNote}&rdquo;</p>
            </SidebarCard>
          )}

          <p className="text-[10px] font-mono text-muted-foreground px-3">id: {conv.id}</p>
        </aside>
      </div>
    </div>
  );
}

function Bubble({ m, customerName, staffName }: { m: ArchivedMessage; customerName: string; staffName?: string }) {
  if (m.role === 'system') {
    return (
      <div className="flex items-center gap-3 my-2">
        <div className="flex-1 h-px bg-border" />
        <p className="text-[11px] text-muted-foreground font-medium">{m.body}</p>
        <div className="flex-1 h-px bg-border" />
      </div>
    );
  }
  const isUser = m.role === 'user';
  const isAdmin = m.role === 'admin';
  return (
    <div className={`flex gap-2.5 ${isAdmin ? 'flex-row-reverse' : ''}`}>
      <div className={`h-8 w-8 rounded-full inline-flex items-center justify-center text-[11px] font-bold flex-shrink-0 shadow-sm ${
        isAdmin
          ? 'bg-primary text-primary-foreground'
          : isUser
          ? 'bg-muted text-muted-foreground border border-border'
          : 'bg-violet-100 text-violet-800 border border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800'
      }`}>
        {isAdmin ? <ShieldCheck className="h-3.5 w-3.5" /> : isUser ? customerName.charAt(0).toUpperCase() : <Sparkles className="h-3.5 w-3.5" />}
      </div>
      <div className={`flex flex-col gap-1 max-w-[80%] ${isAdmin ? 'items-end' : 'items-start'}`}>
        <div className={`text-[11px] font-semibold inline-flex items-center gap-2 ${isAdmin ? 'flex-row-reverse' : ''}`}>
          <span>{isAdmin ? staffName ?? 'Team' : isUser ? customerName : 'AI'}</span>
          <span className="text-muted-foreground font-normal">
            {m.createdAt.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })}
          </span>
        </div>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
          isAdmin
            ? 'bg-primary text-primary-foreground rounded-tr-sm'
            : isUser
            ? 'bg-card border border-border rounded-tl-sm'
            : 'bg-violet-50 border border-violet-200 dark:bg-violet-950/40 dark:border-violet-800 rounded-tl-sm'
        }`}>
          {m.body}
          {m.attachments.length > 0 && (
            <div className="mt-2 flex gap-2 flex-wrap">
              {m.attachments.map((url) => (
                /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) ? (
                  <a key={url} href={url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated attachment proxy, not optimisable */}
                    <img src={url} alt="" className="h-20 w-20 rounded-md object-cover border border-border" />
                  </a>
                ) : (
                  <a key={url} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] underline">
                    <Paperclip className="h-3 w-3" /> attachment
                  </a>
                )
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SidebarCard({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-2 inline-flex items-center gap-1">
        {icon}{title}
      </p>
      {children}
    </div>
  );
}
