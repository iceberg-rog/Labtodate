import Link from 'next/link';
import { LifeBuoy, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { customerReplyTicket } from '@/lib/support/actions';
import { customerReplyRule } from '@/lib/support/rules';
import { reopenDays, supportDate } from '@/lib/support/policy';
import { ReplyForm } from '@/components/util/ReplyForm';
import { MessageAttachments } from '@/components/util/MessageAttachments';
import { AutoRefresh } from '@/components/util/AutoRefresh';

export const dynamic = 'force-dynamic';

// Customer-side labels. The DB enum is admin-jargon ("WAITING_ON_CUSTOMER" /
// "WAITING_ON_SUPPORT") — confusing on the buyer side. Translate to plain
// language so the buyer immediately knows whose move it is. The internal
// priority (VIP / URGENT …) is never shown to customers.
const CUSTOMER_STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'accent' | 'secondary' }> = {
  OPEN:                  { label: 'Open',                  variant: 'warning' },
  WAITING_ON_SUPPORT:    { label: 'Waiting for our team',  variant: 'accent' },
  WAITING_ON_CUSTOMER:   { label: 'Awaiting your reply',   variant: 'warning' },
  PENDING:               { label: 'Pending',               variant: 'accent' },
  RESOLVED:              { label: 'Resolved',              variant: 'success' },
  CLOSED:                { label: 'Closed',                variant: 'secondary' },
  SPAM:                  { label: 'Closed',                variant: 'secondary' },
};

export default async function CustomerSupportPage(props: { searchParams?: Promise<{ sent?: string; open?: string }> }) {
  const session = await requireSession({ redirectTo: '/app/support' });
  await ensureSettingsLoaded();
  const sp = (await props.searchParams) ?? {};
  // Back from “Ask a question” / “Request photos” on a product page (?sent=),
  // or from a notification / e-mail about one ticket (?open=).
  const sent = (sp.sent ?? '').slice(0, 40);
  const open = (sp.open ?? sent).slice(0, 40);
  const days = reopenDays();
  const tickets = await prisma.supportTicket.findMany({
    where: { OR: [{ submittedById: session.user.id }, { email: session.user.email }] },
    orderBy: { updatedAt: 'desc' },
    include: {
      messages: {
        where: { isInternalNote: false },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Support</h1>
          <p className="text-muted-foreground mt-1">
            {tickets.length} ticket{tickets.length === 1 ? '' : 's'} · we reply by email and here
          </p>
        </div>
        <Button asChild className="rounded-full font-semibold">
          <Link href="/support"><Plus className="h-4 w-4" /> New ticket</Link>
        </Button>
      </div>

      {sent && tickets.some((t) => t.ref === sent) && (
        <div role="status" className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300 p-4 text-sm" data-testid="question-sent">
          <strong>Sent — reference {sent}.</strong> Your message is with our team. We reply by email and here; you can add to it below.
        </div>
      )}

      {tickets.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <LifeBuoy className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No tickets yet</p>
          <p className="text-sm text-muted-foreground mt-2">Open a ticket and track replies right here.</p>
          <Button asChild className="rounded-full font-semibold mt-5">
            <Link href="/support">Open a ticket</Link>
          </Button>
        </div>
      ) : (
        <ul className="space-y-4">
          {tickets.map((t) => {
            // BUG-019: when ops archives a ticket that is NOT in a terminal
            // status, the buyer must not read "Awaiting your reply" forever.
            // Surface it as closed; a reply auto-unarchives (BUG-018).
            const closedByTeam =
              !!t.archivedAt && !['RESOLVED', 'CLOSED', 'SPAM'].includes(t.status);
            const badge = closedByTeam
              ? { label: 'Closed by support', variant: 'secondary' as const }
              : (CUSTOMER_STATUS[t.status] ?? { label: t.status.toLowerCase().replace(/_/g, ' '), variant: 'secondary' as const });
            // Spam never takes replies; resolved / closed reopen on a reply
            // within the reopen period (Settings → Support).
            const rule = customerReplyRule(t, days);
            return (
            <li key={t.id} id={t.ref} className="rounded-2xl border border-border bg-card overflow-hidden scroll-mt-24">
              <details open={t.ref === open}>
                <summary className="p-5 cursor-pointer list-none flex items-center gap-4 hover:bg-foreground/5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                      {t.ref}{t.category ? ` · ${t.category}` : ''}
                    </p>
                    <p className="font-semibold truncate">{t.subject}</p>
                  </div>
                  <Badge variant={badge.variant}>
                    {badge.label}
                  </Badge>
                </summary>
                <div className="border-t border-border p-5 space-y-3 bg-foreground/[0.02]">
                  {t.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                        m.fromStaff ? 'bg-primary text-primary-foreground' : 'bg-card border border-border ml-auto'
                      }`}
                    >
                      <p className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-1">
                        {m.fromStaff ? 'Support' : 'You'} ·{' '}
                        {new Date(m.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </p>
                      {m.body && <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>}
                      <MessageAttachments urls={m.attachments} />
                    </div>
                  ))}
                  {closedByTeam && (
                    <p className="text-xs text-muted-foreground rounded-lg border border-border bg-card px-3 py-2">
                      Our support team closed this conversation. Replying below will reopen it.
                    </p>
                  )}
                  {rule.canReply && rule.reopenUntil && (
                    <p className="text-xs text-muted-foreground rounded-lg border border-border bg-card px-3 py-2">
                      This ticket is {t.status === 'RESOLVED' ? 'resolved' : 'closed'}. Not sorted yet? A reply until {supportDate(rule.reopenUntil)} reopens it.
                    </p>
                  )}
                  {rule.canReply ? (
                    <ReplyForm
                      action={customerReplyTicket}
                      hidden={{ ticketId: t.id }}
                      placeholder="Reply…"
                      label={rule.reopens ? 'Reopen and send' : 'Send'}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground rounded-lg border border-border bg-card px-3 py-2" data-testid="ticket-closed">
                      This ticket is closed{rule.reopenUntil ? ` (replies were possible until ${supportDate(rule.reopenUntil)})` : ''}. Need more help?{' '}
                      <Link href={`/support?followup=${encodeURIComponent(t.ref)}`} className="text-primary font-semibold hover:underline">Open a new ticket</Link>.
                    </p>
                  )}
                </div>
              </details>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
