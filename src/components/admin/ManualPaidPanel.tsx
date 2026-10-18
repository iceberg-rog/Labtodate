'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X, CreditCard, Loader2, CheckCircle2, XCircle, Upload, FileText } from 'lucide-react';
import { markOrderPaidManually } from '@/app/admin/actions';
import { announceAdminResult } from './AdminResultToast';

/** Fired on window after an order was marked paid here — an open order quick
 *  view (mounted outside the list) re-fetches so it doesn't stay stale. */
export const ORDER_PAID_EVENT = 'admin:orderpaid';

type OpenDetail = { id: string; openCents?: number; currency?: string; receivedCents?: number; totalCents?: number };

/** Methods that are booked only with the receipt file (the server refuses without it). */
const PROOF_REQUIRED = ['BANK_TRANSFER', 'RECEIPT'];

/**
 * Modal for marking an order PAID without Stripe (Finance: finance:manage).
 * Receives orderId from a window CustomEvent (`admin:manualpaid`). On a part
 * paid order it records the remaining payment.
 */
export function ManualPaidPanel() {
  const router = useRouter();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [method, setMethod] = useState<'BANK_TRANSFER' | 'RECEIPT' | 'OTHER'>('BANK_TRANSFER');
  const [note, setNote] = useState('');
  // From the bank statement: the invoice prints the value date, and a short
  // payment is never booked as paid in full.
  const [amount, setAmount] = useState('');
  const [receivedAt, setReceivedAt] = useState('');
  const [bankRef, setBankRef] = useState('');
  const [ctx, setCtx] = useState<{ currency: string; receivedCents: number; totalCents: number | null }>({ currency: 'EUR', receivedCents: 0, totalCents: null });
  // The server asks for this tick when the value date is before the order date.
  const [askEarlier, setAskEarlier] = useState(false);
  const [confirmEarlier, setConfirmEarlier] = useState(false);

  useEffect(() => {
    function handler(e: Event) {
      const d = (e as CustomEvent<OpenDetail>).detail;
      const id = d?.id;
      if (!id) return;
      setOrderId(id);
      setRes(null);
      setFile(null);
      setMethod('BANK_TRANSFER');
      setNote('');
      setAmount(typeof d?.openCents === 'number' ? (d.openCents / 100).toFixed(2) : '');
      setReceivedAt(new Date().toISOString().slice(0, 10));
      setBankRef('');
      setCtx({ currency: d.currency || 'EUR', receivedCents: d.receivedCents ?? 0, totalCents: d.totalCents ?? null });
      setAskEarlier(false);
      setConfirmEarlier(false);
    }
    window.addEventListener('admin:manualpaid', handler);
    return () => window.removeEventListener('admin:manualpaid', handler);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) setOrderId(null);
    }
    if (orderId) {
      window.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [orderId, pending]);

  if (!orderId) return null;
  const proofRequired = PROOF_REQUIRED.includes(method);
  const restPayment = ctx.receivedCents > 0;
  const money = (c: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: ctx.currency }).format(c / 100);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setRes(null);
    const target = orderId!;
    const fd = new FormData();
    fd.set('orderId', target);
    fd.set('method', method);
    fd.set('note', note);
    fd.set('amount', amount);
    fd.set('receivedAt', receivedAt);
    fd.set('bankRef', bankRef);
    if (confirmEarlier) fd.set('confirmEarlierDate', 'on');
    if (file) fd.set('proof', file);
    start(async () => {
      try {
        const r = await markOrderPaidManually(fd);
        if (r.ok) {
          // The action revalidates the list: the paid order can leave a
          // filtered view and take this panel (mounted in the list) with it,
          // so the result goes to the admin toast and the panel closes.
          announceAdminResult(r);
          window.dispatchEvent(new CustomEvent(ORDER_PAID_EVENT, { detail: { id: target, message: r.message } }));
          setOrderId(null);
          router.refresh();
        } else {
          if (r.confirm === 'EARLIER_DATE') setAskEarlier(true);
          setRes(r);
        }
      } catch (e) {
        setRes({ ok: false, message: e instanceof Error ? e.message : 'Failed.' });
      }
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center" role="dialog" aria-modal>
      <button type="button" aria-label="Close" onClick={() => !pending && setOrderId(null)} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-full md:max-w-lg bg-card border border-border md:rounded-2xl shadow-xl max-h-[92vh] overflow-auto">
        <div className="flex items-start justify-between gap-4 p-5 border-b border-border">
          <div>
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground inline-flex items-center gap-1.5">
              <CreditCard className="h-3 w-3" /> {restPayment ? 'Record the remaining payment' : 'Mark as paid manually'}
            </p>
            <h2 className="text-lg font-bold mt-0.5">{restPayment ? 'Confirm the rest of the payment' : 'Confirm off-platform payment'}</h2>
            <p className="text-xs text-muted-foreground mt-1">
              {restPayment && <>Already received {money(ctx.receivedCents)}{ctx.totalCents != null ? ` of ${money(ctx.totalCents)}` : ''}. </>}
              Only for money that was really received (bank transfer, other). Payment on invoice is not “paid”: approve credit terms on the order page instead. Audit-logged.
            </p>
          </div>
          <button type="button" disabled={pending} onClick={() => setOrderId(null)} className="p-1.5 rounded-lg hover:bg-foreground/5 text-muted-foreground disabled:opacity-50">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={submit} className="p-5 space-y-4">
          <label className="block">
            <span className="block text-sm font-semibold mb-1.5">Payment method</span>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
            >
              <option value="BANK_TRANSFER">Bank transfer (SEPA / wire) — receipt required</option>
              <option value="RECEIPT">Receipt uploaded — receipt required</option>
              <option value="OTHER">Other (specify in note)</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">Amount received ({ctx.currency})</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                required
                placeholder="1210.00"
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm tabular-nums"
                data-testid="manual-paid-amount"
              />
            </label>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">Value date</span>
              <input
                type="date"
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
                required
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
              />
            </label>
            <label className="block col-span-2">
              <span className="block text-sm font-semibold mb-1.5">Bank reference (optional)</span>
              <input value={bankRef} onChange={(e) => setBankRef(e.target.value)} maxLength={120} placeholder="As on the bank statement" className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm" />
            </label>
            <p className="col-span-2 text-[11px] text-muted-foreground -mt-1">As on the bank statement, with cents (1210.00 or 1.210,00 — “1.210” alone is ambiguous and refused): the invoice prints the value date as the payment date. Less than the open amount (beyond the tolerance in Settings) is not “paid”.</p>
            {askEarlier && (
              <label className="col-span-2 flex items-start gap-2 text-xs rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-2 text-amber-900 dark:text-amber-300">
                <input type="checkbox" checked={confirmEarlier} onChange={(e) => setConfirmEarlier(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" data-testid="manual-paid-confirm-earlier" />
                Value date before the order date — confirmed on the bank statement.
              </label>
            )}
          </div>

          <label className="block">
            <span className="block text-sm font-semibold mb-1.5">
              Receipt / proof {proofRequired ? <span className="text-red-600 dark:text-red-400">(required)</span> : <span className="text-muted-foreground font-normal">(optional)</span>}
            </span>
            <div className="rounded-lg border border-dashed border-border p-3 text-center text-xs">
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                required={proofRequired}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block mx-auto text-xs"
                data-testid="manual-paid-proof"
              />
              {file ? (
                <p className="text-emerald-700 dark:text-emerald-300 font-semibold mt-2 inline-flex items-center gap-1">
                  <FileText className="h-3.5 w-3.5" /> {file.name} ({Math.round(file.size / 1024)} KB)
                </p>
              ) : (
                <p className="text-muted-foreground mt-2">
                  <Upload className="h-3.5 w-3.5 inline" /> PDF / JPG / PNG / WEBP · max 8 MB{proofRequired ? ' · the bank’s transfer confirmation' : ''}
                </p>
              )}
            </div>
          </label>

          <label className="block">
            <span className="block text-sm font-semibold mb-1.5">Internal note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Transfer reference, invoice number, etc."
              className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm"
            />
          </label>

          {res && (
            <p className={`text-sm inline-flex items-center gap-1.5 font-semibold ${res.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
              {res.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {res.message}
            </p>
          )}

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
            <p className="text-[11px] text-muted-foreground">Buyer is notified automatically.</p>
            <div className="flex items-center gap-2">
              <button type="button" disabled={pending} onClick={() => setOrderId(null)} className="h-9 px-3 rounded-full text-xs font-semibold hover:bg-foreground/5 disabled:opacity-50">
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending || (proofRequired && !file) || (askEarlier && !confirmEarlier)}
                title={proofRequired && !file ? 'Attach the receipt first' : undefined}
                className="h-9 px-4 rounded-full bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                Confirm payment
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Reusable trigger — open the modal for a given order id (open amount prefilled). */
export function openManualPaid(id: string, openCents?: number, opts: { currency?: string; receivedCents?: number; totalCents?: number } = {}) {
  window.dispatchEvent(new CustomEvent<OpenDetail>('admin:manualpaid', { detail: { id, openCents, ...opts } }));
}
