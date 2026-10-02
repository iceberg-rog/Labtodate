'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import {
  setQuotePriority,
  setQuoteStatus,
  archiveQuote,
  unarchiveQuote,
} from '@/lib/quotes/actions';

const PRIORITIES = ['VIP', 'URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;

/**
 * Admin quote hero controls: priority (drives the SLA and the VIP/Urgent
 * queue filter), close-without-deal and archive. Claim/transfer live in the
 * AssigneeBadge next to it.
 */
export function QuoteHeaderControls({
  quoteId,
  priority,
  archived,
  canClose,
}: {
  quoteId: string;
  priority: string;
  archived: boolean;
  /** False once the deal is decided (closed/declined, or its order is paid). */
  canClose: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
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
          disabled={pending}
          className="h-9 px-2 rounded-md border border-input bg-background text-xs font-bold text-foreground disabled:opacity-60"
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </label>

      {canClose && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            // Same wording as the supplier's "Close request" — plus the archive.
            if (
              !window.confirm(
                "Close this request without a deal? The buyer's unpaid order (if any) is canceled, the buyer (and the assigned supplier) are notified, and the request is archived and cannot be reopened.",
              )
            ) {
              return;
            }
            call(async () => {
              const r = await setQuoteStatus(quoteId, 'CLOSED');
              // The action's notice names the canceled order and the buyer
              // notice ("Request closed. Order … was canceled. The buyer was
              // notified."); closing also archives a quote that wasn't yet.
              if (r?.error) return { ok: false, message: r.error };
              const archivedNote = archived ? '' : ' The request was archived.';
              return { ok: true, message: `${r?.notice ?? 'Request closed.'}${archivedNote}` };
            });
          }}
          className="inline-flex items-center gap-1 h-9 px-3 rounded-md border border-red-300 text-red-700 dark:border-red-800 dark:text-red-300 bg-background text-xs font-semibold hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
        >
          Close (no deal)
        </button>
      )}

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
      {msg && (
        <span
          role="status"
          className={`basis-full text-right text-[11px] ${
            msg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
          }`}
        >
          {msg.text}
        </span>
      )}
    </div>
  );
}
