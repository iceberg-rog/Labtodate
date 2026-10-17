import { RotateCcw, Paperclip, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OrderActionForm } from '@/components/admin/OrderActionForm';
import {
  approveReturnAction,
  inspectReturnAction,
  openReturnAction,
  receiveReturnAction,
  rejectReturnAction,
  resolveReturnAction,
} from '@/app/admin/fulfilment-actions';
import type { OrderFulfilmentView } from '@/lib/fulfilment/view';
import { smartDate } from '@/lib/orders/display';

const input = 'h-9 px-2 rounded-md border border-input bg-background text-xs w-full';
const label = 'block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1';
const today = () => new Date().toISOString().slice(0, 10);

const STATUS_CLS: Record<string, string> = {
  REQUESTED: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800',
  APPROVED: 'bg-sky-100 text-sky-900 border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800',
  LABEL_SENT: 'bg-sky-100 text-sky-900 border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800',
  IN_TRANSIT: 'bg-violet-100 text-violet-900 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800',
  RECEIVED: 'bg-violet-100 text-violet-900 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800',
  INSPECTED: 'bg-violet-100 text-violet-900 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800',
  RESOLVED: 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800',
  DENIED: 'bg-red-100 text-red-900 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800',
};

/** Admin order page: returns / complaints / warranty claims (RMA, B14) — anchor #returns. */
export function AdminReturns({ v, canRefund }: { v: OrderFulfilmentView; canRefund: boolean }) {
  const o = v.order;
  const shipped = v.shipments.length > 0;
  const hasOpen = v.returns.some((r) => r.open);
  if (!shipped && !v.returns.length) return null;
  return (
    <section id="returns" className="rounded-2xl border border-border bg-card overflow-hidden scroll-mt-28" data-testid="admin-returns">
      <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
        <RotateCcw className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">Returns &amp; complaints (RMA)</h2>
        <a href="/admin/orders/returns" className="ml-auto text-[11px] font-semibold text-muted-foreground hover:text-foreground">All returns →</a>
      </div>
      {v.returns.length === 0 && <p className="px-5 pt-4 text-xs text-muted-foreground">No return or complaint on this order.</p>}
      <ul className="divide-y divide-border">
        {v.returns.map((r) => (
          <li key={r.id} className="p-5 space-y-3" data-testid={`rma-${r.rmaNumber}`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-bold"><span className="font-mono">{r.rmaNumber}</span> · {r.typeLabel}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{r.reason} · {r.items.map((i) => `${i.qty} × ${i.title}`).join(', ')} · opened {smartDate(r.createdAt)} by {r.openedBy === 'STAFF' ? 'staff' : 'the buyer'}</p>
              </div>
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${STATUS_CLS[r.status] ?? 'bg-muted text-muted-foreground border-border'}`}>{r.statusLabel}</span>
            </div>
            <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere] rounded-xl bg-foreground/[0.03] border border-border p-3" dir="auto">{r.description}</p>
            {r.files.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {r.files.map((f, i) => (
                  <a key={f.href} href={f.href} target="_blank" className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-border text-[11px] font-semibold hover:bg-foreground/5">
                    <Paperclip className="h-3 w-3" /> {f.isPdf ? `File ${i + 1} (PDF)` : `Photo ${i + 1}`} <ExternalLink className="h-3 w-3 opacity-60" />
                  </a>
                ))}
              </div>
            )}
            {r.decisionReason && <p className="text-xs"><strong>Not approved:</strong> {r.decisionReason}</p>}
            {r.instructions && <p className="text-xs whitespace-pre-wrap"><strong>Instructions sent:</strong> {r.instructions}</p>}
            {r.noReturnNeeded && r.status !== 'DENIED' && <p className="text-xs"><strong>No goods come back</strong> — settle it directly.</p>}
            {r.returnTracking && <p className="text-xs"><strong>Buyer sent it:</strong> {r.returnCarrier} · <span className="font-mono">{r.returnTracking}</span></p>}
            {r.receivedAt && <p className="text-xs"><strong>Received</strong> {smartDate(r.receivedAt)}</p>}
            {r.inspectionGrade && <p className="text-xs"><strong>Inspection:</strong> {r.inspectionGrade.toLowerCase()} — {r.inspectionNote} {r.restockedQty ? `· ${r.restockedQty} unit(s) back in stock` : '· not restocked'}</p>}
            {r.outcome && <p className="text-xs"><strong>Outcome:</strong> {r.outcome.replace(/_/g, ' ').toLowerCase()} — {r.resolutionNote}</p>}

            {r.status === 'REQUESTED' && (
              <div className="grid lg:grid-cols-2 gap-3">
                <OrderActionForm action={approveReturnAction} className="rounded-xl border border-sky-200 dark:border-sky-800 p-3 space-y-2" messageClassName="">
                  <input type="hidden" name="returnId" value={r.id} />
                  <p className="text-xs font-bold">Approve</p>
                  <label className="flex items-start gap-2 text-xs"><input type="checkbox" name="noReturnNeeded" className="mt-0.5 h-4 w-4 accent-primary" /> Nothing has to be sent back (e.g. settle transport damage with a partial refund)</label>
                  <label className="block"><span className={label}>Return instructions (sent to the buyer)</span>
                    <textarea name="instructions" rows={5} defaultValue={r.instructionsDraft ?? ''} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs" />
                  </label>
                  <label className="block"><span className={label}>Return label (optional, PDF / image)</span><input type="file" name="label" accept="application/pdf,image/png,image/jpeg" className="text-xs" /></label>
                  <Button type="submit" size="sm" className="rounded-full">Approve &amp; email the buyer</Button>
                </OrderActionForm>
                <OrderActionForm action={rejectReturnAction} className="rounded-xl border border-red-200 dark:border-red-800 p-3 space-y-2" messageClassName="">
                  <input type="hidden" name="returnId" value={r.id} />
                  <p className="text-xs font-bold">Do not approve</p>
                  <label className="block"><span className={label}>Reason (sent to the buyer) *</span>
                    <textarea name="reason" rows={4} required minLength={10} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs" />
                  </label>
                  <Button type="submit" size="sm" variant="outline" className="rounded-full border-red-300 text-red-700 dark:border-red-800 dark:text-red-300">Reject &amp; email the buyer</Button>
                </OrderActionForm>
              </div>
            )}
            {['APPROVED', 'LABEL_SENT', 'IN_TRANSIT'].includes(r.status) && !r.noReturnNeeded && (
              <OrderActionForm action={receiveReturnAction} className="rounded-xl border border-violet-200 dark:border-violet-800 p-3 grid sm:grid-cols-[1fr_2fr_auto] gap-2 items-end" messageClassName="sm:col-span-3">
                <input type="hidden" name="returnId" value={r.id} />
                <label><span className={label}>Received on</span><input type="date" name="receivedAt" defaultValue={today()} max={today()} className={input} /></label>
                <label><span className={label}>Note (condition on arrival)</span><input name="note" maxLength={500} className={input} /></label>
                <Button type="submit" size="sm" className="rounded-full">Goods received</Button>
              </OrderActionForm>
            )}
            {r.status === 'RECEIVED' && (
              <OrderActionForm action={inspectReturnAction} className="rounded-xl border border-violet-200 dark:border-violet-800 p-3 grid sm:grid-cols-3 gap-2 items-end" messageClassName="sm:col-span-3">
                <input type="hidden" name="returnId" value={r.id} />
                <label><span className={label}>Grade *</span>
                  <select name="grade" required defaultValue="" className={input}>
                    <option value="">Choose…</option>
                    <option value="RESELL">Resell as is</option>
                    <option value="REFURBISH">Needs refurbishing</option>
                    <option value="SCRAP">Scrap / not sellable</option>
                  </select>
                </label>
                <label className="sm:col-span-2"><span className={label}>What you found *</span><input name="note" required minLength={5} maxLength={2000} className={input} /></label>
                <label className="sm:col-span-2 flex items-start gap-2 text-xs"><input type="checkbox" name="restock" className="mt-0.5 h-4 w-4 accent-primary" /> Put the returned unit(s) back into sellable stock (only with “resell as is”)</label>
                <Button type="submit" size="sm" className="rounded-full">Save inspection</Button>
              </OrderActionForm>
            )}
            {(r.status === 'INSPECTED' || (r.noReturnNeeded && ['APPROVED', 'LABEL_SENT'].includes(r.status))) && (
              <OrderActionForm action={resolveReturnAction} className="rounded-xl border border-emerald-200 dark:border-emerald-800 p-3 grid sm:grid-cols-2 gap-2 items-end" messageClassName="sm:col-span-2">
                <input type="hidden" name="returnId" value={r.id} />
                <label><span className={label}>Outcome *</span>
                  <select name="outcome" required defaultValue="" className={input}>
                    <option value="">Choose…</option>
                    {canRefund && <option value="FULL_REFUND">Full refund</option>}
                    {canRefund && <option value="PARTIAL_REFUND">Partial refund</option>}
                    {canRefund && v.capacity.receivableCents > 0 && <option value="CREDIT">Credit the unpaid invoice (no money)</option>}
                    <option value="REPAIR">Repair</option>
                    <option value="REPLACEMENT">Replacement</option>
                    <option value="NONE">No action</option>
                  </select>
                </label>
                <label><span className={label}>Amount incl. VAT (€, refunds / credit)</span><input name="amount" inputMode="decimal" placeholder={`max ${(v.capacity.maxCents / 100).toFixed(2)}`} className={input} /></label>
                {v.capacity.moneyCents > 0 && (
                  <label><span className={label}>Refund by</span>
                    <select name="method" defaultValue={v.canCardRefund ? 'STRIPE' : 'BANK_TRANSFER'} className={input}>
                      {v.canCardRefund && <option value="STRIPE">The original card (Stripe)</option>}
                      <option value="BANK_TRANSFER">Bank transfer</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </label>
                )}
                <label className={v.capacity.moneyCents > 0 ? '' : 'sm:col-span-2'}><span className={label}>Message to the buyer *</span><input name="note" required minLength={5} maxLength={1000} className={input} /></label>
                <div className="sm:col-span-2"><Button type="submit" size="sm" className="rounded-full">Resolve</Button> <span className="text-[11px] text-muted-foreground">A refund issues a credit note and goes through the refund ledger (a bank transfer stays “requested” until you mark it sent).</span></div>
              </OrderActionForm>
            )}
          </li>
        ))}
      </ul>
      {shipped && !hasOpen && v.returnReasons.length > 0 && (
        <details className="border-t border-border">
          <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-primary">Open a return / complaint for the buyer</summary>
          <OrderActionForm action={openReturnAction} className="px-5 pb-5 space-y-3">
            <input type="hidden" name="orderId" value={o.id} />
            <div className="rounded-xl border border-border divide-y divide-border">
              {Object.entries(v.shippedUnits).map(([itemId, n]) => {
                const it = o.items.find((i) => i.id === itemId);
                return (
                  <label key={itemId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{it?.titleSnapshot ?? 'item'} <span className="text-[11px] text-muted-foreground">({n} shipped)</span></span>
                    <span className="inline-flex items-center gap-1.5 text-xs">Qty <input type="number" name={`rqty_${itemId}`} min={0} max={n} defaultValue={n} className="h-8 w-16 px-2 rounded-md border border-input bg-background text-xs" /></span>
                  </label>
                );
              })}
            </div>
            <label className="block"><span className={label}>Reason *</span>
              <select name="reason" required defaultValue="" className={input}>
                <option value="">Choose…</option>
                {v.returnReasons.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
              </select>
            </label>
            <label className="block"><span className={label}>What the buyer reported *</span>
              <textarea name="description" rows={3} required minLength={10} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs" />
            </label>
            <label className="block"><span className={label}>Photos / files (optional)</span><input type="file" name="files" multiple accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" className="text-xs" /></label>
            <Button type="submit" size="sm" className="rounded-full">Open the return &amp; email the buyer</Button>
          </OrderActionForm>
        </details>
      )}
    </section>
  );
}
