import { notFound } from 'next/navigation';
import {
  ChevronLeft,
  ShieldCheck,
  Lock,
  AlertCircle,
} from 'lucide-react';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { legalIdentity } from '@/lib/brand/identity';
import { MessageAttachments } from '@/components/util/MessageAttachments';
import { ReplyForm } from '@/components/util/ReplyForm';
import { customerReplyRule } from '@/lib/support/rules';
import { magicLinkDays, reopenDays, supportDate } from '@/lib/support/policy';
import { guestReplyByToken } from './actions';
import { FreshLinkButton } from './FreshLinkButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Support ticket', robots: { index: false } };

/**
 * Magic-link guest portal. The accessToken in the URL is set at ticket
 * creation time for `customerType=GUEST` rows and emailed to the customer in
 * every outbound reply (each staff reply renews it). They can view the
 * conversation, see attachments, and post a reply without ever creating an
 * account — also to reopen a resolved / closed ticket within the reopen
 * period (Settings → Support).
 *
 * Security model: token is 32 chars of url-safe base64 from crypto.randomBytes
 * (≈192 bits of entropy). Combined with the per-ticket unique constraint that
 * makes guessing computationally infeasible. We never expose internal notes
 * or the internal priority here — notes are filtered in the query.
 */
export default async function GuestTicketPage(
  props: {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ ok?: string; err?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  await ensureSettingsLoaded();
  if (!params.token || params.token.length < 16) notFound();

  const t = await prisma.supportTicket.findUnique({
    where: { accessToken: params.token },
    include: {
      messages: {
        where: { isInternalNote: false }, // hard-filter — guests never see ops chatter
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!t) notFound();

  // Expiry gate. We render a calm, non-leaky "expired" page rather than
  // notFound() so the customer knows the link was valid and can get a new one
  // (sent only to the ticket's own address).
  if (t.accessTokenExpiresAt && t.accessTokenExpiresAt.getTime() <= Date.now()) {
    const supportEmail = legalIdentity().supportEmail;
    return (
      <div className="container-px py-20 max-w-md mx-auto text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-amber-100 dark:bg-amber-900/40 inline-flex items-center justify-center mb-5">
          <Lock className="h-7 w-7 text-amber-800 dark:text-amber-300" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">This link has expired</h1>
        <p className="mt-4 text-muted-foreground">
          For your security, private ticket links expire (every reply from us renews yours for {magicLinkDays()} days).
          To keep the conversation going on ticket <span className="font-mono font-semibold">{t.ref}</span>,
          we can e-mail a new link to the address the ticket was opened with.
        </p>
        <FreshLinkButton token={params.token} />
        <p className="mt-6 text-sm text-muted-foreground">
          {supportEmail ? (
            <>Or write to <a href={`mailto:${supportEmail}`} className="text-primary font-semibold hover:underline">{supportEmail}</a> and mention {t.ref}, or </>
          ) : (
            <>Or </>
          )}
          <a href={`/support?followup=${encodeURIComponent(t.ref)}`} className="text-primary font-semibold hover:underline">open a new ticket</a>.
        </p>
      </div>
    );
  }

  // Customer-friendly status labels (same map as /app/support).
  const CUSTOMER_STATUS_LABEL: Record<string, string> = {
    OPEN: 'Open',
    WAITING_ON_SUPPORT: 'Waiting for our team',
    WAITING_ON_CUSTOMER: 'Awaiting your reply',
    PENDING: 'Pending',
    RESOLVED: 'Resolved',
    CLOSED: 'Closed',
    SPAM: 'Closed',
  };
  const rule = customerReplyRule(t, reopenDays());

  return (
    <div className="container-px py-10 max-w-3xl mx-auto">
      <a href="/support" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ChevronLeft className="h-4 w-4" /> Open a new ticket
      </a>
      <div className="rounded-2xl border border-border bg-card p-6 mb-4">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="font-mono text-[11px] text-muted-foreground">{t.ref}</span>
          <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full bg-sky-50 dark:bg-sky-950/40 text-sky-800 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
            {CUSTOMER_STATUS_LABEL[t.status] ?? t.status.toLowerCase().replace(/_/g, ' ')}
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{t.subject}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          From {t.name} &lt;{t.email}&gt; · opened {t.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </p>
      </div>
      {searchParams.ok === '1' && (
        <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 p-3 mb-4 inline-flex items-center gap-2 text-sm text-emerald-900 dark:text-emerald-300">
          <ShieldCheck className="h-4 w-4" /> Reply sent — we’ll respond shortly.
        </div>
      )}
      {searchParams.err === 'closed' && (
        <div role="alert" className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-3 mb-4 inline-flex items-center gap-2 text-sm text-red-800 dark:text-red-300">
          <AlertCircle className="h-4 w-4" /> Your last message was not sent because the ticket is closed.
        </div>
      )}
      {/* Conversation */}
      <section className="rounded-2xl border border-border bg-card overflow-hidden mb-4">
        <ul className="p-5 space-y-3 bg-foreground/[0.02]">
          {t.messages.map((m) => (
            <li key={m.id}>
              <div
                className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                  m.fromStaff
                    ? 'bg-primary text-primary-foreground ml-auto'
                    : 'bg-card border border-border'
                }`}
              >
                <p className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-1">
                  {m.fromStaff ? 'Support' : t.name} ·{' '}
                  {new Date(m.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
                {m.body && <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>}
                <MessageAttachments urls={m.attachments} guestToken={params.token} />
              </div>
            </li>
          ))}
        </ul>
      </section>
      {/* Guest reply — also reopens a resolved / closed ticket within the reopen period */}
      {rule.canReply ? (
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-foreground/[0.02]">
            <h2 className="text-xs font-bold uppercase tracking-wider">{rule.reopens ? 'Reply to reopen' : 'Reply'}</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {rule.reopenUntil
                ? `This ticket is ${t.status === 'RESOLVED' ? 'resolved' : 'closed'}. Not sorted yet? A reply until ${supportDate(rule.reopenUntil)} reopens it.`
                : 'Sent to our support team. You don’t need to sign up to follow this thread.'}
            </p>
          </div>
          <div className="p-5">
            <ReplyForm
              action={guestReplyByToken}
              hidden={{ token: params.token }}
              placeholder="Add a reply…"
              label={rule.reopens ? 'Reopen and send' : 'Send reply'}
            />
          </div>
          <div className="px-5 py-3 border-t border-border bg-foreground/[0.02] text-[11px] text-muted-foreground inline-flex items-center gap-1">
            <Lock className="h-3 w-3" /> This page is private. Anyone with the link can view and reply — keep it secure.
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground" data-testid="ticket-closed">
          This ticket is closed{rule.reopenUntil ? ` (replies were possible until ${supportDate(rule.reopenUntil)})` : ''}. Need more help?{' '}
          <a href={`/support?followup=${encodeURIComponent(t.ref)}`} className="text-primary font-semibold hover:underline">Open a new ticket</a>
          {' '}and mention {t.ref}.
        </section>
      )}
    </div>
  );
}
