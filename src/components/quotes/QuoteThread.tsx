'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Send, Check, X, ShieldCheck, MessageCircle, FileText, Clock, Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { replyToQuote, setQuoteStatus, sendProforma } from '@/lib/quotes/actions';
import { ProformaStepper } from '@/components/quotes/ProformaStepper';
import type { DealStateBadge } from '@/lib/quotes/deal-state';

interface Message {
  id: string;
  body: string;
  createdAt: string;
  authorName: string | null;
  authorEmail: string | null;
  isMine: boolean;
}

interface Props {
  sourcingRequestId: string;
  buyerName: string;
  buyerEmail: string;
  description: string;
  status: 'PENDING' | 'RESPONDED' | 'ACCEPTED' | 'DECLINED' | 'CLOSED';
  product?: { title: string; slug: string } | null;
  messages: Message[];
  /** Role of the viewer in this thread. */
  viewerRole: 'BUYER' | 'SELLER' | 'ADMIN';
  createdAt: string;
  /** True when a formal proforma has been issued (quotedPriceCents != null).
   *  Gates the Accept/Decline buttons — a buyer must NEVER be able to
   *  "accept" a text reply that has no formal price. */
  hasProforma?: boolean;
  /** Direct link to the materialised purchase workspace if Order exists. */
  orderPaymentHref?: string | null;
  /** Pre-computed deal state for the funnel stepper at the top. */
  dealBadge?: DealStateBadge;
}

const MAX_REPLY_LEN = 4000;

export function QuoteThread(p: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const text = body.trim();
    if (text.length < 2) return;
    startTransition(async () => {
      try {
        await replyToQuote({ sourcingRequestId: p.sourcingRequestId, body: text });
        setBody('');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Reply failed');
      }
    });
  }

  const [price, setPrice] = useState('');
  const [qnote, setQnote] = useState('');

  function quote(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cents = Math.round(parseFloat(price) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError('Enter a valid price');
      return;
    }
    startTransition(async () => {
      try {
        await sendProforma({
          sourcingRequestId: p.sourcingRequestId,
          priceCents: cents,
          currency: 'EUR',
          note: qnote.trim() || null,
        });
        setPrice('');
        setQnote('');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not send proforma');
      }
    });
  }

  function decide(status: 'ACCEPTED' | 'DECLINED' | 'CLOSED') {
    startTransition(async () => {
      try {
        await setQuoteStatus(p.sourcingRequestId, status);
        router.refresh();
      } catch (err) {
        // Accepting converts the quote into an order and redirects there —
        // don't surface the framework's redirect signal as an error.
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        setError(err instanceof Error ? err.message : 'Action failed');
      }
    });
  }

  return (
    <div className="space-y-5">
      {/* ───────────────── Header card ───────────────── */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="p-6">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                {p.product ? 'Quote about' : 'Sourcing request'}
              </p>
              <h2 className="text-xl font-bold mt-1 truncate">
                {p.product ? p.product.title : `Request from ${p.buyerName}`}
              </h2>
            </div>
            <StatusPill status={p.status} />
          </div>

          {/* Stepper — gives the buyer instant orientation in the funnel */}
          {p.dealBadge && (
            <div className="mt-5">
              <ProformaStepper badge={p.dealBadge} />
            </div>
          )}

          <div className="mt-6 grid sm:grid-cols-3 gap-3 text-sm">
            <Meta label="Buyer" value={p.buyerName} />
            <Meta label="Email" value={p.buyerEmail} />
            <Meta label="Opened" value={new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} />
          </div>

          <div className="mt-6 pt-5 border-t">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground mb-2 inline-flex items-center gap-1">
              <FileText className="h-3 w-3" /> Original request
            </p>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{p.description}</p>
          </div>
        </div>
      </div>

      {/* ───────────────── Conversation ───────────────── */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
          <MessageCircle className="h-3.5 w-3.5 text-primary" />
          <h3 className="text-xs font-bold uppercase tracking-wider">Conversation</h3>
          <span className="text-xs text-muted-foreground">
            {p.messages.length === 0 ? 'no replies yet' : `${p.messages.length} message${p.messages.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <div className="p-5 space-y-4 bg-foreground/[0.02] max-h-[680px] overflow-y-auto">
          {p.messages.length === 0 ? (
            <EmptyConversation status={p.status} />
          ) : (
            p.messages.map((m) => <MessageBubble key={m.id} m={m} buyerName={p.buyerName} />)
          )}
        </div>
      </div>

      {/* ───────────────── Seller/Admin proforma composer (unchanged) ───────────────── */}
      {(p.viewerRole === 'SELLER' || p.viewerRole === 'ADMIN') &&
        p.status !== 'CLOSED' &&
        p.status !== 'ACCEPTED' &&
        p.status !== 'DECLINED' && (
          <form onSubmit={quote} className="rounded-2xl border-2 border-accent/40 bg-accent/[0.04] p-4 space-y-3">
            <div>
              <p className="text-sm font-bold inline-flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-accent" /> Send a price quote (proforma)
              </p>
              <p className="text-xs text-muted-foreground">
                Emails the buyer a proforma invoice with your company details and these terms.
              </p>
            </div>
            <div className="flex gap-3 flex-wrap items-end">
              <label className="block">
                <span className="block text-xs font-semibold mb-1">Price (EUR)</span>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="18500"
                  className="h-10 w-44 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  required
                />
              </label>
              <Button type="submit" disabled={pending} className="rounded-full font-semibold">
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Send proforma
              </Button>
            </div>
            <textarea
              value={qnote}
              onChange={(e) => setQnote(e.target.value)}
              rows={2}
              placeholder="Optional: lead time, condition, what's included, payment terms…"
              className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
            />
          </form>
        )}

      {/* ───────────────── Reply box ───────────────── */}
      {p.status !== 'CLOSED' && p.status !== 'ACCEPTED' && p.status !== 'DECLINED' && (
        <form onSubmit={send} className="rounded-2xl border border-border bg-card p-4 space-y-3 focus-within:border-primary/50 focus-within:shadow-sm transition">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, MAX_REPLY_LEN))}
            rows={4}
            placeholder={p.viewerRole === 'SELLER' ? 'Reply with your quote details, lead time, and any clarifying questions…' : 'Reply to the supplier…'}
            className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-y"
            required
            minLength={2}
            maxLength={MAX_REPLY_LEN}
          />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{p.viewerRole === 'BUYER' ? 'Replies are emailed to the supplier.' : 'Replies are emailed to the buyer.'}</span>
            <span className={body.length > MAX_REPLY_LEN - 200 ? 'text-amber-600 font-semibold' : ''}>
              {body.length} / {MAX_REPLY_LEN}
            </span>
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</p>}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <Button type="submit" disabled={pending || body.trim().length < 2} className="rounded-full font-semibold">
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send reply
            </Button>
            {/* Buyer-side actions on a RESPONDED quote — gated by formal proforma.
                Without quotedPriceCents (i.e. admin only sent a text reply),
                buyer cannot accept. Instead they see a hint that they're
                awaiting a formal proforma. */}
            {p.viewerRole === 'BUYER' && p.status === 'RESPONDED' && (
              p.hasProforma ? (
                <div className="flex gap-2 items-center">
                  {p.orderPaymentHref && (
                    <a
                      href={p.orderPaymentHref}
                      className="inline-flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 shadow-sm"
                    >
                      <Check className="h-4 w-4" /> Complete your purchase
                    </a>
                  )}
                  <Button type="button" variant="outline" onClick={() => decide('DECLINED')} className="rounded-full font-semibold" disabled={pending}>
                    <X className="h-4 w-4" /> Decline
                  </Button>
                </div>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900 px-3 py-1.5 text-[11px] font-semibold">
                  <Clock className="h-3 w-3" />
                  Awaiting formal proforma before you can accept
                </span>
              )
            )}
            {/* Seller can close anytime */}
            {p.viewerRole === 'SELLER' && (
              <Button type="button" variant="ghost" onClick={() => decide('CLOSED')} className="rounded-full font-medium" disabled={pending}>
                Close request
              </Button>
            )}
          </div>
        </form>
      )}

      {/* ───────────────── Terminal-state foot ───────────────── */}
      {p.status === 'DECLINED' && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 flex items-start gap-3">
          <X className="h-5 w-5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-bold">You declined this quote.</p>
            <p className="text-xs mt-1">If you need this again, you can open a new sourcing request from <strong>Let Us Find It</strong>.</p>
          </div>
        </div>
      )}
      {p.status === 'CLOSED' && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 flex items-start gap-3">
          <Clock className="h-5 w-5 mt-0.5 flex-shrink-0" />
          <p>This request was closed without a deal.</p>
        </div>
      )}
    </div>
  );
}

/* ─────────────── helpers ─────────────── */

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.15em] font-bold text-muted-foreground">{label}</p>
      <p className="font-medium mt-0.5 truncate">{value}</p>
    </div>
  );
}

function StatusPill({ status }: { status: Props['status'] }) {
  const map: Record<Props['status'], { variant: 'success' | 'warning' | 'accent' | 'secondary'; label: string }> = {
    PENDING:   { variant: 'warning',   label: 'Waiting for supplier' },
    RESPONDED: { variant: 'accent',    label: 'Supplier replied — your move' },
    ACCEPTED:  { variant: 'success',   label: 'Accepted' },
    DECLINED:  { variant: 'secondary', label: 'Declined' },
    CLOSED:    { variant: 'secondary', label: 'Closed' },
  };
  const m = map[status];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

/**
 * Avatar component — initials in a stable, name-hashed color circle. Cheap
 * visual anchor that makes the conversation feel like a real chat instead
 * of stacked grey boxes.
 */
function Avatar({ name, mine, supplier }: { name: string | null; mine: boolean; supplier: boolean }) {
  const initials =
    (name ?? '·')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '·';
  const palette = mine
    ? 'bg-primary text-primary-foreground'
    : supplier
    ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
    : 'bg-slate-100 text-slate-700 border border-slate-200';
  return (
    <div className={`h-8 w-8 rounded-full inline-flex items-center justify-center text-[11px] font-bold flex-shrink-0 shadow-sm ${palette}`}>
      {supplier && !mine ? <ShieldCheck className="h-3.5 w-3.5" /> : initials}
    </div>
  );
}

function MessageBubble({ m, buyerName }: { m: Message; buyerName: string }) {
  const isSupplier = !m.isMine && /supplier|lab2date/i.test(m.authorName ?? '');
  const ts = new Date(m.createdAt);
  return (
    <div className={`flex gap-2.5 ${m.isMine ? 'flex-row-reverse' : ''}`}>
      <Avatar name={m.authorName ?? buyerName} mine={m.isMine} supplier={isSupplier} />
      <div className={`flex flex-col gap-1 max-w-[80%] ${m.isMine ? 'items-end' : 'items-start'}`}>
        <div className={`text-[11px] font-semibold inline-flex items-center gap-2 ${m.isMine ? 'flex-row-reverse' : ''}`}>
          <span>{m.isMine ? 'You' : (m.authorName ?? 'Anonymous')}</span>
          <span className="text-muted-foreground font-normal">
            {ts.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
            m.isMine
              ? 'bg-primary text-primary-foreground rounded-tr-sm'
              : isSupplier
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-950 rounded-tl-sm'
              : 'bg-card border border-border rounded-tl-sm'
          }`}
        >
          {m.body}
        </div>
      </div>
    </div>
  );
}

function EmptyConversation({ status }: { status: Props['status'] }) {
  return (
    <div className="text-center py-10">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-3">
        <MessageCircle className="h-6 w-6" />
      </div>
      <p className="text-sm font-bold">
        {status === 'PENDING'
          ? 'Your request is with the supplier'
          : 'The conversation will appear here'}
      </p>
      <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
        {status === 'PENDING'
          ? 'You\'ll get an email + notification the moment a supplier responds. Typical first reply: under 1 business day.'
          : 'Once either side sends a message it\'ll show up here in real time.'}
      </p>
    </div>
  );
}
