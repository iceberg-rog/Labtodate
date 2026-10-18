import { CircleDollarSign, Undo2, XCircle, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OrderActionForm } from '@/components/admin/OrderActionForm';
import { cancelOrderAction, confirmRefundAction, markRefundSentAction } from '@/app/admin/fulfilment-actions';
import { RefundCreditForm } from '@/components/admin/RefundCreditForm';
import type { OrderFulfilmentView } from '@/lib/fulfilment/view';
import { documentNumberHref } from '@/lib/documents';
import { smartDate } from '@/lib/orders/display';

const input = 'h-9 px-2 rounded-md border border-input bg-background text-xs w-full';
const label = 'block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1';
const today = () => new Date().toISOString().slice(0, 10);

const STATUS_CLS: Record<string, string> = {
  REQUESTED: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800',
  SENT: 'bg-sky-100 text-sky-900 border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800',
  CONFIRMED: 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800',
};

/**
 * Admin order page, right column: how to stop this order at its stage (owner
 * report 6). Unpaid → cancel (proforma void, unit released, email). Unpaid but
 * part paid → the money received is refunded / credited first (“Money back”),
 * never kept by a plain cancel. Paid / on terms, nothing shipped → cancel &
 * refund (credit note, refund ledger, restock per setting). Shipped → a return
 * (RMA) or a refund in “Money back”.
 */
export function AdminCancelCard({ v, canRefund }: { v: OrderFulfilmentView; canRefund: boolean }) {
  const o = v.order;
  const unpaid = o.status === 'PENDING_PAYMENT';
  const paidNotShipped = ['PAID', 'PROCESSING'].includes(o.status) && v.shipments.length === 0;
  const reasons = v.staffCancelReasons;
  return (
    <section id="actions" className="rounded-2xl border border-border bg-card overflow-hidden scroll-mt-28" data-testid="order-actions">
      <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
        <XCircle className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">Cancel this order</h2>
      </div>
      <div className="p-5 text-sm space-y-3">
        {unpaid && o.paymentSubmittedAt ? (
          <p className="text-amber-800 dark:text-amber-300">A payment receipt is waiting — verify or reject it first; then the order can be canceled.</p>
        ) : unpaid && v.partPaidUnpaid ? (
          <div className="space-y-2" data-testid="cancel-part-paid">
            <p className="text-amber-800 dark:text-amber-300">
              <strong>Part payment received</strong> ({v.paidLabel}). A plain cancel would keep that money: refund or credit it first, then cancel — or wait for the rest of the payment.
            </p>
            {canRefund ? (
              <a href="#money" className="inline-flex items-center justify-center w-full h-9 rounded-full border border-red-300 text-red-700 dark:border-red-800 dark:text-red-300 text-xs font-bold hover:bg-red-50 dark:hover:bg-red-950/40">Refund / credit the part payment…</a>
            ) : (
              <p className="text-xs text-muted-foreground">Refunding needs the “Refund and cancel paid orders” permission.</p>
            )}
          </div>
        ) : unpaid ? (
          <OrderActionForm action={cancelOrderAction} className="space-y-2" confirmText="Cancel this unpaid order? The proforma becomes void, the reserved unit is released and the buyer is emailed with the reason." announce>
            <input type="hidden" name="orderId" value={o.id} />
            <p className="text-xs text-muted-foreground">Not paid yet: the proforma becomes void, the reserved unit goes back on sale{o.sourcingRequestId ? ' and the quote moves to Lost' : ''}. The buyer is emailed with the reason.</p>
            <ReasonFields reasons={reasons} />
            <Button type="submit" size="sm" variant="outline" className="w-full rounded-full border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40">Cancel order</Button>
          </OrderActionForm>
        ) : paidNotShipped ? (
          canRefund ? (
            <OrderActionForm
              action={cancelOrderAction}
              className="space-y-2"
              announce
              confirmText={v.onTermsUnpaid && v.capacity.moneyCents > 0
                ? `Cancel order ${o.orderNumber}? Invoice ${v.invoiceNumber ?? ''} is credited in full: ${v.capacityLabels.receivable} that was not paid is no longer due and the ${v.capacityLabels.money} that was paid is refunded (a bank transfer stays “requested” until you mark it sent). The buyer is emailed.`
                : v.onTermsUnpaid
                ? `Cancel order ${o.orderNumber}? Nothing was paid on the invoice: a credit note cancels it (no money is refunded) and the buyer is emailed.`
                : `Cancel order ${o.orderNumber} and refund ${v.capacityLabels.money}? ${v.invoiceNumber ? `A credit note is issued against invoice ${v.invoiceNumber} and the` : 'The'} refund is recorded (a bank transfer stays “requested” until you mark it sent). The buyer is emailed.`}
            >
              <input type="hidden" name="orderId" value={o.id} />
              <p className="text-xs text-muted-foreground">
                {v.onTermsUnpaid && v.capacity.moneyCents > 0
                  ? <>Approved on invoice terms, part paid: the invoice is credited in full — the unpaid {v.capacityLabels.receivable} is no longer due and <strong>{v.capacityLabels.money}</strong> that was paid is refunded through the refund ledger.</>
                  : v.onTermsUnpaid
                  ? <>Approved on invoice terms, nothing paid: the invoice is credited in full — the credit note says no payment is due and <strong>no money is refunded</strong>.</>
                  : v.invoiceNumber
                    ? <>Paid, nothing shipped: invoice {v.invoiceNumber} is credited in full (credit note) and <strong>{v.capacityLabels.money}</strong> is refunded through the refund ledger.</>
                    : <>Paid, nothing shipped: <strong>{v.capacityLabels.money}</strong> is refunded through the refund ledger. No invoice was issued, so no credit note is needed.</>}
                {' '}Stock: {v.restockOnCancel ? 'the unit(s) go back on sale (they never left).' : 'NOT put back automatically (Settings → Stock & reservation).'}
              </p>
              <ReasonFields reasons={reasons} />
              {v.capacity.moneyCents > 0 && <MethodFields card={v.canCardRefund} />}
              <Button type="submit" size="sm" variant="outline" className="w-full rounded-full border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40">
                {v.onTermsUnpaid && v.capacity.moneyCents === 0 ? 'Cancel order (credit the invoice)' : 'Cancel & refund'}
              </Button>
            </OrderActionForm>
          ) : (
            <p className="text-xs text-muted-foreground">Canceling a paid order refunds money — that needs the “Refund and cancel paid orders” permission.</p>
          )
        ) : ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(o.status) ? (
          <p className="text-xs text-muted-foreground">Something has shipped, so the order can no longer be canceled. Use a <a href="#returns" className="font-semibold text-primary hover:underline">return (RMA)</a> for goods that come back, or a <a href="#money" className="font-semibold text-primary hover:underline">refund / credit</a> for money only.</p>
        ) : (
          <p className="text-xs text-muted-foreground">This order is {o.status.toLowerCase()} — there is nothing to cancel.</p>
        )}
      </div>
    </section>
  );
}

function ReasonFields({ reasons }: { reasons: string[] }) {
  return (
    <>
      <label className="block"><span className={label}>Reason (sent to the buyer) *</span>
        <select name="reason" required defaultValue="" className={input}>
          <option value="">Choose…</option>
          {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label className="block"><span className={label}>Details (if “Other”, or extra context)</span><input name="reasonOther" maxLength={300} className={input} /></label>
      <input type="hidden" name="note" value="" />
    </>
  );
}

function MethodFields({ card }: { card: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-2">
      <label className="block"><span className={label}>Refund by *</span>
        <select name="method" required defaultValue={card ? 'STRIPE' : 'BANK_TRANSFER'} className={input}>
          {card && <option value="STRIPE">The original card (Stripe refund now)</option>}
          <option value="BANK_TRANSFER">Bank transfer (you send it, then mark it sent)</option>
          <option value="OTHER">Other (explain in the details)</option>
        </select>
      </label>
      <label className="block"><span className={label}>Buyer’s IBAN (bank transfer, optional now)</span><input name="payeeIban" placeholder="NL91 ABNA 0417 1643 00" className={`${input} font-mono`} /></label>
    </div>
  );
}

/** Admin order page: “Money back” — refund ledger + refund / credit form (anchor #money). */
export function AdminMoney({ v, canRefund }: { v: OrderFulfilmentView; canRefund: boolean }) {
  const o = v.order;
  // Paid / on terms (or a part payment on an unpaid order): one refund / credit form for every money correction.
  const showForm = canRefund && (o.status !== 'PENDING_PAYMENT' || v.partPaidUnpaid) && v.capacity.maxCents > 0;
  if (!v.refunds.length && !showForm) return null;
  return (
    <section id="money" className="rounded-2xl border border-border bg-card overflow-hidden scroll-mt-28" data-testid="admin-money">
      {/* Older links (#refund) land here too: refunds and the refund / credit form are this one section. */}
      <span id="refund" className="block scroll-mt-28" aria-hidden />
      <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
        <CircleDollarSign className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">Money back — refunds &amp; credit notes</h2>
      </div>
      {v.refunds.length > 0 ? (
        <ul className="divide-y divide-border">
          {v.refunds.map((r) => (
            <li key={r.id} className="p-5 space-y-2" data-testid="refund-row" data-refund-status={r.status}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-bold">{r.amountLabel} <span className="font-normal text-muted-foreground">· {r.methodLabel}</span></p>
                  <p className="text-xs text-muted-foreground mt-0.5 [overflow-wrap:anywhere]">
                    Recorded {smartDate(r.createdAt)}{r.reason ? ` · ${r.reason}` : ''}
                    {r.sentAt ? ` · sent ${smartDate(r.sentAt)}` : ''}{r.bankRef ? ` · ref ${r.bankRef}` : ''}{r.payeeIban ? ` · to ${r.payeeIban}` : ''}
                    {r.confirmedAt ? ` · confirmed ${smartDate(r.confirmedAt)}` : ''}
                  </p>
                  {r.justification && <p className="text-[11px] text-muted-foreground italic mt-0.5">Without a return: {r.justification}</p>}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {r.creditNote && (
                    <a href={documentNumberHref(r.creditNote, 'pdf')} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-border text-[11px] font-semibold hover:bg-foreground/5"><FileText className="h-3 w-3" /> {r.creditNote}</a>
                  )}
                  {r.proofHref && <a href={r.proofHref} target="_blank" className="inline-flex items-center h-7 px-2.5 rounded-full border border-border text-[11px] font-semibold hover:bg-foreground/5">Transfer proof</a>}
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${STATUS_CLS[r.status] ?? 'bg-muted text-muted-foreground border-border'}`}>{r.statusLabel}</span>
                </div>
              </div>
              {canRefund && r.status === 'REQUESTED' && (
                <OrderActionForm action={markRefundSentAction} className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-3 grid sm:grid-cols-2 gap-2 items-end" messageClassName="sm:col-span-2">
                  <input type="hidden" name="refundId" value={r.id} />
                  <p className="sm:col-span-2 text-xs text-amber-900 dark:text-amber-300"><strong>Not sent yet.</strong> Send {r.amountLabel} from the bank, then record it here — only then is the buyer told the money is on its way.</p>
                  <label><span className={label}>Sent on *</span><input type="date" name="sentAt" required defaultValue={today()} max={today()} className={input} /></label>
                  <label><span className={label}>Bank reference *</span><input name="bankRef" required minLength={3} maxLength={80} className={`${input} font-mono`} /></label>
                  <label><span className={label}>To IBAN</span><input name="payeeIban" defaultValue={r.payeeIban ?? ''} className={`${input} font-mono`} /></label>
                  <label><span className={label}>Proof (optional)</span><input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" className="text-xs w-full" /></label>
                  <div className="sm:col-span-2"><Button type="submit" size="sm" className="rounded-full">Mark refund sent &amp; email the buyer</Button></div>
                </OrderActionForm>
              )}
              {canRefund && r.status === 'SENT' && (
                <OrderActionForm action={confirmRefundAction} className="flex flex-wrap items-center gap-2" messageClassName="basis-full">
                  <input type="hidden" name="refundId" value={r.id} />
                  <Button type="submit" size="sm" variant="outline" className="rounded-full">Confirm — seen on the bank statement{r.method === 'STRIPE' ? ' / in Stripe' : ''}</Button>
                  <span className="text-[11px] text-muted-foreground">Internal reconciliation; the buyer is not emailed again.</span>
                </OrderActionForm>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 pt-4 text-xs text-muted-foreground">No refunds on this order.</p>
      )}
      {showForm && (
        <details className="border-t border-border" open={v.partPaidUnpaid || undefined}>
          <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-primary inline-flex items-center gap-1.5"><Undo2 className="h-4 w-4" /> Refund / credit an amount</summary>
          <div className="px-5 pb-5 space-y-3">
            <p className="text-xs text-muted-foreground">
              {v.partPaidUnpaid
                ? <>Part payment on an unpaid order (no invoice yet): refunding it needs no credit note; the order stays open until you cancel it (or the buyer pays the full amount). </>
                : null}
              Received {v.paidLabel}{v.refundedSentLabel ? `, refunded (sent) ${v.refundedSentLabel}` : ''}. At most <strong>{v.capacityLabels.max}</strong> incl. VAT can still be credited
              {v.capacity.receivableCents > 0 ? <> — the first {v.capacityLabels.receivable} cancels the unpaid invoice amount (no money moves), the rest is refunded as money</> : <> — refunded as money</>}.
              {v.invoiceNumber ? ` Each refund issues its own credit note against ${v.invoiceNumber} (exact VAT per rate).` : ' No invoice was issued, so no credit note is needed.'} Goods that come back go through a return (RMA) — after shipping a refund never puts stock back.
            </p>
            <RefundCreditForm
              orderId={o.id}
              orderNumber={o.orderNumber}
              defaultAmount={(v.capacity.maxCents / 100).toFixed(2)}
              currency={o.currency}
              hasInvoice={!!v.invoiceNumber}
              reasons={v.refundReasons}
              moneyBack={v.capacity.moneyCents > 0}
              canCard={v.canCardRefund}
              needsJustification={v.refundNeedsJustification}
              restockDefault={v.restockDefault}
              restockHint={v.restockHint}
            />
          </div>
        </details>
      )}
    </section>
  );
}
