'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X, CreditCard, Loader2, CheckCircle2, XCircle, Upload, FileText } from 'lucide-react';
import { markOrderPaidManually } from '@/app/admin/actions';

/**
 * Modal for marking an order PAID without Stripe.
 * Receives orderId from a window CustomEvent (`admin:manualpaid`).
 */
export function ManualPaidPanel() {
  const router = useRouter();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [method, setMethod] = useState<'BANK_TRANSFER' | 'INVOICE' | 'RECEIPT' | 'OTHER'>('BANK_TRANSFER');
  const [note, setNote] = useState('');

  useEffect(() => {
    function handler(e: Event) {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      setOrderId(id);
      setRes(null);
      setFile(null);
      setMethod('BANK_TRANSFER');
      setNote('');
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

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setRes(null);
    const fd = new FormData();
    fd.set('orderId', orderId!);
    fd.set('method', method);
    fd.set('note', note);
    if (file) fd.set('proof', file);
    start(async () => {
      try {
        const r = await markOrderPaidManually(fd);
        setRes(r);
        if (r.ok) {
          setTimeout(() => {
            setOrderId(null);
            router.refresh();
          }, 900);
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
              <CreditCard className="h-3 w-3" /> Mark as paid manually
            </p>
            <h2 className="text-lg font-bold mt-0.5">Confirm off-platform payment</h2>
            <p className="text-xs text-muted-foreground mt-1">
              For quote / invoice / bank-transfer orders. Audit-logged with your email + timestamp.
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
              <option value="BANK_TRANSFER">Bank transfer (SEPA / wire)</option>
              <option value="INVOICE">Invoice (NET-30 / company account)</option>
              <option value="RECEIPT">Receipt uploaded</option>
              <option value="OTHER">Other (specify in note)</option>
            </select>
          </label>

          <label className="block">
            <span className="block text-sm font-semibold mb-1.5">Receipt / proof (optional)</span>
            <div className="rounded-lg border border-dashed border-border p-3 text-center text-xs">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block mx-auto text-xs"
              />
              {file ? (
                <p className="text-emerald-700 font-semibold mt-2 inline-flex items-center gap-1">
                  <FileText className="h-3.5 w-3.5" /> {file.name} ({Math.round(file.size / 1024)} KB)
                </p>
              ) : (
                <p className="text-muted-foreground mt-2">
                  <Upload className="h-3.5 w-3.5 inline" /> JPG / PNG / WEBP / PDF · max 8 MB
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
            <p className={`text-sm inline-flex items-center gap-1.5 font-semibold ${res.ok ? 'text-emerald-700' : 'text-red-700'}`}>
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
              <button type="submit" disabled={pending} className="h-9 px-4 rounded-full bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50">
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

/** Reusable trigger — open the modal for a given order id. */
export function openManualPaid(id: string) {
  window.dispatchEvent(new CustomEvent('admin:manualpaid', { detail: { id } }));
}
