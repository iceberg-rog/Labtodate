import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft, Sparkles, Headphones, ShieldCheck, MessageCircle,
  CheckCheck, Star, UserCircle2, Mail, Clock, Hourglass, Paperclip,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireCapability, getServerSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import {
  adminClaimConversation,
  adminReplyConversation,
  adminCloseConversation,
} from '@/lib/assistant/actions';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { ReplyForm } from '@/components/util/ReplyForm';

export const dynamic = 'force-dynamic';

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
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_VIS: Record<string, { ring: string; pill: string; label: string }> = {
  AI:             { ring: 'ring-violet-200',  pill: 'bg-violet-50 text-violet-900 border-violet-200',     label: 'AI handling' },
  AWAITING_HUMAN: { ring: 'ring-amber-300',   pill: 'bg-amber-100 text-amber-900 border-amber-200',       label: 'Waiting for you' },
  WITH_HUMAN:     { ring: 'ring-emerald-200', pill: 'bg-emerald-50 text-emerald-900 border-emerald-200',  label: 'Live · with human' },
  CLOSED:         { ring: 'ring-slate-200',   pill: 'bg-slate-100 text-slate-700 border-slate-200',       label: 'Closed' },
  ARCHIVED:       { ring: 'ring-slate-200',   pill: 'bg-slate-50 text-slate-600 border-slate-200',        label: 'Archived' },
};

export default async function AdminConversationDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  await requireCapability('messages:view');
  const session = await getServerSession();

  const conv = await prisma.assistantConversation.findUnique({
    where: { id: params.id },
    include: {
      user: { select: { id: true, name: true, email: true, createdAt: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  // assignedTo / closedBy resolved separately (we don't have explicit
  // relations on the model — these are loose FK strings).
  const [assignedTo, closedBy] = conv
    ? await Promise.all([
        conv.assignedToId ? prisma.user.findUnique({ where: { id: conv.assignedToId }, select: { id: true, name: true } }) : null,
        conv.closedById ? prisma.user.findUnique({ where: { id: conv.closedById }, select: { name: true } }) : null,
      ])
    : [null, null];
  if (!conv) notFound();

  const vis = STATUS_VIS[conv.status] ?? STATUS_VIS.AI;
  const ref = `CHT-${conv.id.slice(-6).toUpperCase()}`;
  const customerName = conv.user?.name || conv.guestName || conv.guestEmail || 'Anonymous guest';
  const customerEmail = conv.user?.email || conv.guestEmail || null;
  const isGuest = !conv.user;
  const canReply = conv.status === 'AWAITING_HUMAN' || conv.status === 'WITH_HUMAN' || conv.status === 'AI';
  const canClose = conv.status === 'WITH_HUMAN' || conv.status === 'AI' || conv.status === 'AWAITING_HUMAN';

  return (
    <div className="space-y-4">
      <AutoRefresh />
      <Link href="/admin/messages" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" /> Back to messages
      </Link>

      {/* Hero */}
      <section className={`rounded-2xl border-2 bg-card overflow-hidden ${vis.ring} ring-1 ring-inset`}>
        <div className="p-6 grid lg:grid-cols-[1fr_auto] gap-6 items-start">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="font-mono text-[11px] text-muted-foreground">{ref}</span>
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${vis.pill}`}>
                {vis.label}
              </span>
              {isGuest && (
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0.5">
                  guest
                </span>
              )}
              {conv.rating != null && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-bold rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5">
                  <Star className="h-3 w-3 fill-amber-500 text-amber-500" /> Rated {conv.rating}/5
                </span>
              )}
            </div>
            <h1 className="text-xl font-bold tracking-tight">{conv.subject ?? 'New conversation'}</h1>
            <p className="text-sm text-muted-foreground mt-1.5 inline-flex items-center gap-1.5 flex-wrap">
              <UserCircle2 className="h-3.5 w-3.5" />
              <strong className="text-foreground">{customerName}</strong>
              {customerEmail && (<>· <Mail className="h-3 w-3" /> {customerEmail}</>)}
              <span>·</span>
              <Clock className="h-3 w-3" /> started {smartDate(conv.startedAt)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2 lg:min-w-[200px]">
            {assignedTo && (
              <p className="text-xs text-muted-foreground">
                Owned by <strong className="text-foreground">{assignedTo.name}</strong>
              </p>
            )}
            {conv.status === 'AWAITING_HUMAN' && (
              <form action={adminClaimConversation}>
                <input type="hidden" name="conversationId" value={conv.id} />
                <Button type="submit" className="rounded-full font-semibold bg-amber-600 hover:bg-amber-700 text-white">
                  <Headphones className="h-4 w-4" /> Claim conversation
                </Button>
              </form>
            )}
            {canClose && conv.status !== 'CLOSED' && conv.status !== 'ARCHIVED' && (
              <form action={adminCloseConversation}>
                <input type="hidden" name="conversationId" value={conv.id} />
                <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium">
                  <CheckCheck className="h-3.5 w-3.5" /> Close conversation
                </Button>
              </form>
            )}
          </div>
        </div>
      </section>

      <div className="grid xl:grid-cols-[1fr_320px] gap-4 items-start">
        {/* CONVERSATION */}
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
            <MessageCircle className="h-3.5 w-3.5 text-primary" />
            <h2 className="text-xs font-bold uppercase tracking-wider">Conversation</h2>
            <span className="text-xs text-muted-foreground">{conv.messages.length} message{conv.messages.length === 1 ? '' : 's'}</span>
          </div>
          <div className="p-5 space-y-3 max-h-[660px] overflow-y-auto bg-foreground/[0.02]">
            {conv.messages.map((m) => <Bubble key={m.id} m={m} customerName={customerName} />)}
            {conv.messages.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">No messages yet.</p>
            )}
          </div>
          {canReply && (
            <div className="border-t border-border bg-card px-5 py-4">
              <ReplyForm
                action={adminReplyConversation}
                hidden={{ conversationId: conv.id }}
                placeholder={`Reply as ${session?.user.name ?? 'admin'}…`}
                label="Send reply"
              />
              <p className="text-[11px] text-muted-foreground mt-2">
                {conv.status === 'AI'
                  ? 'Sending a reply takes over from the AI — the conversation moves into "With me".'
                  : 'Your reply is delivered to the customer in real time + emailed (throttled).'}
              </p>
            </div>
          )}
        </section>

        {/* SIDEBAR */}
        <aside className="space-y-3 xl:sticky xl:top-20 xl:self-start">
          <SidebarCard title="Customer" icon={<UserCircle2 className="h-3.5 w-3.5 text-primary" />}>
            <div className="space-y-2 text-sm">
              <p className="font-semibold">{customerName}</p>
              {customerEmail && <p className="text-xs"><Mail className="h-3 w-3 inline mr-1" />{customerEmail}</p>}
              <p className="text-xs text-muted-foreground">
                {isGuest ? 'Anonymous guest (browser-cookie identified)' : 'Signed-in account'}
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
              <li><strong>Last activity</strong> · {smartDate(conv.lastMessageAt)}</li>
              {conv.closedAt && <li><strong>Closed</strong> · {smartDate(conv.closedAt)} by {closedBy?.name ?? 'admin'}</li>}
              {conv.ratedAt && <li><strong>Rated</strong> · {smartDate(conv.ratedAt)} ({conv.rating}/5)</li>}
              <li><strong>Messages</strong> · {conv.messages.length}</li>
            </ul>
          </SidebarCard>

          {conv.ratingNote && (
            <SidebarCard title="Customer feedback" icon={<Star className="h-3.5 w-3.5 text-amber-500" />}>
              <p className="text-xs italic">"{conv.ratingNote}"</p>
            </SidebarCard>
          )}

          <p className="text-[10px] font-mono text-muted-foreground px-3">id: {conv.id}</p>
        </aside>
      </div>
    </div>
  );
}

function Bubble({ m, customerName }: { m: any; customerName: string }) {
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
  const ts = new Date(m.createdAt);
  return (
    <div className={`flex gap-2.5 ${isAdmin ? 'flex-row-reverse' : ''}`}>
      <div className={`h-8 w-8 rounded-full inline-flex items-center justify-center text-[11px] font-bold flex-shrink-0 shadow-sm ${
        isAdmin
          ? 'bg-primary text-primary-foreground'
          : isUser
          ? 'bg-slate-100 text-slate-700 border border-slate-200'
          : 'bg-violet-100 text-violet-800 border border-violet-200'
      }`}>
        {isAdmin ? <ShieldCheck className="h-3.5 w-3.5" /> : isUser ? customerName.charAt(0).toUpperCase() : <Sparkles className="h-3.5 w-3.5" />}
      </div>
      <div className={`flex flex-col gap-1 max-w-[80%] ${isAdmin ? 'items-end' : 'items-start'}`}>
        <div className={`text-[11px] font-semibold inline-flex items-center gap-2 ${isAdmin ? 'flex-row-reverse' : ''}`}>
          <span>{isAdmin ? 'You' : isUser ? customerName : 'AI Assistant'}</span>
          <span className="text-muted-foreground font-normal">
            {ts.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
          isAdmin
            ? 'bg-primary text-primary-foreground rounded-tr-sm'
            : isUser
            ? 'bg-card border border-border rounded-tl-sm'
            : 'bg-violet-50 border border-violet-200 rounded-tl-sm'
        }`}>
          {m.body}
          {m.attachments?.length > 0 && (
            <div className="mt-2 flex gap-2 flex-wrap">
              {m.attachments.map((url: string) => (
                /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  (<a key={url} href={url} target="_blank" rel="noreferrer">
                    <img src={url} alt="" className="h-20 w-20 rounded-md object-cover border border-border" />
                  </a>)
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

function SidebarCard({ title, icon, children }: { title: string; icon?: JSX.Element; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-2 inline-flex items-center gap-1">
        {icon}{title}
      </p>
      {children}
    </div>
  );
}
