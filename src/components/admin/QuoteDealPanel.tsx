'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, XCircle, Undo2, ExternalLink } from 'lucide-react';
import { adminCancelQuoteOrder } from '@/app/admin/quote-payment-actions';
import { announceAdminResult } from './AdminResultToast';
import type { DealStage } from '@/components/quotes/quote-view';

export type { DealStage };

/**
 * Admin "Deal" panel on an accepted quote: what the order is, and the ONE
 * correct way to undo it at its current stage (owner report 6):
 *  unpaid → cancel (voids the proforma, releases the unit, emails the buyer);
 *  part paid → money is held: cancel & refund on the order page, never a plain cancel;
 *  receipt in review → verify / reject first (order page);
 *  on invoice terms, unpaid → cancel with a credit note;
 *  paid, not shipped → cancel & refund on the order page (credit note + refund ledger);
 *  shipped → return (RMA) / refund on the order page.
 */
export function QuoteDealPanel(p: {
  orderId: string;
  orderNumber: string;
  stage: DealStage;
  totalLabel: string;
  statusLabel: string;
  dueLabel: string | null;
  canRefund: boolean;
  /** "€2,825 received, €200 open" (PART_PAID). */
  receivedLabel?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function run() {
    setMsg(null);
    const fd = new FormData();
    fd.set('orderId', p.orderId);
    fd.set('reason', reason.trim());
    start(async () => {
      try {
        const r = await adminCancelQuoteOrder(fd);
        setMsg({ ok: r.ok, text: r.message });
        // The panel disappears once the deal is canceled / refunded: the result goes to the admin toast too.
        if (r.ok) { announceAdminResult(r); setOpen(null); setReason(''); router.refresh(); }
      } catch {
        setMsg({ ok: false, text: 'The request failed — reload the page to check the order, then try again.' });
      }
    });
  }

  const cancelable = p.stage === 'UNPAID' || p.stage === 'TERMS';
  return (
    <div className="space-y-2 text-[12px]" data-testid="quote-deal-panel">
      <p className="[overflow-wrap:anywhere]">
        <a href={`/admin/orders/${p.orderId}`} className="font-mono font-semibold hover:text-primary inline-flex items-center gap-1">{p.orderNumber} <ExternalLink className="h-3 w-3" /></a>
        <span className="text-muted-foreground"> · {p.statusLabel} · {p.totalLabel}</span>
      </p>
      {p.dueLabel && <p className="text-muted-foreground">{p.dueLabel}</p>}
      {p.stage === 'PART_PAID' && (
        <p className="text-amber-800 dark:text-amber-300" data-testid="quote-deal-part-paid">
          Part paid{p.receivedLabel ? `: ${p.receivedLabel}` : ''}. The money received must be refunded before the order can be canceled — use the order page.
        </p>
      )}
      {p.stage === 'PROOF' && <p className="text-amber-800 dark:text-amber-300">A payment receipt is waiting — verify or reject it on the order page before anything else.</p>}
      {(p.stage === 'CANCELED' || p.stage === 'REFUNDED') && <p className="text-muted-foreground">This deal is finished ({p.stage.toLowerCase()}).</p>}

      {open === null && (
        <div className="flex flex-wrap gap-2">
          {cancelable && (
            <button type="button" onClick={() => setOpen('cancel')} className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-red-300 text-red-700 dark:border-red-800 dark:text-red-300 font-semibold hover:bg-red-50 dark:hover:bg-red-950/40">
              <XCircle className="h-3.5 w-3.5" /> {p.stage === 'TERMS' ? 'Cancel order (credit note)' : 'Cancel order'}
            </button>
          )}
          {(p.stage === 'PAID' || p.stage === 'SHIPPED' || p.stage === 'PART_PAID') && p.canRefund && (
            <a href={`/admin/orders/${p.orderId}#money`} className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-red-300 text-red-700 dark:border-red-800 dark:text-red-300 font-semibold hover:bg-red-50 dark:hover:bg-red-950/40">
              <Undo2 className="h-3.5 w-3.5" /> {p.stage === 'SHIPPED' ? 'Return / refund (order page)' : 'Cancel & refund (order page)'}
            </a>
          )}
        </div>
      )}
      {open && (
        <div role="alertdialog" aria-label="Cancel the order" className="rounded-xl border-2 border-red-300 dark:border-red-800 p-3 space-y-2">
          <p className="font-bold">{`Cancel order ${p.orderNumber}?`}</p>
          <p className="text-muted-foreground">
            {p.stage === 'TERMS'
              ? 'The invoice is credited in full (credit note). Nothing paid: nothing is refunded — the credit note says the amount is no longer due. Part paid: that part is refunded (recorded as a refund to send) and the rest is no longer due. The order is canceled, the unit goes back to stock per the restock setting, and the buyer is emailed.'
              : 'The proforma becomes void (no payment due), the reserved unit goes back on sale, the quote moves to Lost and the buyer is emailed.'}
          </p>
          <input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 300))} placeholder="Reason (sent to the buyer)" className="w-full h-9 px-2 rounded-md border border-input bg-background" />
          <div className="flex gap-2 flex-wrap">
            <button type="button" disabled={pending || reason.trim().length < 4} onClick={() => run()} className="inline-flex items-center gap-1 h-8 px-3 rounded-full bg-red-700 text-white font-semibold hover:bg-red-800 disabled:opacity-50">
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Cancel the order
            </button>
            <button type="button" disabled={pending} onClick={() => setOpen(null)} className="h-8 px-3 rounded-full border border-border font-semibold">Back</button>
          </div>
        </div>
      )}
      {msg && <p role="status" className={msg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{msg.text}</p>}
    </div>
  );
}
