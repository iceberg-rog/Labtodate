import { CreditCard, ShieldAlert, CalendarClock, FileClock, Wallet } from 'lucide-react';
import { prisma } from '@/lib/db';
import { hasCapability } from '@/lib/auth-server';
import { settingString } from '@/lib/settings';
import { countryOptions } from '@/lib/compliance/country';
import { detailsSummary, orderDetailsProblems, prefillDetails } from '@/lib/orders/details';
import { cancelAfter, duePhase, effectiveDueDate, fmtDueDate } from '@/lib/orders/payment-due';
import { creditDefaults, creditTermsEnabled, paymentGraceDays, paymentTermDays, requireDetailsBeforePayment, vatIdRule } from '@/lib/quotes/policy';
import { creditStatusFor } from '@/lib/credit/terms';
import { formatPrice } from '@/lib/utils';
import { AdminDetailsCard } from '@/components/orders/DetailsCards';
import { OrderActionForm } from '@/components/admin/OrderActionForm';
import { Button } from '@/components/ui/button';
import {
  approveBuyerCredit, approveOrderOnTerms, declineTermsRequest, extendOrderDueDate, recordTermsPayment, revokeBuyerCredit,
} from '@/app/admin/quote-payment-actions';
import { releaseStockShortageAction } from '@/app/admin/actions';
import { onStockShortage } from '@/lib/payments/stock-shortage';

/**
 * Admin order page panels for the payment side (owner reports 5/6, A25, B07):
 * billing + delivery details (staff can enter them), due date (extend),
 * compliance hold (clear), credit terms (approve the buyer / the order on
 * terms, never "verify" without money) and payments received on terms.
 * Server component; every button posts a capability-checked server action.
 */
export async function OrderPaymentPanels({ orderId }: { orderId: string }) {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, orderNumber: true, status: true, buyerId: true, totalCents: true, currency: true, amountPaidCents: true, financialStatus: true,
      createdAt: true, dueAt: true, payableSince: true, holdReason: true, openHolds: true, holdNote: true, paymentSubmittedAt: true, paymentVerificationStatus: true, paymentMethodManual: true, customerType: true, poNumber: true, invoiceEmail: true,
      billingAddress: true, shippingAddress: true, sourcingRequestId: true, paymentTerms: true,
      sourcingRequest: { select: { validUntilAt: true, companyName: true, buyerName: true } },
      buyer: { select: { name: true } },
    },
  });
  if (!o) return null;
  const [canFinance, canClear, canFulfil] = await Promise.all([hasCapability('finance:manage'), hasCapability('compliance:clear'), hasCapability('orders:fulfil')]);
  const missing = orderDetailsProblems(o, { vatIdRule: vatIdRule() });
  const unpaid = o.status === 'PENDING_PAYMENT';
  const profile = await prisma.billingProfile.findUnique({
    where: { userId: o.buyerId },
    select: { legalName: true, contactName: true, vatId: true, address: true, country: true, phone: true, invoiceEmail: true, creditApproved: true, creditLimitCents: true, creditTermDays: true, creditApprovedAt: true },
  });
  const credit = await creditStatusFor(o.buyerId, o.totalCents, o.currency, { excludeOrderId: o.id });
  const due = effectiveDueDate({ dueAt: o.dueAt, createdAt: o.createdAt, payableSince: o.payableSince, legacyValidUntil: o.sourcingRequest?.validUntilAt ?? null }, paymentTermDays());
  const grace = paymentGraceDays();
  const phase = duePhase(new Date(), due, grace);
  const termsRequested = unpaid && o.paymentVerificationStatus === 'TERMS_REQUESTED';
  const onTerms = ['INVOICED_ON_TERMS', 'OVERDUE', 'PARTIALLY_PAID'].includes(o.financialStatus) && o.paymentMethodManual === 'INVOICE';
  const defaults = creditDefaults();
  const outstanding = o.totalCents - o.amountPaidCents;
  const input = 'h-9 px-2 rounded-md border border-input bg-background text-xs';
  const stockNote = (o.holdNote ?? '').split(' | ').find((p) => p.startsWith('STOCK_SHORTAGE:'))?.replace(/^STOCK_SHORTAGE:\s*/, '') ?? null;
  const paidFamily = o.status === 'PAID' || o.status === 'PROCESSING';

  return (
    <div className="space-y-5" data-testid="order-payment-panels">
      {/* Billing & delivery details — required before payment (owner report 5) */}
      {unpaid ? (
        <AdminDetailsCard
          orderId={o.id}
          prefill={prefillDetails({ billingAddress: o.billingAddress, shippingAddress: o.shippingAddress, poNumber: o.poNumber, invoiceEmail: o.invoiceEmail, profile, companyName: o.sourcingRequest?.companyName, buyerName: o.sourcingRequest?.buyerName ?? o.buyer.name })}
          countries={await countryOptions()}
          homeCountry={settingString('TAX_HOME_COUNTRY') || 'NL'}
          vatIdRule={vatIdRule()}
          missing={missing}
          summary={detailsSummary(o)}
          editable={canFulfil && o.paymentVerificationStatus !== 'AWAITING_VERIFICATION'}
          lockedReason={o.paymentVerificationStatus === 'AWAITING_VERIFICATION' ? 'A receipt is waiting for verification — verify or reject it first.' : null}
          testId="admin-details-card"
          title={requireDetailsBeforePayment() && missing.length ? 'Billing & delivery details — needed before verifying payment' : 'Billing & delivery details'}
        />
      ) : null}

      {/* Due date */}
      {unpaid && !o.holdReason && (
        <section className="rounded-2xl border border-border bg-card p-4 text-sm space-y-2" data-testid="admin-due-panel">
          <h2 className="text-sm font-bold inline-flex items-center gap-2"><CalendarClock className="h-4 w-4 text-primary" /> Payment due date</h2>
          <p className={phase === 'OPEN' ? 'text-muted-foreground' : 'text-red-700 dark:text-red-400 font-semibold'}>
            Due {fmtDueDate(due)}{phase === 'OVERDUE' ? ` — overdue; auto-cancel after ${fmtDueDate(cancelAfter(due, grace))} (if on in Settings)` : phase === 'CANCEL_DUE' ? ' — past the grace period' : ''}.
          </p>
          {canFulfil && (
            <OrderActionForm action={extendOrderDueDate} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="orderId" value={o.id} />
              <label className="block"><span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">New due date</span><input type="date" name="dueDate" required className={input} /></label>
              <label className="block flex-1 min-w-40"><span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Reason</span><input name="reason" required minLength={4} maxLength={300} placeholder="e.g. buyer’s PO approval takes longer" className={`${input} w-full`} /></label>
              <Button type="submit" size="sm" variant="outline" className="rounded-full">Extend &amp; re-send proforma</Button>
            </OrderActionForm>
          )}
        </section>
      )}

      {/* Compliance hold: cleared under "Pricing, VAT & holds" (OrderPricingPanel,
          every open hold with its action — one button per hold). This panel only
          says what the buyer sees meanwhile. */}
      {(o.holdReason === 'COMPLIANCE' || o.openHolds.includes('COMPLIANCE')) && (
        <section className="rounded-2xl border-2 border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-4 text-sm space-y-2" data-testid="admin-hold-panel">
          <h2 className="text-sm font-bold inline-flex items-center gap-2 text-amber-900 dark:text-amber-300"><ShieldAlert className="h-4 w-4" /> Compliance hold — no payment requested yet</h2>
          <p className="text-amber-900 dark:text-amber-300">{o.holdNote}</p>
          <p className="text-xs text-muted-foreground">
            The buyer sees “please do not pay yet” and no bank details. {canClear && unpaid
              ? 'Clear it under “Pricing, VAT & holds” above (what was checked is kept as the record): the payment term restarts today and the proforma is emailed.'
              : 'Clearing needs the compliance:clear permission.'}
          </p>
        </section>
      )}

      {/* Paid, but the unit is gone (verify / mark paid found no stock): staff
          refund it (Cancel & refund) or secure the unit and release the hold
          here — which issues the invoice. More resolutions follow (PKG-23). */}
      {onStockShortage(o) && (
        <section id="stock-shortage" className="rounded-2xl border-2 border-red-300 dark:border-red-800 bg-red-50/60 dark:bg-red-950/30 p-4 text-sm space-y-2 scroll-mt-28" data-testid="admin-stock-shortage">
          <h2 className="text-sm font-bold inline-flex items-center gap-2 text-red-900 dark:text-red-300"><ShieldAlert className="h-4 w-4" /> Stock shortage — paid, but the unit is no longer in stock</h2>
          {stockNote && <p className="text-red-900 dark:text-red-300 [overflow-wrap:anywhere]">{stockNote}</p>}
          <p className="text-xs text-muted-foreground">
            Shipping is blocked and no invoice was issued; the buyer was told we contact them. Agree with the buyer: a refund — “Cancel &amp; refund” under <a href="#actions" className="font-semibold text-primary hover:underline">Cancel this order</a>; another unit, or the same one later (backorder) — once the unit is secured, release the hold below: the invoice is issued and e-mailed and the order can ship.
          </p>
          {paidFamily && (canFinance ? (
            <OrderActionForm action={releaseStockShortageAction} className="space-y-2 rounded-xl border border-red-200 dark:border-red-900 bg-card p-3" confirmText={`Release the stock-shortage hold of ${o.orderNumber}? The invoice is issued and e-mailed to the buyer now, and the order can ship.`}>
              <input type="hidden" name="orderId" value={o.id} />
              <fieldset className="space-y-1">
                <legend className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Where the unit comes from</legend>
                {o.sourcingRequestId && <label className="flex items-start gap-2 text-xs"><input type="radio" name="source" value="LISTING" required className="mt-0.5" /> <span>Back in this listing’s stock — take it from stock now</span></label>}
                <label className="flex items-start gap-2 text-xs"><input type="radio" name="source" value="OUTSIDE" required className="mt-0.5" /> <span>Arranged outside the listing (another unit from the supplier) — the listing’s stock stays as it is</span></label>
              </fieldset>
              <label className="block"><span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">How it was secured (kept on the order)</span><input name="note" required minLength={4} maxLength={300} placeholder="e.g. second unit from the supplier, ships 24 Oct" className={`${input} w-full`} /></label>
              <Button type="submit" size="sm" className="rounded-full">Unit secured — release the hold &amp; issue the invoice</Button>
            </OrderActionForm>
          ) : (
            <p className="text-xs">Releasing the hold issues the invoice: it needs the finance:manage permission.</p>
          ))}
        </section>
      )}

      {/* Credit terms (B07) */}
      {(termsRequested || (unpaid && credit.approved) || onTerms || (unpaid && creditTermsEnabled())) && (
        <section className="rounded-2xl border border-border bg-card p-4 text-sm space-y-3" data-testid="admin-credit-panel">
          <h2 className="text-sm font-bold inline-flex items-center gap-2"><FileClock className="h-4 w-4 text-primary" /> Credit terms (pay on invoice)</h2>
          <p className="text-muted-foreground">
            {credit.approved
              ? `Buyer approved: NET ${credit.termDays}, limit ${formatPrice(credit.limitCents, 'EUR')}, open on terms ${formatPrice(credit.outstandingCents, 'EUR')}, available ${formatPrice(credit.availableCents, 'EUR')}.`
              : 'Buyer is not approved for credit — they prepay.'}
            {!creditTermsEnabled() && ' Invoice payment is switched off in Settings → Payments & credit terms.'}
          </p>
          {termsRequested && (
            <div className="rounded-xl border-2 border-sky-300 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/30 p-3 space-y-2">
              <p className="font-semibold">The buyer asked to pay this order on invoice. No money has been received.</p>
              <p className="text-xs text-muted-foreground">{credit.eligible ? 'Approving issues the tax invoice (UNPAID, with the due date of the buyer’s NET term) and releases the order for shipping.' : `Can not be approved: ${credit.reason}`}</p>
            </div>
          )}
          {canFinance && unpaid && credit.eligible && !o.holdReason && !o.paymentSubmittedAt && (
            <OrderActionForm action={approveOrderOnTerms} className="flex flex-wrap gap-2" confirmText={`Approve order ${o.orderNumber} on NET ${credit.termDays} terms? No payment is recorded; an unpaid invoice with a due date is issued and emailed, and the order can be shipped.`}>
              <input type="hidden" name="orderId" value={o.id} />
              <Button type="submit" size="sm" className="rounded-full" disabled={missing.length > 0}>Approve on invoice terms (NET {credit.termDays})</Button>
              {missing.length > 0 && <span className="text-xs text-amber-800 dark:text-amber-300 self-center">Add the billing &amp; delivery details first.</span>}
            </OrderActionForm>
          )}
          {canFinance && termsRequested && (
            <OrderActionForm action={declineTermsRequest} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="orderId" value={o.id} />
              <input name="reason" required minLength={4} maxLength={300} placeholder="Why not (the buyer sees it)" className={`${input} flex-1 min-w-48`} />
              <Button type="submit" size="sm" variant="outline" className="rounded-full">Decline — buyer pays by transfer</Button>
            </OrderActionForm>
          )}
          {canFinance && profile && !credit.approved && unpaid && (
            <details className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer text-xs font-semibold text-primary">Approve this buyer for credit…</summary>
              <OrderActionForm action={approveBuyerCredit} className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="userId" value={o.buyerId} />
                <label className="block"><span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Credit limit (€)</span><input name="limit" inputMode="decimal" defaultValue={defaults.limitCents ? (defaults.limitCents / 100).toFixed(2) : ''} required className={`${input} w-28`} /></label>
                <label className="block"><span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">NET days</span><input name="termDays" type="number" min={1} max={120} defaultValue={defaults.termDays} required className={`${input} w-20`} /></label>
                <label className="block flex-1 min-w-40"><span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Note (e.g. credit check)</span><input name="note" maxLength={300} className={`${input} w-full`} /></label>
                <Button type="submit" size="sm" variant="outline" className="rounded-full">Approve credit for {profile.legalName}</Button>
              </OrderActionForm>
            </details>
          )}
          {canFinance && credit.approved && (
            <OrderActionForm action={revokeBuyerCredit} className="inline" confirmText="Withdraw this buyer’s credit approval? New orders then prepay; open invoices stay due.">
              <input type="hidden" name="userId" value={o.buyerId} />
              <button type="submit" className="text-xs font-semibold text-red-700 dark:text-red-400 hover:underline">Withdraw credit approval</button>
            </OrderActionForm>
          )}
        </section>
      )}

      {/* Payments on an invoice approved on terms */}
      {onTerms && (
        <section className="rounded-2xl border border-border bg-card p-4 text-sm space-y-2" data-testid="admin-terms-payment">
          <h2 className="text-sm font-bold inline-flex items-center gap-2"><Wallet className="h-4 w-4 text-primary" /> On invoice terms — {o.financialStatus === 'PARTIALLY_PAID' ? 'partly paid' : 'unpaid'}</h2>
          <p className="text-muted-foreground">Received {formatPrice(o.amountPaidCents, o.currency)} of {formatPrice(o.totalCents, o.currency)} · open {formatPrice(outstanding, o.currency)}.</p>
          {canFinance && (
            <OrderActionForm action={recordTermsPayment} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="orderId" value={o.id} />
              <label className="block"><span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Amount ({o.currency})</span><input name="amount" inputMode="decimal" defaultValue={(outstanding / 100).toFixed(2)} required className={`${input} w-28`} /></label>
              <label className="block"><span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Value date</span><input type="date" name="receivedAt" required className={input} /></label>
              <label className="block flex-1 min-w-40"><span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Bank reference</span><input name="reference" maxLength={120} className={`${input} w-full`} /></label>
              <Button type="submit" size="sm" className="rounded-full"><CreditCard className="h-3.5 w-3.5" /> Record payment received</Button>
            </OrderActionForm>
          )}
        </section>
      )}
    </div>
  );
}
