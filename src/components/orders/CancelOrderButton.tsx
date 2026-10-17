'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, XCircle } from 'lucide-react';
import { buyerCancelUnpaidOrder } from '@/app/app/orders/[orderNumber]/payment/actions';

/**
 * Buyer "Cancel order" for an unpaid order (accepted quote or checkout) — an in-page
 * confirmation with a reason (Settings → Quotes & offers → cancel reasons).
 * The outcome (incl. whether the confirmation email went out) is shown as the
 * server reported it.
 */
export function CancelOrderButton({ orderNumber, reasons, compact = false, kind = 'quote' }: { orderNumber: string; reasons: string[]; compact?: boolean; kind?: 'quote' | 'checkout' }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (done) {
    return <p role="status" className="basis-full text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800">{done}</p>;
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setError(null); setOpen(true); }}
        className={`inline-flex items-center gap-1.5 rounded-full border border-red-300 text-red-700 dark:border-red-800 dark:text-red-300 bg-background font-semibold hover:bg-red-50 dark:hover:bg-red-950/40 ${compact ? 'px-4 py-2 text-xs' : 'px-5 py-2.5 text-sm'}`}
        data-testid="cancel-order-open"
      >
        <XCircle className="h-4 w-4" /> Cancel order
      </button>
    );
  }
  function submit() {
    if (!reason) { setError('Choose a reason.'); return; }
    setError(null);
    start(async () => {
      try {
        const r = await buyerCancelUnpaidOrder({ orderNumber, reason, note: note.trim() || null });
        if (r.error) { setError(r.error); return; }
        const msg = r.notice ?? r.warning ?? 'Order canceled.';
        setDone(msg);
        // The cancel control disappears with the unpaid state: the order page
        // shows the outcome as a fixed confirmation (?flash=…) instead.
        router.replace(`/app/orders/${orderNumber}?flash=${/emailed you/.test(msg) ? 'canceled' : 'canceled-nomail'}`);
        router.refresh();
      } catch {
        setError('That did not work — the request failed. Reload the page to check the order, then try again.');
      }
    });
  }
  return (
    <div role="alertdialog" aria-label="Cancel the order" className="basis-full w-full rounded-xl border-2 border-red-300 dark:border-red-800 bg-background p-4 space-y-3" data-testid="cancel-order-dialog">
      <p className="font-bold">Cancel order {orderNumber}?</p>
      <p className="text-sm text-muted-foreground">
        {kind === 'quote'
          ? 'The order and its proforma invoice are canceled — no payment is due — and the reserved item goes back on sale. This can not be undone; for the item again you would need a new offer.'
          : 'The order and its proforma invoice are canceled — no payment is due, nothing is charged — and the reserved item goes back on sale. This can not be undone; to buy it later you place a new order (if it is still available).'}
      </p>
      <label className="block">
        <span className="block text-xs font-semibold mb-1">Reason<span className="text-red-600"> *</span></span>
        <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full sm:w-auto h-10 px-2 rounded-lg border border-input bg-background text-sm">
          <option value="">Choose…</option>
          {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="block text-xs font-semibold mb-1">Note <span className="font-normal text-muted-foreground">(optional)</span></span>
        <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} rows={2} dir="auto" className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm" />
      </label>
      {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 dark:text-red-300 dark:bg-red-950/40 dark:border-red-800">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={submit} disabled={pending} className="inline-flex items-center gap-1.5 rounded-full bg-red-700 text-white px-5 py-2.5 text-sm font-semibold hover:bg-red-800 disabled:opacity-60" data-testid="cancel-order-confirm">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Yes, cancel the order
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={pending} className="inline-flex items-center rounded-full border border-border px-5 py-2.5 text-sm font-semibold hover:bg-foreground/5 disabled:opacity-60">
          Keep the order
        </button>
      </div>
    </div>
  );
}
