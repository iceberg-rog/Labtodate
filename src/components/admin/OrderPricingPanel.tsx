import { AlertTriangle, BadgeEuro, History } from 'lucide-react';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { vatTreatmentLabel } from '@/lib/tax/determine';
import { OrderActionForm } from '@/components/admin/OrderActionForm';
import { holdTitle } from '@/lib/checkout/notify';
import { approveAddressAction, clearComplianceAction, recheckVatAction, releasePaymentReviewAction, setFreightAction } from '@/app/admin/checkout-actions';

/**
 * Admin: how the order was priced (sell price, shipping, VAT engine, VIES,
 * buyer type / PO / invoice email) and the open pre-payment holds with the
 * action that resolves each one. Server component.
 */
export async function OrderPricingPanel({ orderId }: { orderId: string }) {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, status: true, currency: true, subtotalCents: true, shippingCents: true, taxCents: true, totalCents: true,
      vatTreatment: true, vatRateBp: true, shippingVatRateBp: true, vatNote: true, buyerVatId: true, viesCheck: true,
      customerType: true, b2bDeclarationAt: true, poNumber: true, invoiceEmail: true, pricingSnapshot: true,
      holdReason: true, holdNote: true, openHolds: true, sourcingRequestId: true, paymentSubmittedAt: true,
      items: { select: { id: true, titleSnapshot: true, quantity: true, priceCentsSnapshot: true, basePriceCents: true, appliedMarkupBp: true, vatRateBp: true, taxCents: true } },
      addressChanges: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  });
  if (!o) return null;
  const snap = (o.pricingSnapshot ?? null) as null | {
    shipping?: { status?: string; zone?: string | null; reasons?: string[] };
    adjustments?: Array<{ at: string; by: string; reason: string; before: { totalCents: number }; after: { totalCents: number } }>;
    paymentMethod?: string;
  };
  const vies = (o.viesCheck ?? null) as null | { status?: string; name?: string | null; consultationNumber?: string | null; checkedAt?: string | null; error?: string | null };
  const open = Array.from(new Set([...o.openHolds, ...(o.holdReason ? [o.holdReason] : [])]));
  const unpaid = o.status === 'PENDING_PAYMENT';
  const checkoutOrder = !o.sourcingRequestId;
  const notes = (o.holdNote ?? '').split(' | ').filter(Boolean);
  const detail = (code: string) => notes.find((n) => n.startsWith(`${code}:`))?.slice(code.length + 1).trim() ?? null;
  const cur = o.currency;
  const pct = (bp: number | null | undefined) => (bp == null ? '—' : `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`);

  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden" data-section="order-pricing">
      <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
        <BadgeEuro className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">Pricing, VAT &amp; holds</h2>
        {open.length > 0 && (
          <span className="ml-auto text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
            On hold
          </span>
        )}
      </div>

      {open.length > 0 && (
        <div className="p-4 space-y-3 border-b border-border bg-amber-50/60 dark:bg-amber-950/20" data-testid="order-holds">
          <p className="text-xs text-amber-900 dark:text-amber-200 inline-flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            {unpaid ? 'Not payable yet — no proforma, bank details or card payment until every hold below is resolved.' : 'Do not ship until every hold below is resolved.'}
          </p>
          {open.map((code) => (
            <div key={code} className="rounded-xl border border-amber-300 dark:border-amber-800 bg-card p-3 space-y-2" data-hold={code}>
              <p className="text-sm font-bold">{holdTitle(code)}</p>
              {detail(code) && <p className="text-xs text-muted-foreground leading-relaxed">{detail(code)}</p>}
              {code === 'SHIPPING_PENDING' && unpaid && checkoutOrder && (
                <OrderActionForm action={setFreightAction} className="flex items-end gap-2 flex-wrap">
                  <input type="hidden" name="orderId" value={o.id} />
                  <label className="text-xs">
                    <span className="block font-semibold mb-1">Shipping cost (€, excl. VAT)</span>
                    <input name="amount" inputMode="decimal" required placeholder="185.00" className="h-8 w-28 px-2 rounded-lg border border-input bg-background text-sm" />
                  </label>
                  <label className="text-xs flex-1 min-w-[12rem]">
                    <span className="block font-semibold mb-1">Source (carrier / quote ref.)</span>
                    <input name="note" required minLength={3} placeholder="DHL Freight quote 4711" className="h-8 w-full px-2 rounded-lg border border-input bg-background text-sm" />
                  </label>
                  <button type="submit" className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold">Set shipping</button>
                </OrderActionForm>
              )}
              {code === 'VAT_REVIEW' && unpaid && checkoutOrder && (
                <OrderActionForm action={recheckVatAction} className="flex items-center gap-2 flex-wrap">
                  <input type="hidden" name="orderId" value={o.id} />
                  <button type="submit" className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold">Re-check VAT now (VIES)</button>
                  <span className="text-[11px] text-muted-foreground">Applies the VAT rules again with a live VIES check; releases the hold when they decide.</span>
                </OrderActionForm>
              )}
              {code === 'COMPLIANCE' && (
                <OrderActionForm action={clearComplianceAction} className="flex items-end gap-2 flex-wrap" confirmText="Release the export-compliance hold? Your note is kept as the compliance record.">
                  <input type="hidden" name="orderId" value={o.id} />
                  <label className="text-xs flex-1 min-w-[14rem]">
                    <span className="block font-semibold mb-1">What was checked (kept as the record)</span>
                    <input name="note" required minLength={4} placeholder="End user / use checked, no listed party, no dual-use" className="h-8 w-full px-2 rounded-lg border border-input bg-background text-sm" />
                  </label>
                  <button type="submit" className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold">Clear compliance hold</button>
                </OrderActionForm>
              )}
              {code === 'ADDRESS_REVIEW' && (
                <OrderActionForm action={approveAddressAction} className="flex items-end gap-2 flex-wrap">
                  <input type="hidden" name="orderId" value={o.id} />
                  <label className="text-xs flex-1 min-w-[12rem]">
                    <span className="block font-semibold mb-1">Note</span>
                    <input name="note" placeholder="Checked with the buyer by phone" className="h-8 w-full px-2 rounded-lg border border-input bg-background text-sm" />
                  </label>
                  <button type="submit" className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold">
                    {unpaid && checkoutOrder ? 'Re-price for the new address & approve' : 'Approve address change'}
                  </button>
                </OrderActionForm>
              )}
              {code === 'PAYMENT_REVIEW' && (
                <OrderActionForm action={releasePaymentReviewAction} className="flex items-end gap-2 flex-wrap">
                  <input type="hidden" name="orderId" value={o.id} />
                  <label className="text-xs flex-1 min-w-[14rem]">
                    <span className="block font-semibold mb-1">How it was resolved</span>
                    <input name="note" required minLength={4} placeholder="Refunded in Stripe / buyer paid the difference" className="h-8 w-full px-2 rounded-lg border border-input bg-background text-sm" />
                  </label>
                  <button type="submit" className="h-8 px-3 rounded-full border border-border text-xs font-bold">Release payment review</button>
                </OrderActionForm>
              )}
            </div>
          ))}
        </div>
      )}

      <dl className="p-5 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Item label="Buyer type" value={o.customerType ? o.customerType.toLowerCase() : 'not recorded (older order)'} />
        <Item label="B2B declaration" value={o.b2bDeclarationAt ? o.b2bDeclarationAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'} />
        <Item label="PO number" value={o.poNumber ?? '—'} />
        <Item label="Invoice email" value={o.invoiceEmail ?? 'account email'} />
        <Item label="VAT treatment" value={`${vatTreatmentLabel(o.vatTreatment)}${o.vatRateBp != null ? ` · goods ${pct(o.vatRateBp)}` : ''}${o.shippingVatRateBp != null ? ` · shipping ${pct(o.shippingVatRateBp)}` : ''}`} />
        <Item label="Buyer VAT ID" value={o.buyerVatId ? `${o.buyerVatId}${vies?.status ? ` · VIES ${vies.status === 'UNAVAILABLE' ? 'could not check' : vies.status.toLowerCase().replace('_', ' ')}` : ''}${vies?.consultationNumber ? ` · ${vies.consultationNumber}` : ''}${vies?.error ? ` · ${vies.error}` : ''}` : '—'} />
        <Item label="Shipping" value={snap?.shipping ? `${snap.shipping.status === 'TO_BE_CONFIRMED' && o.shippingCents === 0 ? 'to be confirmed' : formatPrice(o.shippingCents, cur)}${snap.shipping.zone ? ` · zone ${snap.shipping.zone}` : ''}` : formatPrice(o.shippingCents, cur)} />
        <Item label="Payment method chosen" value={snap?.paymentMethod ? snap.paymentMethod.replace('_', ' ').toLowerCase() : '—'} />
        {o.vatNote && <div className="sm:col-span-2 text-xs text-muted-foreground leading-relaxed"><span className="font-semibold text-foreground">Why: </span>{o.vatNote}</div>}
      </dl>

      <div className="px-5 pb-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-semibold">Line</th>
              <th className="py-1 font-semibold text-right">Base</th>
              <th className="py-1 font-semibold text-right">Markup</th>
              <th className="py-1 font-semibold text-right">Sold at</th>
              <th className="py-1 font-semibold text-right">VAT</th>
            </tr>
          </thead>
          <tbody>
            {o.items.map((i) => (
              <tr key={i.id} className="border-t border-border">
                <td className="py-1.5 pr-2">{i.quantity} × {i.titleSnapshot}</td>
                <td className="py-1.5 text-right tabular-nums">{i.basePriceCents != null ? formatPrice(i.basePriceCents, cur) : '—'}</td>
                <td className="py-1.5 text-right tabular-nums">{i.appliedMarkupBp ? pct(i.appliedMarkupBp) : '—'}</td>
                <td className="py-1.5 text-right tabular-nums font-semibold">{formatPrice(i.priceCentsSnapshot, cur)}</td>
                <td className="py-1.5 text-right tabular-nums">{i.vatRateBp != null ? `${pct(i.vatRateBp)} · ${formatPrice(i.taxCents ?? 0, cur)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(snap?.adjustments?.length || o.addressChanges.length) ? (
        <div className="px-5 pb-5 space-y-2 text-xs">
          <p className="font-semibold inline-flex items-center gap-1.5"><History className="h-3.5 w-3.5" /> Changes after checkout</p>
          <ul className="space-y-1 text-muted-foreground">
            {(snap?.adjustments ?? []).map((a, i) => (
              <li key={`adj-${i}`}>{a.at.slice(0, 16).replace('T', ' ')} · {a.by}: {a.reason} — total {formatPrice(a.before.totalCents, cur)} → {formatPrice(a.after.totalCents, cur)}</li>
            ))}
            {o.addressChanges.map((c) => (
              <li key={c.id}>
                {c.createdAt.toISOString().slice(0, 16).replace('T', ' ')} · {c.actorRole.toLowerCase()} changed the {c.kind.toLowerCase()} address
                {c.reviewStatus !== 'NONE' ? ` (review: ${c.reviewStatus.toLowerCase()})` : ''} — {c.note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{value}</dd>
    </div>
  );
}
