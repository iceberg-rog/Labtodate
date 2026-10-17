import { Truck, ExternalLink, Package, CircleDollarSign, RotateCcw, Paperclip, FileText } from 'lucide-react';
import type { OrderFulfilmentView } from '@/lib/fulfilment/view';
import { documentNumberHref } from '@/lib/documents';
import { ResultForm } from './ResultForm';
import {
  buyerAddReturnFilesAction,
  buyerConfirmReceiptAction,
  buyerRequestReturnAction,
  buyerReturnShippedAction,
} from '@/app/app/orders/[orderNumber]/fulfilment-actions';

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' }) : '');
const input = 'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm';
const label = 'block text-xs font-semibold mb-1';
const UPLOAD_MAX = 9 * 1024 * 1024;

/** Buyer order page: shipments with carrier, tracking link and what is in each. */
export function BuyerShipments({ v }: { v: OrderFulfilmentView }) {
  const o = v.order;
  if (!v.shipments.length) return null;
  return (
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-6 space-y-4" data-testid="buyer-shipments">
      <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground inline-flex items-center gap-1.5"><Truck className="h-3.5 w-3.5" /> {v.shipments.length > 1 ? `Shipments (${v.shipments.length})` : 'Shipment'}</h2>
      {v.progress === 'PARTIAL' && <p className="text-sm rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-3 py-2 text-amber-900 dark:text-amber-300">Part of your order has shipped — the rest follows in a separate shipment; we email you its tracking.</p>}
      <ul className="space-y-3">
        {v.shipments.map((s) => (
          <li key={s.id} className="rounded-xl border border-border p-4 space-y-1.5">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <p className="text-sm font-semibold inline-flex items-center gap-1.5"><Package className="h-4 w-4 text-primary" /> {v.shipments.length > 1 ? `Shipment ${s.seq} · ` : ''}{s.carrier ?? 'Carrier'}</p>
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${s.deliveredAt ? 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800' : 'bg-violet-100 text-violet-900 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800'}`}>{s.deliveredAt ? 'Delivered' : 'On its way'}</span>
            </div>
            {s.trackingNumber ? (
              <p className="text-sm [overflow-wrap:anywhere]">Tracking <span className="font-mono font-semibold">{s.trackingNumber}</span>
                {s.trackingLink && <a href={s.trackingLink} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 text-primary font-semibold hover:underline">Track <ExternalLink className="h-3.5 w-3.5" /></a>}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">No tracking number for this carrier.</p>
            )}
            <p className="text-xs text-muted-foreground">{s.items.map((i) => `${i.qty} × ${i.title}`).join(' · ')}</p>
            <p className="text-xs text-muted-foreground">{s.shippedAt ? `Shipped ${day(s.shippedAt)}` : ''}{s.deliveredAt ? ` · delivered ${day(s.deliveredAt)}` : ''} · {s.parcels} parcel{s.parcels === 1 ? '' : 's'}</p>
          </li>
        ))}
      </ul>
      {o.status === 'SHIPPED' && (
        <ResultForm action={buyerConfirmReceiptAction} className="flex flex-col gap-2 border-t border-border pt-4" submitLabel="Mark as received" submitClassName="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2 disabled:opacity-60" testId="confirm-receipt">
          <input type="hidden" name="orderNumber" value={o.orderNumber} />
          <p className="text-sm font-bold">Did your order arrive?</p>
          <p className="text-xs text-muted-foreground">Confirm it when everything is in. Check the goods — anything wrong can be reported here afterwards.</p>
        </ResultForm>
      )}
    </section>
  );
}

/** Buyer order page: money coming back, with honest status (never “sent” before it is). */
export function BuyerRefunds({ v }: { v: OrderFulfilmentView }) {
  if (!v.refunds.length) return null;
  return (
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-6 space-y-3" data-testid="buyer-refunds">
      <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground inline-flex items-center gap-1.5"><CircleDollarSign className="h-3.5 w-3.5" /> Refunds</h2>
      <ul className="space-y-2">
        {v.refunds.map((r) => (
          <li key={r.id} className="rounded-xl border border-border p-3 text-sm flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="font-semibold">{r.amountLabel} <span className="font-normal text-muted-foreground">· {r.methodLabel}</span></p>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {r.status === 'REQUESTED' && (r.method === 'STRIPE' ? 'Approved — the card refund has not been issued yet. We email you when it is.' : 'Approved — the bank transfer has not been sent yet. We email you the date and reference when it is.')}
                {r.status === 'SENT' && r.method !== 'STRIPE' && `Sent on ${day(r.sentAt)}${r.bankRef ? ` (reference ${r.bankRef})` : ''} — it can take 1–3 business days to arrive.`}
                {r.status === 'SENT' && r.method === 'STRIPE' && `Refunded to your card on ${day(r.sentAt)} — usually visible within 5–10 business days.`}
                {r.status === 'CONFIRMED' && `Completed${r.sentAt ? ` — sent ${day(r.sentAt)}` : ''}.`}
                {r.reason ? ` Reason: ${r.reason}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {r.creditNote && <a href={documentNumberHref(r.creditNote, 'pdf')} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-border text-[11px] font-semibold hover:bg-foreground/5"><FileText className="h-3 w-3" /> Credit note {r.creditNote}</a>}
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-muted text-muted-foreground border-border">{r.statusLabel}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Buyer order page: report a problem / request a return, and follow requests. */
export function BuyerReturns({ v }: { v: OrderFulfilmentView }) {
  const o = v.order;
  const el = v.returnEligibility;
  const shippedSomething = v.shipments.length > 0;
  if (!shippedSomething && !v.returns.length) return null;
  const photoTypes = v.photosRequiredFor;
  const photoReasons = v.returnReasons.filter((r) => photoTypes.includes(r.type)).map((r) => r.label);
  return (
    <section id="returns" className="rounded-2xl border border-border bg-card p-5 sm:p-6 space-y-4 scroll-mt-24" data-testid="buyer-returns">
      <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground inline-flex items-center gap-1.5"><RotateCcw className="h-3.5 w-3.5" /> Problems &amp; returns</h2>
      {v.returns.map((r) => (
        <div key={r.id} className="rounded-xl border border-border p-4 space-y-2" data-testid={`buyer-rma-${r.rmaNumber}`}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold"><span className="font-mono">{r.rmaNumber}</span> · {r.reason}</p>
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-muted text-muted-foreground border-border">{r.statusLabel}</span>
          </div>
          <p className="text-xs text-muted-foreground">{r.items.map((i) => `${i.qty} × ${i.title}`).join(', ')} · sent {day(r.createdAt)} · {r.files.length} photo{r.files.length === 1 ? '' : 's'}/file{r.files.length === 1 ? '' : 's'}</p>
          {r.status === 'REQUESTED' && <p className="text-sm">We review it and reply by email. <strong>Please do not send anything back before you have our approval.</strong></p>}
          {r.status === 'DENIED' && <p className="text-sm"><strong>Not approved:</strong> <span dir="auto">{r.decisionReason}</span></p>}
          {['APPROVED', 'LABEL_SENT', 'IN_TRANSIT'].includes(r.status) && r.noReturnNeeded && <p className="text-sm"><strong>Approved — you do not need to send anything back.</strong> We settle it and email you.</p>}
          {['APPROVED', 'LABEL_SENT', 'IN_TRANSIT'].includes(r.status) && !r.noReturnNeeded && r.instructions && (
            <div className="rounded-lg bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 p-3 text-sm space-y-1">
              <p className="font-semibold">Return instructions</p>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">{r.instructions}</p>
              {r.labelHref && <a href={r.labelHref} target="_blank" className="inline-flex items-center gap-1 text-primary font-semibold hover:underline"><FileText className="h-3.5 w-3.5" /> Return label</a>}
            </div>
          )}
          {r.returnTracking && <p className="text-xs">You sent it with {r.returnCarrier} · <span className="font-mono">{r.returnTracking}</span></p>}
          {r.receivedAt && <p className="text-xs">We received it on {day(r.receivedAt)}{r.status === 'RECEIVED' ? ' and are inspecting it.' : '.'}</p>}
          {r.status === 'RESOLVED' && r.resolutionNote && <p className="text-sm"><strong>Outcome:</strong> <span dir="auto">{r.resolutionNote}</span>{r.hasRefund ? ' (see Refunds)' : ''}</p>}
          {['APPROVED', 'LABEL_SENT', 'IN_TRANSIT'].includes(r.status) && !r.noReturnNeeded && (
            <ResultForm action={buyerReturnShippedAction} className="grid sm:grid-cols-[1fr_1.5fr] gap-2 items-end" submitLabel={r.returnTracking ? 'Update tracking' : 'I sent it — save tracking'}>
              <input type="hidden" name="orderNumber" value={o.orderNumber} />
              <input type="hidden" name="returnId" value={r.id} />
              <label><span className={label}>Carrier</span><input name="carrier" required defaultValue={r.returnCarrier ?? ''} className={input} /></label>
              <label><span className={label}>Tracking number</span><input name="tracking" required defaultValue={r.returnTracking ?? ''} className={`${input} font-mono`} /></label>
            </ResultForm>
          )}
          {r.open && (
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-primary inline-flex items-center gap-1"><Paperclip className="h-3.5 w-3.5" /> Add photos / files</summary>
              <ResultForm action={buyerAddReturnFilesAction} className="mt-2 space-y-2" submitLabel="Add files" maxTotalBytes={UPLOAD_MAX} resetOnSuccess>
                <input type="hidden" name="orderNumber" value={o.orderNumber} />
                <input type="hidden" name="returnId" value={r.id} />
                <input type="file" name="files" multiple accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" className="text-sm" />
              </ResultForm>
            </details>
          )}
        </div>
      ))}

      {el?.canRequest ? (
        <details className="rounded-xl border border-border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-primary">
            {el.onlyWarranty ? 'File a warranty claim' : 'Report a problem / request a return'}
            <span className="block text-xs font-normal text-muted-foreground mt-0.5">
              {el.onlyWarranty
                ? `The return window ended; warranty runs until ${day(el.warrantyEndsAt)}.`
                : `Possible until ${day(el.windowEndsAt)}.`}
            </span>
          </summary>
          <ResultForm action={buyerRequestReturnAction} className="px-4 pb-4 space-y-3" submitLabel="Send request" maxTotalBytes={UPLOAD_MAX} testId="return-form">
            <input type="hidden" name="orderNumber" value={o.orderNumber} />
            <div className="rounded-lg border border-border divide-y divide-border">
              {Object.entries(v.shippedUnits).map(([itemId, n]) => {
                const it = o.items.find((i) => i.id === itemId);
                return (
                  <label key={itemId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{it?.titleSnapshot ?? 'item'}</span>
                    <span className="inline-flex items-center gap-1.5 text-xs shrink-0">Qty <input type="number" name={`qty_${itemId}`} min={0} max={n} defaultValue={n} className="h-9 w-16 px-2 rounded-md border border-input bg-background text-sm" /></span>
                  </label>
                );
              })}
            </div>
            <label className="block"><span className={label}>What is wrong? *</span>
              <select name="reason" required defaultValue="" className={input}>
                <option value="">Choose…</option>
                {v.returnReasons.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
              </select>
            </label>
            <label className="block"><span className={label}>Describe it * <span className="font-normal text-muted-foreground">(what you see, when it happened)</span></span>
              <textarea name="description" required minLength={10} maxLength={4000} rows={4} dir="auto" className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm" />
            </label>
            <label className="block"><span className={label}>Photos / files <span className="font-normal text-muted-foreground">(JPG, PNG, WEBP, GIF or PDF; up to {v.returnMaxFiles} files, {v.returnMaxMb} MB each, 9 MB together)</span></span>
              <input type="file" name="files" multiple accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" className="text-sm" />
            </label>
            {photoReasons.length > 0 && <p className="text-xs text-muted-foreground">A photo is required for: {photoReasons.join(', ')}. For transport damage, also note it on the carrier’s delivery receipt and keep the packaging.</p>}
            <p className="text-xs text-muted-foreground">Please do not send anything back before we approve the request — the approval tells you where and how.</p>
          </ResultForm>
        </details>
      ) : el && !v.returns.some((r) => r.open) && shippedSomething ? (
        <p className="text-sm text-muted-foreground">{el.reason}</p>
      ) : null}
    </section>
  );
}
