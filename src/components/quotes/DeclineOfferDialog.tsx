'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, X } from 'lucide-react';
import { declineOffer } from '@/lib/quotes/actions';

/**
 * In-page decline confirmation (no browser popup) with an optional reason
 * (Settings → Quotes & offers → decline reasons) and note, so we learn why.
 * It declines the revision the buyer is looking at: when a newer offer was
 * sent meanwhile the server refuses, so a better offer is never declined unseen.
 */
export function DeclineOfferDialog({
  quoteId,
  revision,
  reasons,
  onCancel,
  onDone,
}: {
  quoteId: string;
  /** The offer revision on screen (0 = a legacy offer without revisions). */
  revision: number;
  reasons: string[];
  onCancel: () => void;
  onDone: (notice: string) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    start(async () => {
      try {
        const r = await declineOffer({
          sourcingRequestId: quoteId,
          reason: reason || null,
          note: note.trim() || null,
          offerRevision: revision > 0 ? revision : null,
        });
        // Refused (e.g. the offer was just updated): show it and load the current offer.
        if (r?.error) { setError(r.error); router.refresh(); return; }
        onDone(r?.notice ?? 'You declined the offer.');
        router.refresh();
      } catch {
        setError('That did not work — the request failed. Reload the page and try again.');
      }
    });
  }

  return (
    <div role="alertdialog" aria-label="Decline the offer" className="mt-5 rounded-xl border-2 border-red-300 dark:border-red-800 bg-background p-4 space-y-3 min-w-0" data-testid="decline-dialog">
      <p className="font-bold">Decline this offer?</p>
      <p className="text-sm text-muted-foreground">The offer can no longer be accepted afterwards. You can always open a new request later.</p>
      <label className="block">
        <span className="block text-xs font-semibold mb-1">Reason <span className="font-normal text-muted-foreground">(optional — helps us make a better offer)</span></span>
        <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full sm:w-auto max-w-full h-10 px-2 rounded-lg border border-input bg-background text-sm">
          <option value="">— no reason —</option>
          {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="block text-xs font-semibold mb-1">Note <span className="font-normal text-muted-foreground">(optional, e.g. a competing price)</span></span>
        <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 1000))} rows={2} dir="auto" className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm" />
      </label>
      {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 dark:text-red-300 dark:bg-red-950/40 dark:border-red-800 [overflow-wrap:anywhere]">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={submit} disabled={pending} className="inline-flex items-center gap-1.5 rounded-full bg-red-700 text-white px-5 py-2.5 text-sm font-semibold hover:bg-red-800 disabled:opacity-60">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Decline the offer
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className="inline-flex items-center rounded-full border border-border px-5 py-2.5 text-sm font-semibold hover:bg-foreground/5 disabled:opacity-60">
          Keep the offer
        </button>
      </div>
    </div>
  );
}
