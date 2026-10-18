import { AlertTriangle, FileWarning, ReceiptText } from 'lucide-react';
import { prisma } from '@/lib/db';
import { hasCapability } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { fmtDocMoney } from '@/lib/documents/render';
import { countryOptions } from '@/lib/compliance/country';
import { vatTreatmentLabel, type VatTreatmentCode } from '@/lib/tax/determine';
import { refundFacts } from '@/lib/finance/refunds';
import { treatmentsForCharged } from '@/lib/finance/vat-resolution';
import { getOrderDocuments } from '@/lib/documents/issue';
import { OrderActionForm } from '@/components/admin/OrderActionForm';
import { issueOrderInvoiceAction } from '@/app/admin/actions';
import {
  applyVatRulesAction, correctBillingAction, correctInvoiceAction, issueAsChargedAction, issueMissingCreditNoteAction,
  keepInvoiceAction, recordManualViesAction,
} from '@/app/admin/finance-actions';

/**
 * Admin order page — the money side after payment, per order:
 *  - a paid order whose invoice is held (VAT review / missing details /
 *    error): why, and every way out (retry, the VAT rules, confirm as charged,
 *    billing details, a VAT ID checked by hand);
 *  - an order refunded before credit notes existed: its missing credit note;
 *  - an issued invoice that is wrong: credit note + corrected invoice.
 * Every button posts a capability-checked action (lib/finance/*). Refunds
 * themselves (ledger + refund / credit form) are the “Money back” section.
 */
export async function OrderFinancePanel({ orderId }: { orderId: string }) {
  await ensureSettingsLoaded();
  const [o, facts, docs, canRefund, canFinance] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, orderNumber: true, status: true, financialStatus: true, currency: true, subtotalCents: true, shippingCents: true, taxCents: true, totalCents: true,
        amountPaidCents: true, vatTreatment: true, buyerVatId: true, holdReason: true, openHolds: true, holdNote: true,
        billingAddress: true, invoiceEmail: true, shippedAt: true, sourcingRequestId: true, paymentMethodManual: true,
      },
    }),
    refundFacts(orderId),
    getOrderDocuments(orderId),
    hasCapability('orders:refund'),
    hasCapability('finance:manage'),
  ]);
  if (!o || !facts) return null;
  const cur = (c: number) => fmtDocMoney(c, o.currency);
  const paidFamily = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(o.status);
  const holds = Array.from(new Set([...o.openHolds, ...(o.holdReason ? [o.holdReason] : [])]));
  const invoiceCurrent = facts.invoice && facts.creditableCents > 0 ? facts.invoice : null;
  // Held: no invoice yet — or a corrected invoice that could not be issued after its credit note
  // (a hold says so). An invoice credited by a refund / cancellation is not “held”: the refund
  // ledger keeps the order paid until the money is sent (lib/finance/refunds.ts). A stock
  // shortage withholds the invoice on purpose: it is resolved in the “Stock shortage” panel.
  const invoiceHeld = (paidFamily || facts.onTerms) && (o.status !== 'REFUNDED' && o.status !== 'CANCELED') && !holds.includes('STOCK_SHORTAGE')
    && (!facts.invoice || (!invoiceCurrent && holds.some((h) => h === 'INVOICE_PENDING' || h === 'VAT_REVIEW')));
  const vatReviewOnInvoice = !!invoiceCurrent && holds.includes('VAT_REVIEW');
  const notes = (o.holdNote ?? '').split(' | ').filter(Boolean);
  const holdDetail = (code: string) => notes.find((n) => n.startsWith(`${code}:`))?.slice(code.length + 1).trim() ?? null;
  const fit = treatmentsForCharged(o, o.buyerVatId);
  const bill = (o.billingAddress && typeof o.billingAddress === 'object' ? o.billingAddress : {}) as Record<string, unknown>;
  const addr = ((bill.address && typeof bill.address === 'object' ? bill.address : bill) as Record<string, unknown>);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const countries = invoiceHeld ? await countryOptions() : [];
  const field = 'h-9 px-2 rounded-md border border-input bg-background text-xs w-full';
  const lab = 'block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1';
  const btn = 'h-8 px-3 rounded-full text-xs font-bold';

  const sections: React.ReactNode[] = [];

  if (invoiceHeld) {
    const why = holdDetail('INVOICE_PENDING') ?? holdDetail('VAT_REVIEW') ?? notes.find((n) => /invoice|VAT/i.test(n)) ?? null;
    sections.push(
      <div key="held" className="rounded-xl border-2 border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-4 space-y-3" data-testid="invoice-held" id="invoice-held">
        <p className="font-bold text-amber-900 dark:text-amber-200 inline-flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Paid, invoice not issued{holds.includes('VAT_REVIEW') ? ' — VAT review' : ''}</p>
        <p className="text-xs leading-relaxed">{why ?? 'The invoice has not been issued yet.'}</p>
        <p className="text-xs text-muted-foreground">
          Charged: VAT {cur(o.taxCents)} on {cur(o.subtotalCents + o.shippingCents)}{fit.rateBp != null ? ` (${fit.rateBp / 100}%)` : ''}{o.vatTreatment ? ` · recorded: ${vatTreatmentLabel(o.vatTreatment)}` : ''}{o.buyerVatId ? ` · buyer VAT ID ${o.buyerVatId}` : ''}. The buyer is told the invoice follows once the VAT and billing details are complete.
        </p>
        {!canFinance ? (
          <p className="text-xs">Resolving needs the finance:manage permission.</p>
        ) : (
          <div className="space-y-3">
            <OrderActionForm action={issueOrderInvoiceAction} className="flex items-center gap-2 flex-wrap">
              <input type="hidden" name="orderId" value={o.id} />
              <button type="submit" className={`${btn} bg-amber-700 text-white hover:bg-amber-800`}>Try issuing again</button>
              <span className="text-[11px] text-muted-foreground">After fixing Settings → Company / Invoicing, or the billing details below.</span>
            </OrderActionForm>
            <details className="rounded-lg border border-border bg-card p-3" open={holds.includes('VAT_REVIEW')}>
              <summary className="cursor-pointer text-xs font-bold">Decide the VAT for this order</summary>
              <div className="mt-3 grid lg:grid-cols-2 gap-3">
                <OrderActionForm action={applyVatRulesAction} className="space-y-2 rounded-lg border border-border p-3" confirmText="Apply the VAT rules to this paid order? Its VAT and total follow the rules; a difference is refunded or shown as still due on the invoice, which is issued and e-mailed now.">
                  <input type="hidden" name="orderId" value={o.id} />
                  <p className="text-xs font-semibold">Apply the VAT rules</p>
                  <p className="text-[11px] text-muted-foreground">VIES is asked again. The order’s VAT and total follow the rules; paid too much → a refund of the difference is requested; too little → the invoice shows what is still due.</p>
                  <input name="note" required minLength={4} maxLength={300} placeholder="Why (e.g. VIES answered again; buyer confirmed delivery address)" className={field} />
                  <button type="submit" className={`${btn} bg-primary text-primary-foreground`}>Apply the rules & issue the invoice</button>
                </OrderActionForm>
                <OrderActionForm action={issueAsChargedAction} className="space-y-2 rounded-lg border border-border p-3" confirmText="Issue the invoice exactly as charged? Your reason is recorded with the invoice.">
                  <input type="hidden" name="orderId" value={o.id} />
                  <p className="text-xs font-semibold">Confirm the VAT as charged</p>
                  {fit.options.length ? (
                    <>
                      <select name="treatment" className={field} defaultValue={fit.options[0]}>
                        {fit.options.map((t) => <option key={t} value={t}>{vatTreatmentLabel(t as VatTreatmentCode)}</option>)}
                      </select>
                      <input name="note" required minLength={10} maxLength={300} placeholder="Why it is right (e.g. accountant confirmed — consumer, home VAT)" className={field} />
                      <button type="submit" className={`${btn} border border-border hover:bg-muted`}>Issue as charged</button>
                    </>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">The charged VAT does not match a rate — apply the VAT rules instead.</p>
                  )}
                </OrderActionForm>
              </div>
            </details>
            <details className="rounded-lg border border-border bg-card p-3">
              <summary className="cursor-pointer text-xs font-bold">Billing details (name, address, VAT ID)</summary>
              <OrderActionForm action={correctBillingAction} className="mt-3 grid sm:grid-cols-2 gap-2">
                <input type="hidden" name="orderId" value={o.id} />
                <label className="block"><span className={lab}>Legal name</span><input name="legalName" defaultValue={str(bill.company)} required className={field} /></label>
                <label className="block"><span className={lab}>Contact person</span><input name="contactName" defaultValue={str(bill.name)} className={field} /></label>
                <label className="block"><span className={lab}>Street and number</span><input name="line1" defaultValue={str(addr.line1)} required className={field} /></label>
                <label className="block"><span className={lab}>Address line 2</span><input name="line2" defaultValue={str(addr.line2)} className={field} /></label>
                <label className="block"><span className={lab}>Postal code</span><input name="postalCode" defaultValue={str(addr.postal_code) || str(addr.postalCode)} required className={field} /></label>
                <label className="block"><span className={lab}>City</span><input name="city" defaultValue={str(addr.city)} required className={field} /></label>
                <label className="block"><span className={lab}>Country</span>
                  <select name="country" defaultValue={str(addr.country).toUpperCase()} required className={field}>
                    <option value="">Choose…</option>
                    {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </select>
                </label>
                <label className="block"><span className={lab}>VAT ID</span><input name="vatId" defaultValue={o.buyerVatId ?? str(bill.vat)} placeholder="e.g. DE123456789" className={`${field} font-mono`} /></label>
                <label className="block sm:col-span-2"><span className={lab}>Invoice e-mail</span><input name="invoiceEmail" type="email" defaultValue={o.invoiceEmail ?? str(bill.email)} className={field} /></label>
                <div className="sm:col-span-2"><button type="submit" className={`${btn} border border-border hover:bg-muted`}>Save billing details</button></div>
              </OrderActionForm>
            </details>
            <details className="rounded-lg border border-border bg-card p-3">
              <summary className="cursor-pointer text-xs font-bold">Record a VAT ID check by hand (VIES down, proof on file)</summary>
              <OrderActionForm action={recordManualViesAction} className="mt-3 grid sm:grid-cols-[1fr_140px] gap-2">
                <input type="hidden" name="orderId" value={o.id} />
                <input name="vatId" defaultValue={o.buyerVatId ?? ''} required placeholder="DE123456789" className={`${field} font-mono`} />
                <select name="status" className={field} defaultValue="VALID"><option value="VALID">Valid</option><option value="INVALID">Not valid</option></select>
                <input name="note" required minLength={10} maxLength={300} placeholder="Evidence: VIES printout of 3 Oct 2026 / company register extract on file" className={`${field} sm:col-span-2`} />
                <div className="sm:col-span-2 flex items-center gap-2 flex-wrap"><button type="submit" className={`${btn} border border-border hover:bg-muted`}>Record the check</button><span className="text-[11px] text-muted-foreground">Kept as evidence; then apply the VAT rules.</span></div>
              </OrderActionForm>
            </details>
          </div>
        )}
      </div>,
    );
  }

  if (vatReviewOnInvoice && canFinance) {
    sections.push(
      <div key="vatinv" className="rounded-xl border-2 border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-4 space-y-2" data-testid="vat-review-invoiced">
        <p className="font-bold text-amber-900 dark:text-amber-200 inline-flex items-center gap-1.5"><FileWarning className="h-4 w-4" /> VAT review — invoice {invoiceCurrent!.number} may no longer fit</p>
        <p className="text-xs leading-relaxed">{holdDetail('VAT_REVIEW') ?? o.holdNote}</p>
        <OrderActionForm action={keepInvoiceAction} className="flex items-end gap-2 flex-wrap">
          <input type="hidden" name="orderId" value={o.id} />
          <label className="block flex-1 min-w-[16rem]"><span className={lab}>Keep the invoice — why</span><input name="note" required minLength={10} maxLength={300} placeholder="e.g. goods still delivered to the NL forwarder" className={field} /></label>
          <button type="submit" className={`${btn} border border-border hover:bg-muted`}>Keep invoice</button>
        </OrderActionForm>
        <p className="text-[11px] text-muted-foreground">Or correct it below (credit note + corrected invoice).</p>
      </div>,
    );
  }

  // Refunds (the ledger: mark sent / confirm) and the refund / credit form are ONE section on the
  // order page: “Money back — refunds & credit notes” (components/admin/fulfilment/AdminMoney.tsx),
  // on THE refund / credit core (lib/finance/refunds.ts). This panel keeps the invoice decisions.

  if (canRefund && o.status === 'REFUNDED' && facts.invoice && facts.creditableCents > 0) {
    sections.push(
      <OrderActionForm key="missing" action={issueMissingCreditNoteAction} className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-3 space-y-2" confirmText="Issue the missing credit note for this earlier refund? It says the amount was refunded; no new refund is made.">
        <input type="hidden" name="orderId" value={o.id} />
        <p className="text-xs font-bold">This order was refunded, but invoice {facts.invoice.number} still has {cur(facts.creditableCents)} uncredited</p>
        <p className="text-[11px] text-muted-foreground">Older refunds were made without a credit note. Issue it now: it credits the invoice and states that the amount was refunded (no money moves).</p>
        <input name="reason" required minLength={4} maxLength={300} placeholder="e.g. Refund of 12 May 2026 (order returned)" className={field} />
        <button type="submit" className={`${btn} border border-border hover:bg-muted`}>Issue the missing credit note</button>
      </OrderActionForm>,
    );
  }

  if (canFinance && invoiceCurrent && facts.creditedCents === 0 && (paidFamily || facts.onTerms)) {
    sections.push(
      <details key="correct" className="rounded-xl border border-border p-3" open={vatReviewOnInvoice}>
        <summary className="cursor-pointer text-xs font-bold inline-flex items-center gap-1.5"><ReceiptText className="h-3.5 w-3.5" /> Correct invoice {invoiceCurrent.number}{invoiceCurrent.legacy ? ' (older invoice)' : ''}…</summary>
        <OrderActionForm action={correctInvoiceAction} className="mt-3 space-y-2" announce confirmText={`Credit invoice ${invoiceCurrent.number} in full and issue a corrected invoice? Both are final documents.`}>
          <input type="hidden" name="orderId" value={o.id} />
          <p className="text-[11px] text-muted-foreground">An issued invoice never changes: a credit note cancels it in full (no money moves) and a corrected invoice — naming the one it replaces — is issued and e-mailed. Agree VAT corrections with your accountant.</p>
          <input name="reason" required minLength={10} maxLength={300} placeholder="What is wrong (e.g. NL buyer invoiced at 0% VAT — 21% applies)" className={field} />
          <div className="grid sm:grid-cols-2 gap-2">
            <label className="flex items-start gap-2 text-xs rounded-lg border border-border p-2"><input type="radio" name="mode" value="RULES" defaultChecked className="mt-0.5" /> <span><strong>VAT by the rules</strong> for the current details — a difference is refunded or shown as still due.</span></label>
            <label className="flex items-start gap-2 text-xs rounded-lg border border-border p-2"><input type="radio" name="mode" value="AS_CHARGED" className="mt-0.5" /> <span><strong>Same amounts</strong> (as charged), corrected details / treatment:
              <select name="treatment" className={`${field} mt-1`} defaultValue={fit.options[0] ?? ''}>
                {fit.options.length ? fit.options.map((t) => <option key={t} value={t}>{vatTreatmentLabel(t as VatTreatmentCode)}</option>) : <option value="">no treatment fits the charged VAT</option>}
              </select></span></label>
          </div>
          <button type="submit" className={`${btn} border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300`}>Credit & re-issue</button>
        </OrderActionForm>
      </details>,
    );
  }

  if (!sections.length) return null;
  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden scroll-mt-40" id="finance" data-section="order-finance">
      <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
        <ReceiptText className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">Invoice decisions &amp; corrections</h2>
        <span className="text-xs text-muted-foreground">{docs.creditNotes.length ? `${docs.creditNotes.length} credit note${docs.creditNotes.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div className="p-5 space-y-4">{sections}</div>
    </section>
  );
}
