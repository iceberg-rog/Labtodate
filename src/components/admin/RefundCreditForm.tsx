'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Undo2 } from 'lucide-react';
import { previewCreditAction } from '@/app/admin/finance-actions';
import { createRefundAction } from '@/app/admin/fulfilment-actions';
import { announceAdminResult } from './AdminResultToast';

const input = 'w-full h-9 px-2 rounded-md border border-input bg-background text-sm';
const label = 'block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1';

/**
 * Refund / credit form (admin order page, “Money back”): the amount to credit
 * incl. VAT (default: everything that can still be credited / refunded), the
 * reason (from Settings → Returns & refunds, printed on the credit note), how
 * the money goes back, the buyer's IBAN, a justification when goods shipped
 * without a return, and — only before anything shipped, when the order took
 * stock — whether the unit(s) go back. A live line shows what will really
 * happen before the confirmation: the exact credit note (VAT per rate), the
 * unpaid part that is canceled, and the money that goes back. Posts to THE
 * refund / credit core (fulfilment-actions → lib/finance/refunds.ts).
 */
export function RefundCreditForm(p: {
  orderId: string;
  orderNumber: string;
  defaultAmount: string;
  currency: string;
  hasInvoice: boolean;
  reasons: string[];
  /** Money can go back (something was received and not refunded yet). */
  moneyBack: boolean;
  canCard: boolean;
  needsJustification: boolean;
  /** null = no restock choice (shipped, already restocked, or the order never took stock). */
  restockDefault: boolean | null;
  restockHint: string;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(p.defaultAmount);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [method, setMethod] = useState(p.canCard ? 'STRIPE' : 'BANK_TRANSFER');
  const [iban, setIban] = useState('');
  const [justification, setJustification] = useState('');
  // Default: back in stock only when the whole remaining amount is credited (a
  // cancellation); a part amount is usually a price adjustment — the unit stays sold.
  const [restockTouched, setRestockTouched] = useState(false);
  const [restockChoice, setRestockChoice] = useState<boolean>(p.restockDefault ?? false);
  const restock = restockTouched ? restockChoice : !!p.restockDefault && amount.trim() === p.defaultAmount;
  const [preview, setPreview] = useState<{ ok: boolean; message: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  const fullReason = reason === 'Other' ? details.trim() : [reason, details.trim()].filter(Boolean).join(' — ');

  useEffect(() => {
    const t = setTimeout(() => {
      previewCreditAction(p.orderId, amount, p.moneyBack ? method : undefined).then(setPreview).catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [amount, method, p.orderId, p.moneyBack]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!window.confirm(`${p.hasInvoice ? 'Issue the credit note and record the refund' : 'Record the refund'} for order ${p.orderNumber}?\n\n${preview?.message ?? ''}\n\nCredit notes are final (a mistake is corrected with another document). The buyer is e-mailed.`)) return;
    setResult(null);
    const fd = new FormData();
    fd.set('orderId', p.orderId);
    fd.set('amount', amount);
    fd.set('reason', reason);
    fd.set('reasonOther', details);
    if (p.moneyBack) {
      fd.set('method', method);
      fd.set('payeeIban', iban);
    }
    if (p.needsJustification) fd.set('justification', justification);
    if (p.restockDefault !== null) fd.set('restock', restock ? 'on' : 'off');
    start(async () => {
      try {
        const r = await createRefundAction(fd);
        setResult(r);
        if (r.ok) {
          announceAdminResult(r);
          setReason('');
          setDetails('');
          setJustification('');
          router.refresh();
        }
      } catch {
        setResult({ ok: false, message: 'The request failed — reload the page to check the order before trying again.' });
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-sm" data-testid="refund-credit-form">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={label}>Amount incl. VAT ({p.currency}) *</span>
          <input name="amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required className={`${input} tabular-nums`} />
        </label>
        <label className="block">
          <span className={label}>Reason *</span>
          <select name="reason" required value={reason} onChange={(e) => setReason(e.target.value)} className={input}>
            <option value="">Choose…</option>
            {p.reasons.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className={label}>Details (printed on the credit note{reason === 'Other' ? ' — required for “Other”' : ''})</span>
          <input name="reasonOther" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={200} placeholder="e.g. Unit returned — defective pump / price adjustment agreed" className={input} />
        </label>
        {p.moneyBack && (
          <>
            <label className="block">
              <span className={label}>Refund by</span>
              <select name="method" value={method} onChange={(e) => setMethod(e.target.value)} className={input}>
                {p.canCard && <option value="STRIPE">The original card (Stripe refund now)</option>}
                <option value="BANK_TRANSFER">Bank transfer (you send it, then mark it sent)</option>
                <option value="OTHER">Other (explain in the details)</option>
              </select>
            </label>
            <label className="block">
              <span className={label}>Buyer’s IBAN (optional now)</span>
              <input name="payeeIban" value={iban} onChange={(e) => setIban(e.target.value)} placeholder="NL91 ABNA 0417 1643 00" className={`${input} font-mono`} />
            </label>
          </>
        )}
        {p.needsJustification && (
          <label className="block sm:col-span-2">
            <span className={label}>Why money without a return? (required after shipping, audited)</span>
            <input name="justification" value={justification} onChange={(e) => setJustification(e.target.value)} minLength={10} maxLength={500} placeholder="e.g. agreed price reduction for a cosmetic scratch — buyer keeps the unit" className={input} />
          </label>
        )}
      </div>
      {p.restockDefault !== null && (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" name="restockBox" checked={restock} onChange={(e) => { setRestockTouched(true); setRestockChoice(e.target.checked); }} className="mt-0.5" />
          <span>Put the unit(s) back in stock <span className="text-muted-foreground">— {p.restockHint}</span></span>
        </label>
      )}
      {preview?.message ? (
        <p className={`text-xs rounded-md px-3 py-2 border ${preview.ok ? 'border-border bg-foreground/[0.03]' : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'}`} data-testid="refund-preview">
          {preview.message}
        </p>
      ) : null}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="submit"
          disabled={pending || fullReason.length < 4 || preview?.ok === false || (p.needsJustification && justification.trim().length < 10)}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40 text-xs font-bold disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
          {p.hasInvoice ? 'Issue credit note & record refund' : 'Record refund'}
        </button>
        <span className="text-[11px] text-muted-foreground">A part amount credits part of the invoice (e.g. a price adjustment); the full amount credits all of it.</span>
      </div>
      {result && !result.ok && (
        <p role="alert" className="text-xs font-semibold text-red-700 dark:text-red-300">{result.message}</p>
      )}
    </form>
  );
}
