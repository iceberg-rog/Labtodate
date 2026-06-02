import { notFound } from 'next/navigation';
import {
  ChevronLeft, ShieldCheck, Crown, AlertCircle, ShieldAlert, Lock, FileText,
} from 'lucide-react';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { MessageAttachments } from '@/components/util/MessageAttachments';
import { GuestQuoteReplyForm } from './GuestQuoteReplyForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Quote request', robots: { index: false } };

const PRIORITY_ICON: Record<string, JSX.Element> = {
  VIP: <Crown className="h-3 w-3" />,
  URGENT: <ShieldAlert className="h-3 w-3" />,
  HIGH: <AlertCircle className="h-3 w-3" />,
};

const CUSTOMER_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Awaiting reply',
  RESPONDED: 'Supplier replied',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  CLOSED: 'Closed',
};

export default async function GuestQuotePage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { ok?: string; err?: string };
}) {
  await ensureSettingsLoaded();
  if (!params.token || params.token.length < 16) notFound();

  const sr = await prisma.sourcingRequest.findUnique({
    where: { accessToken: params.token },
    include: {
      product: { select: { title: true, slug: true } },
      messages: {
        where: { isInternalNote: false }, // never expose admin/seller chatter to guests
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!sr) notFound();

  // Expiry gate — render a calm explainer page, not 404.
  if (sr.accessTokenExpiresAt && sr.accessTokenExpiresAt.getTime() <= Date.now()) {
    return (
      <div className="container-px py-20 max-w-md mx-auto text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-amber-100 inline-flex items-center justify-center mb-5">
          <Lock className="h-7 w-7 text-amber-800" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">This link has expired</h1>
        <p className="mt-4 text-muted-foreground">
          For your security, quote magic links are only valid for 14 days. To
          continue the conversation on quote{' '}
          <span className="font-mono font-semibold">RFQ-{sr.id.slice(-6).toUpperCase()}</span>, email us
          and we&rsquo;ll send a fresh link.
        </p>
        <a
          href="/let-us-find-it"
          className="mt-8 inline-flex items-center rounded-full bg-primary text-primary-foreground px-5 py-3 text-sm font-semibold"
        >
          Submit a new request
        </a>
      </div>
    );
  }

  const ref = sr.proformaNumber ?? `RFQ-${sr.id.slice(-6).toUpperCase()}`;
  const title = sr.product?.title ?? sr.productCategory ?? 'General sourcing request';

  return (
    <div className="container-px py-10 max-w-3xl mx-auto">
      <a href="/let-us-find-it" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ChevronLeft className="h-4 w-4" /> Submit a new request
      </a>

      <div className="rounded-2xl border border-border bg-card p-6 mb-4">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="font-mono text-[11px] text-muted-foreground">{ref}</span>
          {PRIORITY_ICON[sr.priority] && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
              {PRIORITY_ICON[sr.priority]} {sr.priority}
            </span>
          )}
          <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full bg-sky-50 text-sky-800 border border-sky-200">
            {CUSTOMER_STATUS_LABEL[sr.status] ?? sr.status.toLowerCase().replace(/_/g, ' ')}
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          From {sr.buyerName} &lt;{sr.buyerEmail}&gt; · opened {sr.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </p>
        {sr.quotedPriceCents != null && (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent/10 border border-accent/30 px-3 py-2 text-sm">
            <FileText className="h-4 w-4 text-accent" />
            <span className="text-muted-foreground">Quoted</span>
            <strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: sr.quotedCurrency ?? 'EUR' }).format(sr.quotedPriceCents / 100)}</strong>
            {sr.validUntilAt && (
              <span className="text-muted-foreground">
                {' · valid until '}{new Date(sr.validUntilAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
          </p>
        )}
      </div>

      {searchParams.ok === '1' && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 mb-4 inline-flex items-center gap-2 text-sm text-emerald-900">
          <ShieldCheck className="h-4 w-4" /> Reply sent — we&rsquo;ll respond shortly.
        </div>
      )}
      {searchParams.err === 'closed' && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 mb-4 text-sm text-amber-900">
          This quote is closed. Open a new request to continue.
        </div>
      )}

      {/* Conversation — original request first, then replies */}
      <section className="rounded-2xl border border-border bg-card overflow-hidden mb-4">
        <ul className="p-5 space-y-3 bg-foreground/[0.02]">
          <li>
            <div className="max-w-[88%] rounded-2xl px-4 py-2.5 text-sm shadow-sm bg-card border border-border">
              <p className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-1">
                {sr.buyerName} · {sr.createdAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
              <p className="whitespace-pre-wrap leading-relaxed">{sr.description}</p>
            </div>
          </li>
          {sr.messages.map((m) => (
            <li key={m.id}>
              <div
                className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                  m.fromStaff
                    ? 'bg-primary text-primary-foreground ml-auto'
                    : 'bg-card border border-border'
                }`}
              >
                <p className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-1">
                  {m.fromStaff ? 'Support' : sr.buyerName} ·{' '}
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
      {sr.status !== 'CLOSED' && sr.status !== 'DECLINED' && (
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-foreground/[0.02]">
            <h2 className="text-xs font-bold uppercase tracking-wider">Reply</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Sent to our team. You don&rsquo;t need to sign up to follow this thread.
            </p>
          </div>
          <div className="p-5">
            <GuestQuoteReplyForm token={params.token} />
          </div>
          <div className="px-5 py-3 border-t border-border bg-foreground/[0.02] text-[11px] text-muted-foreground inline-flex items-center gap-1">
            <Lock className="h-3 w-3" /> This page is private. Anyone with the link can view and reply — keep it secure.
          </div>
        </section>
      )}
    </div>
  );
}
