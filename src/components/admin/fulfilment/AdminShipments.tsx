import { Truck, Package, FileText, ExternalLink, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OrderActionForm } from '@/components/admin/OrderActionForm';
import { markDeliveredAction, markProcessingAction, recordShipmentAction, updateTrackingAction, uploadPodAction } from '@/app/admin/fulfilment-actions';
import type { OrderFulfilmentView } from '@/lib/fulfilment/view';
import { smartDate } from '@/lib/orders/display';

const input = 'h-9 px-2 rounded-md border border-input bg-background text-xs w-full';
const label = 'block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1';
const today = () => new Date().toISOString().slice(0, 10);

const PROGRESS: Record<string, { text: string; cls: string }> = {
  NONE: { text: 'Not shipped', cls: 'bg-muted text-muted-foreground border-border' },
  PARTIAL: { text: 'Partly shipped', cls: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800' },
  ALL: { text: 'Everything shipped', cls: 'bg-violet-100 text-violet-900 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800' },
};

/** Admin order page: shipments (B12) — record, track, deliver, packing slip, POD. */
export function AdminShipments({ v }: { v: OrderFulfilmentView }) {
  const o = v.order;
  const shippable = ['PAID', 'PROCESSING'].includes(o.status);
  const delivered = o.status === 'DELIVERED';
  const badge = delivered ? { text: 'Delivered', cls: 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800' } : PROGRESS[v.progress];
  if (!shippable && !v.shipments.length) return null;
  return (
    <section id="shipments" className="rounded-2xl border border-border bg-card overflow-hidden scroll-mt-28" data-testid="admin-shipments">
      <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2 flex-wrap">
        <Truck className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">Shipments</h2>
        <span className={`ml-auto text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${badge.cls}`}>{badge.text}</span>
      </div>

      {shippable && v.blockers.length > 0 && (
        <div role="alert" className="mx-5 mt-4 rounded-xl border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/40 p-3 text-sm text-red-900 dark:text-red-300">
          <p className="font-bold inline-flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Can not be prepared or shipped yet</p>
          <ul className="list-disc pl-5 mt-1 space-y-0.5 text-xs">
            {v.blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
          <p className="text-xs mt-1.5">Fix it under “Billing & delivery details” / “Pricing, VAT &amp; holds” above — the shipment form appears here once the order can ship.</p>
        </div>
      )}

      {o.status === 'PAID' && v.blockers.length === 0 && (
        <OrderActionForm action={markProcessingAction} className="px-5 pt-4 flex flex-wrap items-center gap-3" messageClassName="basis-full">
          <input type="hidden" name="orderId" value={o.id} />
          <Button type="submit" size="sm" variant="outline" className="rounded-full">Mark “processing” (being prepared)</Button>
          <span className="text-[11px] text-muted-foreground">Optional — tells the buyer you are preparing the order. Recording a shipment below works from “paid” too.</span>
        </OrderActionForm>
      )}

      {v.shipments.length > 0 && (
        <ul className="divide-y divide-border mt-2">
          {v.shipments.map((s) => (
            <li key={s.id} className="p-5 space-y-2" data-testid={`shipment-${s.seq}`}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-bold inline-flex items-center gap-1.5"><Package className="h-4 w-4 text-primary" /> Shipment {s.seq}</p>
                  <p className="text-sm mt-0.5">
                    <strong>{s.carrier ?? 'Carrier not set'}</strong>
                    {s.trackingNumber && <> · <span className="font-mono">{s.trackingNumber}</span></>}
                    {s.trackingLink && (
                      <a href={s.trackingLink} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">Track <ExternalLink className="h-3 w-3" /></a>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {s.parcels} parcel{s.parcels === 1 ? '' : 's'}{s.grossKg ? ` · ${s.grossKg} kg` : ''}{s.insuredLabel ? ` · insured ${s.insuredLabel}` : ' · not insured'}
                    {s.shippedAt ? ` · shipped ${smartDate(s.shippedAt)}` : ''}
                    {s.deliveredAt ? ` · delivered ${smartDate(s.deliveredAt)}${s.deliveredBy === 'BUYER' ? ' (confirmed by the buyer)' : s.deliveredBy === 'CARRIER_POD' ? ' (carrier proof)' : ''}` : ''}
                    {s.emailed ? ' · buyer emailed' : ' · buyer NOT emailed'}
                  </p>
                  <p className="text-xs mt-1">{s.items.map((i) => `${i.qty} × ${i.title}`).join(' · ')}</p>
                  {s.note && <p className="text-[11px] text-muted-foreground italic mt-0.5">{s.note}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href={s.packingSlipHref} target="_blank" className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-border bg-card text-xs font-semibold hover:bg-foreground/5">
                    <FileText className="h-3.5 w-3.5" /> Packing slip PDF
                  </a>
                  {s.podHref && (
                    <a href={s.podHref} target="_blank" className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300 bg-card text-xs font-semibold">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Proof of delivery
                    </a>
                  )}
                </div>
              </div>
              {!['CANCELED', 'REFUNDED'].includes(o.status) && (
                <div className="grid lg:grid-cols-2 gap-3 pt-1">
                  {!s.deliveredAt && (
                    <details className="rounded-xl border border-border">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-primary">Change carrier / tracking (the buyer is emailed)</summary>
                      <OrderActionForm action={updateTrackingAction} className="p-3 pt-1 grid sm:grid-cols-[1fr_1.4fr_auto] gap-2 items-end" messageClassName="sm:col-span-3">
                        <input type="hidden" name="shipmentId" value={s.id} />
                        <label><span className={label}>Carrier</span>
                          <select name="carrier" defaultValue={s.carrier ?? ''} className={input}>
                            {v.carriers.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                          </select>
                        </label>
                        <label><span className={label}>Tracking number</span><input name="trackingNumber" defaultValue={s.trackingNumber ?? ''} className={`${input} font-mono`} /></label>
                        <Button type="submit" size="sm" className="rounded-full">Save</Button>
                      </OrderActionForm>
                    </details>
                  )}
                  {!s.deliveredAt ? (
                    <details className="rounded-xl border border-border">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-primary">Record delivery (date, optional proof)</summary>
                      <OrderActionForm action={markDeliveredAction} className="p-3 pt-1 grid sm:grid-cols-[1fr_1.4fr_auto] gap-2 items-end" messageClassName="sm:col-span-3">
                        <input type="hidden" name="orderId" value={o.id} />
                        <input type="hidden" name="shipmentId" value={s.id} />
                        <label><span className={label}>Delivered on</span><input type="date" name="deliveredAt" defaultValue={today()} max={today()} className={input} /></label>
                        <label><span className={label}>Proof of delivery (optional)</span><input type="file" name="pod" accept="image/jpeg,image/png,image/webp,application/pdf" className="text-xs w-full" /></label>
                        <Button type="submit" size="sm" className="rounded-full">Delivered</Button>
                      </OrderActionForm>
                    </details>
                  ) : !s.podHref ? (
                    <details className="rounded-xl border border-border">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-primary">Attach a proof of delivery</summary>
                      <OrderActionForm action={uploadPodAction} className="p-3 pt-1 flex flex-wrap gap-2 items-end" messageClassName="basis-full">
                        <input type="hidden" name="shipmentId" value={s.id} />
                        <input type="file" name="pod" required accept="image/jpeg,image/png,image/webp,application/pdf" className="text-xs" />
                        <Button type="submit" size="sm" className="rounded-full">Upload</Button>
                      </OrderActionForm>
                    </details>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {shippable && v.blockers.length === 0 && v.remaining.length > 0 && (
        <OrderActionForm action={recordShipmentAction} className="p-5 border-t border-border space-y-3" messageClassName="">
          <input type="hidden" name="orderId" value={o.id} />
          <p className="text-xs font-bold uppercase tracking-wider">{v.shipments.length ? 'Ship the remaining items' : 'Record a shipment'}</p>
          <div className="rounded-xl border border-border divide-y divide-border">
            {v.remaining.map((r) => (
              <label key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 [overflow-wrap:anywhere]">{r.title}{r.brand ? <span className="text-muted-foreground"> · {r.brand}</span> : null}<span className="block text-[11px] text-muted-foreground">{r.left} still to ship</span></span>
                <span className="inline-flex items-center gap-1.5 text-xs shrink-0">Qty <input type="number" name={`qty_${r.id}`} min={0} max={r.left} defaultValue={r.left} className="h-8 w-16 px-2 rounded-md border border-input bg-background text-xs" /></span>
              </label>
            ))}
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <label><span className={label}>Carrier *</span>
              <select name="carrier" required defaultValue="" className={input}>
                <option value="">Choose…</option>
                {v.carriers.map((c) => <option key={c.name} value={c.name}>{c.name}{c.needsTracking ? '' : ' (no tracking)'}</option>)}
              </select>
            </label>
            <label className="sm:col-span-2"><span className={label}>Tracking number</span><input name="trackingNumber" placeholder="Required for carriers with tracking" className={`${input} font-mono`} /></label>
            <label><span className={label}>Parcels</span><input type="number" name="parcels" min={1} max={999} defaultValue={1} className={input} /></label>
            <label><span className={label}>Gross weight (kg)</span><input name="grossKg" inputMode="decimal" placeholder="optional" className={input} /></label>
            <label><span className={label}>Insured value (€, excl. VAT)</span><input name="insuredValue" inputMode="decimal" placeholder={v.insureByDefault ? 'empty = goods value of these items' : 'empty = not insured'} className={input} /></label>
            <label><span className={label}>Ship date</span><input type="date" name="shippedAt" defaultValue={today()} max={today()} className={input} /></label>
            <label className="sm:col-span-2"><span className={label}>Internal note</span><input name="note" maxLength={500} placeholder="e.g. crated, tail-lift booked" className={input} /></label>
            {v.insureByDefault && (
              <label className="sm:col-span-3 flex items-center gap-2 text-xs"><input type="checkbox" name="notInsured" className="h-4 w-4 accent-primary" /> Not insured (Settings insure every shipment with the goods value of the shipped items by default)</label>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" className="rounded-full"><Truck className="h-3.5 w-3.5" /> Record shipment &amp; email the buyer</Button>
            <span className="text-[11px] text-muted-foreground">Set a quantity to 0 to leave an item for a later shipment (partial shipment). The order becomes “shipped” when everything has left.</span>
          </div>
        </OrderActionForm>
      )}
    </section>
  );
}
