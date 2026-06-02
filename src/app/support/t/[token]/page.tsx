import { notFound } from 'next/navigation';
import {
  ChevronLeft,
  ShieldCheck,
  Crown,
  AlertCircle,
  ShieldAlert,
  Lock,
} from 'lucide-react';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { MessageAttachments } from '@/components/util/MessageAttachments';
import { ReplyForm } from '@/components/util/ReplyForm';
import { guestReplyByToken } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Support ticket', robots: { index: false } };

/**
 * Magic-link guest portal. The accessToken in the URL is set at ticket
 * creation time for `customerType=GUEST` rows and emailed to the customer in
 * every outbound reply. They can view the conversation, see attachments, and
 * post a reply without ever creating an account.
 *
 * Security model: token is 32 chars of url-safe base64 from crypto.randomBytes
 * (≈192 bits of entropy). Combined with the per-ticket unique constraint that
 * makes guessing computationally infeasible. We never expose internal notes
 * here — they're filtered in the query.
 */
export default async function GuestTicketPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { ok?: string };
}) {
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
  // notFound() so the customer knows the link was valid and can act on it.
  if (t.accessTokenExpiresAt && t.accessTokenExpiresAt.getTime() <= Date.now()) {
    return (
      <div className="container-px py-20 max-w-md mx-auto text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-amber-100 inline-flex items-center justify-center mb-5">
          <Lock className="h-7 w-7 text-amber-800" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">This link has expired</h1>
        <p className="mt-4 text-muted-foreground">
          For your security, support magic links are only valid for 14 days. To
          keep the conversation going on ticket <span className="font-mono font-semibold">{t.ref}</span>,
          email us and we&rsquo;ll send a fresh link.
        </p>
        <a
          href="/support"
          className="mt-8 inline-flex items-center rounded-full bg-primary text-primary-foreground px-5 py-3 text-sm font-semibold"
        >
          Open a new ticket
        </a>
      </div>
    );
  }

  const PRIORITY_ICON: Record<string, JSX.Element> = {
    VIP: <Crown className="h-3 w-3" />,
    URGENT: <ShieldAlert className="h-3 w-3" />,
    HIGH: <AlertCircle className="h-3 w-3" />,
  };

  // Customer-friendly status labels (same map as /app/support).
  const CUSTOMER_STATUS_LABEL: Record<string, string> = {
    OPEN: 'Open',
    WAITING_ON_SUPPORT: 'Support is replying',
    WAITING_ON_CUSTOMER: 'Awaiting your reply',
    PENDING: 'Pending',
    RESOLVED: 'Resolved',
    CLOSED: 'Closed',
    SPAM: 'Closed',
  };

  return (
    <div className="container-px py-10 max-w-3xl mx-auto">
      <a href="/support" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ChevronLeft className="h-4 w-4" /> Open a new ticket
      </a>

      <div className="rounded-2xl border border-border bg-card p-6 mb-4">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="font-mono text-[11px] text-muted-foreground">{t.ref}</span>
          {PRIORITY_ICON[t.priority] && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
              {PRIORITY_ICON[t.priority]} {t.priority}
            </span>
          )}
          <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full bg-sky-50 text-sky-800 border border-sky-200">
            {CUSTOMER_STATUS_LABEL[t.status] ?? t.status.toLowerCase().replace(/_/g, ' ')}
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{t.subject}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          From {t.name} &lt;{t.email}&gt; · opened {t.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </p>
      </div>

      {searchParams.ok === '1' && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 mb-4 inline-flex items-center gap-2 text-sm text-emerald-900">
          <ShieldCheck className="h-4 w-4" /> Reply sent — we’ll respond shortly.
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
                <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
                <MessageAttachments urls={m.attachments} guestToken={params.token} />
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Guest reply */}
      {t.status !== 'CLOSED' && t.status !== 'SPAM' && (
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-foreground/[0.02]">
            <h2 className="text-xs font-bold uppercase tracking-wider">Reply</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Sent to our support team. You don’t need to sign up to follow this thread.
            </p>
          </div>
          <div className="p-5">
            <ReplyForm
              action={guestReplyByToken}
              hidden={{ token: params.token }}
              placeholder="Add a reply…"
              label="Send reply"
            />
          </div>
          <div className="px-5 py-3 border-t border-border bg-foreground/[0.02] text-[11px] text-muted-foreground inline-flex items-center gap-1">
            <Lock className="h-3 w-3" /> This page is private. Anyone with the link can view and reply — keep it secure.
          </div>
        </section>
      )}
    </div>
  );
}
