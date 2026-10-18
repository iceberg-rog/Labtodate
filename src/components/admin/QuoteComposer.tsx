'use client';

import { useState, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Send, Lock, Mail, EyeOff, ChevronUp, ChevronDown, Paperclip, X, FileText } from 'lucide-react';
import { replyToQuote, type QuoteActionResult } from '@/lib/quotes/actions';
import { OfferForm, type OfferFormProps } from '@/components/quotes/OfferForm';

type Mode = 'reply' | 'internal' | 'offer';
type Att = { url: string; name: string; type: string };

/**
 * Admin quote composer: reply to the buyer, internal note, or send / update
 * the OFFER. Every outcome message is the one the server action returned —
 * "Offer sent…", "Offer saved, but the email to x could not be delivered…",
 * or a readable refusal — never a generic "Not sent" for an action that
 * actually went through. Tabs show only with the permission their action
 * needs (quotes:reply for replies and notes, quotes:proforma for offers), so
 * staff are never sent to a "forbidden" page after typing.
 */
export function QuoteComposer({
  quoteId,
  buyerEmail,
  offer,
  priceLocked,
  canReply = true,
  canSendOffer = true,
  quotationHref = null,
}: {
  quoteId: string;
  buyerEmail: string;
  /** Offer composer props; null = the offer tab is hidden. */
  offer: Omit<OfferFormProps, 'quoteId' | 'onResult'> | null;
  /** Set once the buyer accepted: why the price can no longer change. */
  priceLocked?: string | null;
  /** quotes:reply — replies to the buyer and internal notes. */
  canReply?: boolean;
  /** quotes:proforma — send / update the offer. */
  canSendOffer?: boolean;
  /** The current revision's quotation PDF (what the buyer was sent). */
  quotationHref?: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(canReply ? 'reply' : 'offer');
  const [open, setOpen] = useState(false);   // start COLLAPSED — workspace is conversation-first
  const [pending, start] = useTransition();
  const [body, setBody] = useState('');
  const [atts, setAtts] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Last outcome — stays visible on the collapsed bar too.
  const [outcome, setOutcome] = useState<QuoteActionResult | null>(null);
  const offerExists = !!offer || !!priceLocked;
  const canOffer = canSendOffer && offerExists;
  const missing = [
    !canReply ? 'replying and internal notes need the “Reply on quote threads” permission (quotes:reply)' : '',
    !canSendOffer && offerExists ? 'sending offers needs the “Send offers / proformas” permission (quotes:proforma)' : '',
  ].filter(Boolean);
  const missingNote = missing.length ? `Your role can not do everything here: ${missing.join('; ')}.` : null;

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setErr(null);
    setUploading(true);
    try {
      for (const f of files) {
        if (atts.length >= 5) break;
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/attachment-upload', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setErr(data.error || 'Upload failed.'); continue; }
        if (data.url) setAtts((p) => p.length < 5 ? [...p, { url: data.url, name: data.name ?? 'file', type: data.type ?? '' }] : p);
      }
    } finally {
      setUploading(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOutcome(null);
    start(async () => {
      try {
        if (body.trim().length < 2) { setErr('Message too short.'); return; }
        const internal = mode === 'internal';
        // Built as a value first: a server that does not store the names yet drops them.
        const input = {
          sourcingRequestId: quoteId,
          body: body.trim(),
          attachments: atts.map((a) => a.url),
          attachmentNames: atts.map((a) => a.name),
          internal,
        };
        const r = await replyToQuote(input);
        if (r?.error) { setErr(r.error); return; }
        setBody(''); setAtts([]);
        setOutcome(r?.warning ? { warning: r.warning } : { notice: internal ? 'Internal note posted.' : `Reply sent to ${buyerEmail}.` });
        setOpen(false);
        router.refresh();
      } catch (e2) {
        if ((e2 as Error)?.message?.includes('NEXT_REDIRECT')) return;
        // Only reached when the request itself failed (network / server error).
        setErr('The request failed before the server answered. Reload the page to check whether your message was saved, then try again.');
      }
    });
  }

  const isInternal = mode === 'internal';
  const isOffer = mode === 'offer';
  const outcomeBox = outcome && (outcome.error || outcome.warning || outcome.notice) ? (
    <p
      role={outcome.error ? 'alert' : 'status'}
      className={
        outcome.error
          ? 'text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-md px-3 py-2'
          : outcome.warning
          ? 'text-xs text-amber-900 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded-md px-3 py-2'
          : 'text-xs text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-md px-3 py-2'
      }
    >
      {outcome.error ?? outcome.warning ?? outcome.notice}
    </p>
  ) : null;

  const quotationLink = quotationHref ? (
    <a href={quotationHref} className="inline-flex items-center gap-1 h-7 px-3 rounded-full border border-border bg-card text-[11px] font-semibold hover:bg-foreground/5" data-testid="composer-quotation-pdf">
      <FileText className="h-3 w-3" /> Download quotation (PDF)
    </a>
  ) : null;

  // Nothing this role may do here: say so instead of offering dead tabs.
  if (!canReply && !canOffer) {
    return (
      <div className="rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground space-y-2" data-testid="composer-view-only">
        <p><Lock className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />View only. {missingNote}</p>
        {quotationLink}
      </div>
    );
  }

  // COLLAPSED: a calm bar with quick-reply prompts. Click expands the full composer.
  if (!open) {
    return (
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        {canReply && (
          <button
            type="button"
            onClick={() => { setMode('reply'); setOpen(true); }}
            className="w-full p-3 text-left text-sm text-muted-foreground inline-flex items-center gap-3 hover:bg-foreground/[0.03] transition min-w-0"
          >
            <span className="h-7 w-7 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center shrink-0">
              <Mail className="h-3.5 w-3.5" />
            </span>
            <span className="flex-1 min-w-0 truncate">Reply to {buyerEmail}…</span>
            <ChevronUp className="h-4 w-4 opacity-50" />
          </button>
        )}
        {outcomeBox && <div className="px-3 pb-2">{outcomeBox}</div>}
        <div className={`px-3 pb-3 flex items-center gap-2 flex-wrap ${canReply ? '' : 'pt-3'}`}>
          {canReply && (
            <button
              type="button"
              onClick={() => { setMode('internal'); setOpen(true); }}
              className="inline-flex items-center gap-1 h-7 px-3 rounded-full border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 text-[11px] font-bold hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              <Lock className="h-3 w-3" /> Internal note
            </button>
          )}
          {canOffer && (
            <button
              type="button"
              onClick={() => { setMode('offer'); setOpen(true); }}
              className="inline-flex items-center gap-1 h-7 px-3 rounded-full bg-accent text-accent-foreground text-[11px] font-bold hover:bg-accent/90"
            >
              {priceLocked ? <Lock className="h-3 w-3" /> : <Send className="h-3 w-3" />} {priceLocked ? 'Offer · price locked' : offer?.current ? 'Update offer' : 'Send offer'}
            </button>
          )}
          {quotationLink}
        </div>
        {missingNote && <p className="px-3 pb-3 text-[11px] text-muted-foreground">{missingNote}</p>}
      </div>
    );
  }

  return (
    <section
      className={
        isInternal
          ? 'rounded-2xl border-2 border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 overflow-hidden'
          : isOffer
          ? 'rounded-2xl border-2 border-accent/40 bg-accent/[0.06] overflow-hidden'
          : 'rounded-2xl border-2 border-primary/40 bg-card overflow-hidden'
      }
    >
      <div className={`grid ${canReply && canOffer ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]' : canReply ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]'} border-b border-border`}>
        {canReply && <ModeTab active={mode === 'reply'} onClick={() => setMode('reply')} tone="primary" icon={<Mail className="h-4 w-4" />} label="Reply to buyer" />}
        {canReply && <ModeTab active={isInternal} onClick={() => setMode('internal')} tone="amber" icon={<Lock className="h-4 w-4" />} label="Internal note" />}
        {canOffer && (
          <ModeTab active={isOffer} onClick={() => setMode('offer')} tone="accent" icon={priceLocked ? <Lock className="h-4 w-4" /> : <Send className="h-4 w-4" />} label={priceLocked ? 'Offer (locked)' : offer?.current ? 'Update offer' : 'Offer'} />
        )}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-4 text-muted-foreground hover:text-foreground inline-flex items-center"
          aria-label="Collapse composer"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      <div
        className={
          isInternal
            ? 'px-5 py-2.5 bg-amber-100/80 dark:bg-amber-900/40 border-b border-amber-200 dark:border-amber-800 inline-flex items-center gap-2 w-full'
            : isOffer
            ? 'px-5 py-2.5 bg-accent/[0.10] border-b border-accent/20 inline-flex items-center gap-2 w-full'
            : 'px-5 py-2.5 bg-primary/5 border-b border-primary/15 inline-flex items-center gap-2 w-full'
        }
      >
        {isInternal ? (
          <>
            <EyeOff className="h-3.5 w-3.5 text-amber-800 dark:text-amber-300 shrink-0" />
            <p className="text-[11px] font-semibold text-amber-900 dark:text-amber-300">Team-only — never emailed, never shown to {buyerEmail}.</p>
          </>
        ) : isOffer ? (
          <p className="text-[11px] font-semibold text-foreground">
            {priceLocked
              ? 'The buyer accepted this offer — its price can no longer be changed.'
              : `Sends ${buyerEmail} an offer to accept or decline. The order and the proforma invoice are created only when the buyer accepts.`}
          </p>
        ) : (
          <>
            <Mail className="h-3.5 w-3.5 text-primary shrink-0" />
            <p className="text-[11px] font-semibold text-primary">Emailed and shown to {buyerEmail}.</p>
          </>
        )}
      </div>

      {isOffer ? (
        <div className="p-5 space-y-3">
          {quotationLink}
          {priceLocked ? (
            <>
              {/* The page may have refreshed into the locked state right as a
                  price update was refused — keep that answer on screen. */}
              {outcome?.error && (
                <p role="alert" className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-md px-3 py-2">{outcome.error}</p>
              )}
              <p role="status" className="text-sm rounded-lg border border-border bg-muted px-3 py-2 inline-flex items-start gap-2">
                <Lock className="h-4 w-4 mt-0.5 shrink-0" /> {priceLocked}
              </p>
            </>
          ) : offer ? (
            <OfferForm quoteId={quoteId} {...offer} onResult={setOutcome} />
          ) : null}
          {missingNote && <p className="text-[11px] text-muted-foreground">{missingNote}</p>}
        </div>
      ) : (
      <form onSubmit={submit} className="p-5 space-y-3">
            {atts.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {atts.map((a, i) => (
                  <span key={a.url} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs">
                    <Paperclip className="h-3 w-3" />
                    <span className="max-w-[160px] truncate">{a.name}</span>
                    <button type="button" onClick={() => setAtts((p) => p.filter((_, j) => j !== i))} aria-label="Remove attachment">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={body} onChange={(e) => setBody(e.target.value.slice(0, 4000))}
              rows={4} required minLength={2}
              maxLength={4000} dir="auto"
              placeholder={isInternal ? 'Add an internal note — triage, hand-off, mention a teammate…' : 'Write a reply the buyer will see…'}
              className={
                isInternal
                  ? 'w-full px-3 py-2.5 rounded-lg border-2 border-amber-300 dark:border-amber-800 bg-white dark:bg-transparent text-sm resize-y focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-500'
                  : 'w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary'
              }
            />
            <div className="text-right text-[10px] text-muted-foreground tabular-nums">
              <span className={body.length > 3800 ? 'text-amber-600 dark:text-amber-400 font-semibold' : ''}>{body.length} / 4000</span>
            </div>

        {err && <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-md px-3 py-2 [overflow-wrap:anywhere]">{err}</p>}
        {missingNote && <p className="text-[11px] text-muted-foreground">{missingNote}</p>}

        <div className="flex items-center gap-2 flex-wrap">
          <label
              className="flex-shrink-0 h-10 w-10 rounded-lg border border-input bg-background flex items-center justify-center cursor-pointer hover:bg-muted"
              title="Attach image or PDF"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <Paperclip className="h-4 w-4 text-muted-foreground" />}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
                multiple
                className="hidden"
                onChange={onFiles}
                disabled={uploading || atts.length >= 5}
              />
            </label>
          <span className="flex-1" />
          <button
            type="submit"
            disabled={pending}
            className={
              isInternal
                ? 'rounded-full bg-amber-500 hover:bg-amber-600 text-amber-950 px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2 shadow-sm'
                : 'rounded-full bg-primary hover:bg-primary/90 text-primary-foreground px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2 shadow-sm'
            }
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" />
              : isInternal ? <><Lock className="h-4 w-4" /> Post internal note</>
              : <><Send className="h-4 w-4" /> Send reply</>}
          </button>
        </div>
      </form>
      )}
    </section>
  );
}

function ModeTab({
  active, onClick, tone, icon, label,
}: {
  active: boolean;
  onClick: () => void;
  tone: 'primary' | 'amber' | 'accent';
  icon: JSX.Element;
  label: string;
}) {
  const activeCls =
    tone === 'amber' ? 'bg-amber-500 text-amber-950'
      : tone === 'accent' ? 'bg-accent text-accent-foreground'
      : 'bg-primary text-primary-foreground';
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? `px-4 py-3 ${activeCls} font-bold text-sm inline-flex items-center justify-center gap-2`
          : 'px-4 py-3 bg-foreground/5 text-muted-foreground hover:bg-foreground/10 font-semibold text-sm inline-flex items-center justify-center gap-2'
      }
    >
      {icon}{label}
    </button>
  );
}
