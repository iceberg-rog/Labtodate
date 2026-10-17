'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Send, Check, X, ShieldCheck, MessageCircle, FileText, Clock, Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { replyToQuote, setQuoteStatus } from '@/lib/quotes/actions';
import { DealStepper } from '@/components/quotes/DealStepper';
import { DealStateBadge as DealPill } from '@/components/quotes/DealStateBadge';
import { OfferForm, type OfferFormProps } from '@/components/quotes/OfferForm';
import { MessageAttachments } from '@/components/util/MessageAttachments';
import type { DealStateBadge } from '@/lib/quotes/deal-state';

interface Message {
  id: string;
  body: string;
  createdAt: string;
  authorName: string | null;
  authorEmail: string | null;
  isMine: boolean;
  /** Written by lab2date staff or the assigned seller (drives the shield styling). */
  fromStaff?: boolean;
  /** Team-only note — only ever passed to admin viewers. */
  isInternalNote?: boolean;
  /** Auth-gated /api/support-attachment URLs. */
  attachments?: string[];
}

interface Props {
  sourcingRequestId: string;
  buyerName: string;
  buyerEmail: string;
  description: string;
  status: 'PENDING' | 'RESPONDED' | 'ACCEPTED' | 'DECLINED' | 'CLOSED';
  product?: { title: string; slug: string } | null;
  /** Category / lab-rental facility of a request without a product
   *  (e.g. "Lab rental: BioLab … (Berlin, Germany)") — names the thread. */
  productCategory?: string | null;
  messages: Message[];
  /** Role of the viewer in this thread. */
  viewerRole: 'BUYER' | 'SELLER' | 'ADMIN';
  createdAt: string;
  /** Pre-computed deal state (same mapping on every surface) — drives the
   *  status pill and the funnel stepper. */
  dealBadge?: DealStateBadge;
  /** Seller (assigned supplier) offer composer; null/undefined = hidden.
   *  Accept/decline live in the OfferCard above the thread, not here. */
  offerForm?: Omit<OfferFormProps, 'quoteId' | 'onResult'> | null;
  /** Supplier may close the request (only while no offer is accepted). */
  canClose?: boolean;
}

const MAX_REPLY_LEN = 4000;

export function QuoteThread(p: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Saved, but something secondary failed (e.g. the email bounced).
  const [warning, setWarning] = useState<string | null>(null);
  // Outcome of a successful status change (e.g. "Order … was canceled") — the
  // reply form that shows `error` is gone once the request is closed.
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setWarning(null);
    const text = body.trim();
    if (text.length < 2) return;
    startTransition(async () => {
      try {
        const r = await replyToQuote({ sourcingRequestId: p.sourcingRequestId, body: text });
        if (r?.error) {
          setError(r.error);
          return;
        }
        if (r?.warning) setWarning(r.warning);
        setBody('');
        router.refresh();
      } catch {
        setError('Your reply could not be sent: the request failed. Reload the page to check, then try again.');
      }
    });
  }

  // Closing ends the deal for good (a closed quote's offer can no longer be
  // accepted) and cancels an unpaid order if one exists — same confirm as the
  // admin "Close (no deal)".
  function closeRequest() {
    setConfirmClose(false);
    setError(null);
    setWarning(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const r = await setQuoteStatus(p.sourcingRequestId, 'CLOSED');
        if (r?.error) {
          setError(r.error);
          return;
        }
        if (r?.warning) setWarning(r.warning);
        if (r?.notice) setNotice(r.notice);
        router.refresh();
      } catch {
        setError('That did not work. Reload the page and try again.');
      }
    });
  }

  // Whose move it is follows who wrote last: a buyer follow-up after a reply or
  // proforma puts the ball back with the supplier, whatever the status says.
  const lastPublic = [...p.messages].reverse().find((m) => !m.isInternalNote);
  const lastFromBuyer = !!lastPublic && !lastPublic.fromStaff;

  // Name the request: the product, else its category / lab facility, else the
  // first line of what was asked — never just the buyer's own name.
  const firstLine = p.description.trim().split(/\r?\n/)[0]?.trim() ?? '';
  const summary = firstLine.length > 90 ? `${firstLine.slice(0, 87).trimEnd()}…` : firstLine;
  const threadTitle =
    p.product?.title ?? (p.productCategory?.trim() || summary || `Request from ${p.buyerName}`);

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
              <h1 dir="auto" className="text-xl font-bold mt-1 line-clamp-2 [overflow-wrap:anywhere]" title={threadTitle}>
                {threadTitle}
              </h1>
            </div>
            {p.dealBadge ? (
              <DealPill badge={p.dealBadge} />
            ) : (
              <StatusPill status={p.status} viewerRole={p.viewerRole} lastFromBuyer={lastFromBuyer} />
            )}
          </div>

          {/* Stepper — gives the buyer instant orientation in the funnel */}
          {p.dealBadge && (
            <div className="mt-5">
              <DealStepper badge={p.dealBadge} />
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
            <p dir="auto" className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{p.description}</p>
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
            <EmptyConversation status={p.status} viewerRole={p.viewerRole} />
          ) : (
            p.messages.map((m) => <MessageBubble key={m.id} m={m} buyerName={p.buyerName} />)
          )}
        </div>
      </div>

      {/* ───────────────── Seller offer composer ───────────────── */}
      {(p.viewerRole === 'SELLER' || p.viewerRole === 'ADMIN') && p.offerForm && (
        <section className="rounded-2xl border-2 border-accent/40 bg-accent/[0.04] p-4 space-y-3" aria-label="Send offer">
          <div>
            <p className="text-sm font-bold inline-flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-accent" />
              {p.offerForm.mode === 'SELLER' ? (p.offerForm.current ? 'Update your price' : 'Propose a price') : p.offerForm.current ? 'Update the offer' : 'Send an offer'}
            </p>
            <p className="text-xs text-muted-foreground">
              {p.offerForm.mode === 'SELLER'
                ? 'lab2date turns your price into the offer the buyer sees. The order is created only when the buyer accepts it.'
                : 'The buyer reviews the offer and accepts or declines it. The order and the proforma invoice are created only when they accept.'}
            </p>
          </div>
          <OfferForm quoteId={p.sourcingRequestId} {...p.offerForm} />
        </section>
      )}

      {/* ───────────────── Reply box ───────────────── */}
      {p.status !== 'CLOSED' && p.status !== 'DECLINED' && (
        <form onSubmit={send} className="rounded-2xl border border-border bg-card p-4 space-y-3 focus-within:border-primary/50 focus-within:shadow-sm transition">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, MAX_REPLY_LEN))}
            rows={4}
            placeholder={p.viewerRole === 'SELLER' ? 'Ask the buyer a question or explain your offer…' : 'Ask the supplier a question…'}
            dir="auto"
            className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-y"
            required
            minLength={2}
            maxLength={MAX_REPLY_LEN}
          />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{p.viewerRole === 'BUYER' ? 'Replies are emailed to the supplier.' : 'Replies are emailed to the buyer.'}</span>
            <span className={body.length > MAX_REPLY_LEN - 200 ? 'text-amber-600 dark:text-amber-400 font-semibold' : ''}>
              {body.length} / {MAX_REPLY_LEN}
            </span>
          </div>
          {error && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800">{error}</p>}
          {warning && <p role="status" className="text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-md px-3 py-2 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-800">{warning}</p>}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <Button type="submit" disabled={pending || body.trim().length < 2} className="rounded-full font-semibold">
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send reply
            </Button>
            {/* The supplier can close a request that is not accepted yet — behind an in-page confirm. */}
            {p.viewerRole === 'SELLER' && p.canClose !== false && !confirmClose && (
              <Button type="button" variant="ghost" onClick={() => setConfirmClose(true)} className="rounded-full font-medium" disabled={pending}>
                Close request
              </Button>
            )}
          </div>
          {confirmClose && (
            <div role="alertdialog" aria-label="Close the request" className="rounded-xl border-2 border-red-300 dark:border-red-800 p-3 space-y-2">
              <p className="text-sm font-bold">Close this request without a deal?</p>
              <p className="text-xs text-muted-foreground">The open offer is withdrawn, the buyer and the lab2date team are notified, and the request can not be reopened.</p>
              <div className="flex gap-2 flex-wrap">
                <Button type="button" size="sm" onClick={closeRequest} disabled={pending} className="rounded-full bg-red-700 hover:bg-red-800 text-white">Close the request</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmClose(false)} disabled={pending} className="rounded-full">Keep it open</Button>
              </div>
            </div>
          )}
        </form>
      )}

      {/* ───────────────── Terminal-state foot ───────────────── */}
      {warning && (p.status === 'CLOSED' || p.status === 'DECLINED') && (
        <div role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {warning}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 flex items-start gap-3 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <Check className="h-5 w-5 mt-0.5 flex-shrink-0" />
          <p>{notice}</p>
        </div>
      )}
      {p.status === 'DECLINED' && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 flex items-start gap-3 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <X className="h-5 w-5 mt-0.5 flex-shrink-0" />
          {p.viewerRole === 'BUYER' ? (
            <div>
              <p className="font-bold">You declined this offer.</p>
              <p className="text-xs mt-1">If you need this again, you can open a new sourcing request from <strong>Let Us Find It</strong>.</p>
            </div>
          ) : (
            <p className="font-bold">The buyer declined this offer.</p>
          )}
        </div>
      )}
      {p.status === 'CLOSED' && (
        <div className="rounded-2xl border border-border bg-muted p-4 text-sm text-muted-foreground flex items-start gap-3">
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
      <p className="font-medium mt-0.5 truncate"><bdi>{value}</bdi></p>
    </div>
  );
}

type PillMap = Record<Props['status'], { variant: 'success' | 'warning' | 'accent' | 'secondary'; label: string }>;

const BUYER_PILLS: PillMap = {
  PENDING:   { variant: 'warning',   label: 'Waiting for supplier' },
  RESPONDED: { variant: 'accent',    label: 'Supplier replied — your move' },
  ACCEPTED:  { variant: 'success',   label: 'Accepted' },
  DECLINED:  { variant: 'secondary', label: 'Declined' },
  CLOSED:    { variant: 'secondary', label: 'Closed' },
};

// The supplier side of the same states: whose move it is, from their seat.
const SUPPLIER_PILLS: PillMap = {
  PENDING:   { variant: 'warning',   label: 'New request — your move' },
  RESPONDED: { variant: 'accent',    label: 'Awaiting buyer' },
  ACCEPTED:  { variant: 'success',   label: 'Accepted by buyer' },
  DECLINED:  { variant: 'secondary', label: 'Declined by buyer' },
  CLOSED:    { variant: 'secondary', label: 'Closed' },
};

// RESPONDED only says the supplier answered at some point. When the buyer
// wrote last, the next move is the supplier's.
const BUYER_FOLLOWED_UP: Record<Props['viewerRole'], PillMap['RESPONDED']> = {
  BUYER:  { variant: 'warning', label: 'Waiting for supplier' },
  SELLER: { variant: 'warning', label: 'Buyer replied — your move' },
  ADMIN:  { variant: 'warning', label: 'Buyer replied — your move' },
};

function StatusPill({
  status,
  viewerRole,
  lastFromBuyer,
}: {
  status: Props['status'];
  viewerRole: Props['viewerRole'];
  lastFromBuyer: boolean;
}) {
  const m =
    status === 'RESPONDED' && lastFromBuyer
      ? BUYER_FOLLOWED_UP[viewerRole]
      : (viewerRole === 'BUYER' ? BUYER_PILLS : SUPPLIER_PILLS)[status];
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
    ? 'bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800'
    : 'bg-muted text-muted-foreground border border-border';
  return (
    <div className={`h-8 w-8 rounded-full inline-flex items-center justify-center text-[11px] font-bold flex-shrink-0 shadow-sm ${palette}`}>
      {supplier && !mine ? <ShieldCheck className="h-3.5 w-3.5" /> : initials}
    </div>
  );
}

function MessageBubble({ m, buyerName }: { m: Message; buyerName: string }) {
  // Shield styling marks the lab2date side (staff or the assigned seller), from
  // the message's own flag — never from the display name.
  const isSupplier = !m.isMine && !!m.fromStaff;
  const ts = new Date(m.createdAt);
  if (m.isInternalNote) {
    return (
      <div className="mx-auto w-full max-w-[92%] rounded-2xl px-4 py-2.5 text-sm shadow-sm bg-amber-50 border border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-300">
        <p className="text-[10px] font-bold uppercase tracking-wider opacity-80 mb-1">
          Internal note · {m.isMine ? 'You' : (m.authorName ?? 'staff')} · never shown to the buyer ·{' '}
          {ts.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </p>
        <p dir="auto" className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">{m.body}</p>
        <MessageAttachments urls={m.attachments ?? []} />
      </div>
    );
  }
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
          dir="auto"
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] shadow-sm ${
            m.isMine
              ? 'bg-primary text-primary-foreground rounded-tr-sm'
              : isSupplier
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-950 rounded-tl-sm dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-300'
              : 'bg-card border border-border rounded-tl-sm'
          }`}
        >
          {m.body}
          <MessageAttachments urls={m.attachments ?? []} />
        </div>
      </div>
    </div>
  );
}

function EmptyConversation({ status, viewerRole }: { status: Props['status']; viewerRole: Props['viewerRole'] }) {
  const forBuyer = viewerRole === 'BUYER';
  return (
    <div className="text-center py-10">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-3">
        <MessageCircle className="h-6 w-6" />
      </div>
      <p className="text-sm font-bold">
        {status !== 'PENDING'
          ? 'The conversation will appear here'
          : forBuyer
            ? 'Your request is with the supplier'
            : 'New request — nothing sent yet'}
      </p>
      <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
        {status !== 'PENDING'
          ? 'Once either side sends a message it\'ll show up here in real time.'
          : forBuyer
            ? 'You\'ll get an email + notification as soon as the supplier replies or sends you an offer.'
            : 'Reply with questions or send an offer below. The buyer is emailed as soon as you respond.'}
      </p>
    </div>
  );
}
