import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight, EyeOff, Hourglass, MessageCircle, Send, ShieldAlert, Ticket } from 'lucide-react';
import { hasCapability, requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingEnum } from '@/lib/settings';
import { settingDef } from '@/lib/settings/defs';
import { siteName } from '@/lib/brand/identity';
import { Button } from '@/components/ui/button';
import { AdminActionForm } from '@/components/admin/AdminActionForm';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import {
  CONTACT_REMOVED, deliveryState, mediationMode, messageText, screeningSummary,
  type ContactKind, type MessageFlag,
} from '@/lib/messages/mediation';
import { releaseHeldMessage, staffReplyToThread, withholdHeldMessage } from '@/lib/messages/actions';
import { threadTicket } from '@/lib/messages/to-ticket';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Message thread' };

type Screening = { removed: ContactKind[]; flags: MessageFlag[]; held: boolean; original: string | null };

/**
 * Staff view of one buyer ↔ supplier MessageThread: every message with its
 * mediation state (held / not delivered / contact details removed, with the
 * original text from the audit trail), Release / Don't deliver for held
 * supplier messages, and a reply that both participants see as “<Site> team”.
 * Viewing here does NOT mark anything as read for the participants.
 */
export default async function AdminThreadPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  await requireCapability('messages:view');
  await ensureSettingsLoaded();
  const site = siteName();
  const canReply = await hasCapability('messages:reply');

  const thread = await prisma.messageThread.findUnique({
    where: { id: params.id },
    include: {
      buyer: { select: { id: true, name: true, email: true } },
      seller: { select: { id: true, name: true, email: true, role: true, company: { select: { name: true } } } },
      product: { select: { title: true, slug: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, createdAt: true, readAt: true, authorId: true, author: { select: { name: true, email: true } } },
      },
    },
  });
  if (!thread) notFound();

  const [screenRows, moved] = await Promise.all([
    prisma.auditLog.findMany({ where: { action: 'message.screened', target: thread.id }, orderBy: { createdAt: 'asc' }, select: { meta: true } }),
    threadTicket(thread.id),
  ]);
  const screening = new Map<string, Screening>();
  for (const r of screenRows) {
    try {
      const v = JSON.parse(r.meta ?? '') as { messageId?: string; removed?: ContactKind[]; flags?: MessageFlag[]; held?: boolean; original?: string };
      if (v.messageId) {
        screening.set(v.messageId, { removed: v.removed ?? [], flags: v.flags ?? [], held: !!v.held, original: typeof v.original === 'string' ? v.original : null });
      }
    } catch {
      /* unreadable row — show the message without its screening details */
    }
  }
  const mode = mediationMode(settingEnum('MESSAGE_MEDIATION_MODE'));
  const modeLabel = settingDef('MESSAGE_MEDIATION_MODE')?.options?.find((o) => o.value === mode)?.label ?? mode;

  const who = (authorId: string) =>
    authorId === thread.buyerId ? 'Buyer' : authorId === thread.sellerId ? 'Supplier' : 'Staff';
  const supplierName = thread.seller.company?.name ? `${thread.seller.company.name} · ${thread.seller.name}` : thread.seller.name;

  return (
    <div className="space-y-6 max-w-3xl">
      <AutoRefresh />
      <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
        <Link href="/admin/messages/threads" className="hover:text-foreground">Buyer-supplier threads</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">MSG-{thread.id.slice(-6).toUpperCase()}</span>
      </nav>

      <div>
        <h1 className="text-2xl font-bold tracking-tight inline-flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-primary" /> {thread.subject || 'Conversation'}
        </h1>
        <div className="mt-2 grid sm:grid-cols-2 gap-2 text-sm">
          <p>
            <span className="text-muted-foreground">Buyer: </span>
            <Link href={`/admin/users/${thread.buyer.id}`} className="text-primary hover:underline">
              {thread.buyer.name}
            </Link>{' '}
            <span className="text-xs text-muted-foreground">{thread.buyer.email}</span>
          </p>
          <p>
            <span className="text-muted-foreground">Supplier: </span>
            <Link href={`/admin/users/${thread.seller.id}`} className="text-primary hover:underline">
              {supplierName}
            </Link>{' '}
            <span className="text-xs text-muted-foreground">{thread.seller.email}</span>
          </p>
          {thread.product && (
            <p className="sm:col-span-2">
              <span className="text-muted-foreground">Product: </span>
              <Link href={`/marketplace/${thread.product.slug}`} target="_blank" className="text-primary hover:underline">
                {thread.product.title}
              </Link>
            </p>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          Participants see each other only as “{site} Supplier” / “{site} Buyer”; your replies show as “{site} team” to both.
          Mediation: {modeLabel} (<Link href="/admin/settings?tab=Suppliers" className="text-primary hover:underline">Settings → Suppliers</Link>).
        </p>
        {moved && (
          <p className="mt-3 rounded-xl border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 text-sky-900 dark:text-sky-300 px-3 py-2 text-sm inline-flex items-center gap-2">
            <Ticket className="h-4 w-4" /> Moved to support ticket{' '}
            <Link href={`/admin/tickets/${moved.ticketId}`} className="font-semibold underline">{moved.ref}</Link>
            — the question is about your own stock, so the whole team answers it there.
          </p>
        )}
      </div>

      <ul className="space-y-3">
        {thread.messages.length === 0 && (
          <li className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground text-center">
            No messages in this conversation.
          </li>
        )}
        {thread.messages.map((m) => {
          const role = who(m.authorId);
          const state = deliveryState(m.body);
          const text = messageText(m.body);
          const s = screening.get(m.id);
          const summary = s ? screeningSummary(s) : '';
          return (
            <li
              key={m.id}
              className={`rounded-2xl border p-4 ${
                state === 'HELD'
                  ? 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30 sm:ml-10'
                  : role === 'Buyer' ? 'border-border bg-card' : 'border-primary/30 bg-primary/5 sm:ml-10'
              }`}
            >
              <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground mb-1.5 flex-wrap">
                <span className="font-bold uppercase tracking-wider">
                  {role}{role === 'Staff' ? ` · ${m.author.name || m.author.email}` : ''}
                </span>
                <span className="tabular-nums">
                  {m.createdAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                  {state === 'HELD' ? ' · waiting for release' : state === 'WITHHELD' ? ' · not delivered' : m.readAt ? ' · read' : ' · unread'}
                </span>
              </div>
              <p className={`text-sm whitespace-pre-wrap break-words ${state === 'WITHHELD' ? 'line-through text-muted-foreground' : ''}`}>{text}</p>
              {(summary || state === 'HELD') && (
                <p className="mt-2 text-[11px] font-semibold inline-flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
                  {state === 'HELD' ? <Hourglass className="h-3.5 w-3.5" /> : text.includes(CONTACT_REMOVED) ? <EyeOff className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                  {state === 'HELD' ? `Held for staff review${summary ? ` — ${summary}` : ''}` : summary}
                </p>
              )}
              {s?.original && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Original text (staff only)</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2">{s.original}</p>
                </details>
              )}
              {state === 'HELD' && canReply && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <AdminActionForm action={releaseHeldMessage.bind(null, m.id, 'SCREENED')}>
                    <Button type="submit" size="sm" className="rounded-full font-semibold">
                      {text.includes(CONTACT_REMOVED) ? 'Deliver without contact details' : 'Deliver'}
                    </Button>
                  </AdminActionForm>
                  {s?.original && (
                    <AdminActionForm
                      action={releaseHeldMessage.bind(null, m.id, 'AS_WRITTEN')}
                      confirmMessage="Deliver the original text, including the contact details it contains?"
                    >
                      <Button type="submit" size="sm" variant="outline" className="rounded-full font-medium">Deliver as written</Button>
                    </AdminActionForm>
                  )}
                  <AdminActionForm
                    action={withholdHeldMessage.bind(null, m.id)}
                    confirmMessage="Don't deliver this message? The supplier is told it was not passed on."
                  >
                    <Button type="submit" size="sm" variant="ghost" className="rounded-full font-medium">Don&apos;t deliver</Button>
                  </AdminActionForm>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {canReply ? (
        <AdminActionForm action={staffReplyToThread.bind(null, thread.id)} resetOnSuccess className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <label htmlFor="staff-reply" className="text-sm font-semibold">Reply as {site} team</label>
          <textarea
            id="staff-reply"
            name="body"
            rows={4}
            required
            minLength={2}
            maxLength={4000}
            placeholder={`Both the buyer and the supplier see this reply, signed “${site} team”.`}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          <p className="text-[11px] text-muted-foreground">
            Visible to both sides and never changed by the contact-detail filter. Both are notified (bell, and e-mail unless they were e-mailed about this conversation recently).
          </p>
          <Button type="submit" size="sm" className="rounded-full font-semibold">
            <Send className="h-4 w-4" /> Post reply
          </Button>
        </AdminActionForm>
      ) : (
        <p className="text-xs text-muted-foreground">You can read this conversation; replying needs the “messages:reply” permission.</p>
      )}
    </div>
  );
}
