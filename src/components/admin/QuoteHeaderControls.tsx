'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CopyPlus } from 'lucide-react';
import {
  setQuotePriority,
  setQuoteStatus,
  archiveQuote,
  unarchiveQuote,
  cloneQuoteForBuyer,
} from '@/lib/quotes/actions';
import { closeConfirmText } from '@/components/quotes/quote-view';

const PRIORITIES = ['VIP', 'URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;

/**
 * Admin quote hero controls: priority (drives the SLA and the VIP/Urgent
 * queue filter), close-without-deal (in-page dialog with a reason the buyer
 * sees), a new quote for the same buyer once this one is over, and archive.
 * Each control shows only with the permission its action needs, so staff are
 * never sent to a "forbidden" page. Claim/transfer live in the AssigneeBadge.
 */
export function QuoteHeaderControls({
  quoteId,
  priority,
  archived,
  canClose,
  closeReasons,
  autoArchive,
  hasOpenOffer,
  canSetPriority,
  canArchive,
  canClone,
}: {
  quoteId: string;
  priority: string;
  archived: boolean;
  /** False once the deal is decided (closed/declined, or its order is paid) or without quotes:status. */
  canClose: boolean;
  /** Settings → Quotes & offers → close reasons (QUOTE_CLOSE_REASONS). */
  closeReasons: string[];
  /** QUOTE_AUTO_ARCHIVE_ON_CLOSE: a closed request goes to Archived instead of Lost. */
  autoArchive: boolean;
  hasOpenOffer: boolean;
  /** quotes:status */
  canSetPriority: boolean;
  /** quotes:archive */
  canArchive: boolean;
  /** Closed, or its order was canceled — and quotes:proforma: “New quote for this buyer”. */
  canClone?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  function call(fn: () => Promise<{ ok: boolean; message: string }>) {
    setMsg(null);
    start(async () => {
      try {
        const r = await fn();
        setMsg({ ok: r.ok, text: r.message });
        router.refresh();
      } catch {
        setMsg({ ok: false, text: 'That did not work. Reload the page and try again.' });
      }
    });
  }

  const reasonRequired = closeReasons.length > 0;
  function close() {
    if (reasonRequired && !reason) {
      setMsg({ ok: false, text: 'Choose the reason — the buyer sees it.' });
      return;
    }
    call(async () => {
      const r = await setQuoteStatus(quoteId, 'CLOSED', { reason: reason || null, note: note.trim() || null });
      // The action's message says what happened (order canceled, unit
      // released, buyer notified, archived when the setting says so).
      if (r?.error) return { ok: false, message: r.error };
      setClosing(false);
      setReason('');
      setNote('');
      return { ok: true, message: r?.warning ?? r?.notice ?? 'Request closed.' };
    });
  }

  function cloneForBuyer() {
    setMsg(null);
    start(async () => {
      try {
        const r = await cloneQuoteForBuyer(quoteId);
        if (r?.error) { setMsg({ ok: false, text: r.error }); return; }
        setMsg({ ok: true, text: r?.notice ?? 'New quote opened.' });
        if (r?.sourcingRequestId) router.push(`/admin/quotes/${r.sourcingRequestId}`);
        else router.refresh();
      } catch {
        setMsg({ ok: false, text: 'That did not work. Reload the page and try again.' });
      }
    });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap justify-end min-w-0 max-w-full">
      <label className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
        Priority
        <select
          value={priority}
          onChange={(e) => {
            const fd = new FormData();
            fd.set('quoteId', quoteId);
            fd.set('priority', e.target.value);
            call(() => setQuotePriority(fd));
          }}
          disabled={pending || !canSetPriority}
          title={canSetPriority ? undefined : 'Changing the priority needs the “Decline, close or reopen quotes” permission (quotes:status).'}
          className="h-9 px-2 rounded-md border border-input bg-background text-xs font-bold text-foreground disabled:opacity-60"
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </label>

      {canClose && !closing && (
        <button
          type="button"
          disabled={pending}
          onClick={() => { setMsg(null); setClosing(true); }}
          className="inline-flex items-center gap-1 h-9 px-3 rounded-md border border-red-300 text-red-700 dark:border-red-800 dark:text-red-300 bg-background text-xs font-semibold hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
        >
          Close (no deal)
        </button>
      )}

      {canClone && (
        <button
          type="button"
          disabled={pending}
          onClick={cloneForBuyer}
          className="inline-flex items-center gap-1 h-9 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-foreground/5 disabled:opacity-50"
          data-testid="quote-clone"
        >
          <CopyPlus className="h-3.5 w-3.5" /> New quote for this buyer
        </button>
      )}

      {canArchive && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            const fd = new FormData();
            fd.set('quoteId', quoteId);
            call(() => (archived ? unarchiveQuote(fd) : archiveQuote(fd)));
          }}
          className="inline-flex items-center gap-1 h-9 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-foreground/5 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {archived ? 'Restore' : 'Archive'}
        </button>
      )}

      {closing && (
        <div role="dialog" aria-label="Close without a deal" className="basis-full w-full max-w-md ml-auto rounded-xl border-2 border-red-300 dark:border-red-800 bg-background p-3 space-y-2 text-left" data-testid="quote-close-dialog">
          <p className="text-sm font-bold">Close this request without a deal?</p>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{closeConfirmText({ autoArchive, hasOpenOffer })}</p>
          {reasonRequired && (
            <label className="block">
              <span className="block text-xs font-semibold mb-1">Reason <span className="font-normal text-muted-foreground">(the buyer sees it)</span></span>
              <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm" data-testid="quote-close-reason">
                <option value="">— choose —</option>
                {closeReasons.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          )}
          <label className="block">
            <span className="block text-xs font-semibold mb-1">Note to the buyer <span className="font-normal text-muted-foreground">({reasonRequired ? 'optional' : 'what happened — the buyer reads it'})</span></span>
            <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 1000))} rows={2} dir="auto" className="w-full px-2 py-1.5 rounded-md border border-input bg-background text-sm" />
          </label>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              disabled={pending || (reasonRequired && !reason)}
              onClick={close}
              className="inline-flex items-center gap-1 h-8 px-3 rounded-full bg-red-700 text-white text-xs font-semibold hover:bg-red-800 disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Close the request
            </button>
            <button type="button" disabled={pending} onClick={() => setClosing(false)} className="h-8 px-3 rounded-full border border-border text-xs font-semibold">
              Keep it open
            </button>
          </div>
        </div>
      )}

      {msg && (
        <span
          role="status"
          className={`basis-full max-w-md ml-auto text-right text-[11px] break-words [overflow-wrap:anywhere] ${
            msg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
          }`}
        >
          {msg.text}
        </span>
      )}
    </div>
  );
}
