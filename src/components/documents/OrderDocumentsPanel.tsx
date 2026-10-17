import { FileText, Download, ExternalLink, AlertTriangle, ShieldCheck, Clock } from 'lucide-react';
import type { FiscalDocument } from '@prisma/client';
import { getOrderDocuments } from '@/lib/documents/issue';
import { documentNumberHref, docKindLabel } from '@/lib/documents';
import { vatTreatmentLabel } from '@/lib/tax/determine';
import { formatPrice } from '@/lib/utils';
import { OrderActionForm } from '@/components/admin/OrderActionForm';
import { issueOrderInvoiceAction, issueOrderProformaAction, reissueOrderProformaAction } from '@/app/admin/actions';
import { ensureSettingsLoaded, settingString } from '@/lib/settings';
import { businessTimeZone } from '@/lib/documents/numbering';

/**
 * Every document issued for an order — proforma revisions, the invoice,
 * credit notes — straight from the immutable FiscalDocument rows (each link
 * serves the stored PDF). Shown on the buyer's and the admin's order page.
 * Admins also see why an invoice was NOT issued (VAT review / missing
 * details) and can retry once that is fixed.
 */

const PAID = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'];

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: businessTimeZone() });
}

function DocRow({ doc, admin, paid, replacedBy }: { doc: FiscalDocument; admin: boolean; paid: boolean; replacedBy: string | null }) {
  // A void or replaced proforma is not payable: buyers get no download of it
  // (its stored PDF still says "Payment request"), only what to do instead.
  const deadProforma = doc.kind === 'PROFORMA' && (!!doc.voidedAt || !!doc.supersededById);
  const offerFile = admin || !deadProforma;
  const state = doc.voidedAt
    ? { label: 'Void', cls: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900' }
    : doc.supersededById
      ? { label: 'Replaced', cls: 'bg-muted text-muted-foreground border-border' }
      : doc.kind === 'CREDIT_NOTE'
        ? { label: 'Credit', cls: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900' }
        : doc.kind === 'PROFORMA' && paid
          ? { label: 'Settled', cls: 'bg-muted text-muted-foreground border-border' }
          : { label: doc.kind === 'INVOICE' ? 'Issued' : 'Current', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900' };
  return (
    <li className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-3 py-2.5" data-doc-number={doc.number}>
      <div className="min-w-0">
        <p className="text-sm font-semibold flex items-center gap-2 flex-wrap">
          {docKindLabel(doc.kind)}
          <span className="font-mono">{doc.number}</span>
          <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${state.cls}`}>{state.label}</span>
          {doc.legacy && <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900">Legacy</span>}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Issued {fmtDate(doc.issueDate)} · {formatPrice(doc.totalCents, doc.currency)}
          {doc.voidedAt && doc.voidReason ? ` · ${doc.voidReason}` : ''}
          {admin ? ` · ${vatTreatmentLabel(doc.vatTreatment)}` : ''}
          {admin && doc.sentAt ? ` · emailed ${fmtDate(doc.sentAt)}` : ''}
        </p>
        {admin && (
          <p className="text-[11px] text-muted-foreground mt-0.5 inline-flex items-center gap-1">
            <ShieldCheck className="h-3 w-3" />
            {doc.sha256 ? <>PDF stored · sha256 <span className="font-mono">{doc.sha256.slice(0, 16)}…</span></> : 'PDF not rendered yet (rendered and stored on first download)'}
          </p>
        )}
        {deadProforma && (
          <p className="text-xs font-semibold text-red-700 dark:text-red-300 mt-0.5" data-testid="dead-proforma-note">
            {doc.voidedAt ? 'Void — do not pay this proforma.' : `Replaced${replacedBy ? ` by ${replacedBy}` : ''} — do not pay this revision${replacedBy ? '; pay the current one' : ''}.`}
            {admin ? ' (Archived copy for the record.)' : ''}
          </p>
        )}
      </div>
      {offerFile && (
      <span className="inline-flex items-center gap-1.5 shrink-0">
        <a
          href={documentNumberHref(doc.number, 'pdf')}
          className="inline-flex items-center gap-1 h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90"
        >
          <Download className="h-3.5 w-3.5" /> PDF
        </a>
        <a
          href={documentNumberHref(doc.number, 'preview')}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <ExternalLink className="h-3.5 w-3.5" /> View
        </a>
      </span>
      )}
    </li>
  );
}

export async function OrderDocumentsPanel({
  order,
  audience,
}: {
  order: { id: string; orderNumber: string; status: string; holdReason?: string | null; holdNote?: string | null };
  audience: 'buyer' | 'admin';
}) {
  await ensureSettingsLoaded();
  const docs = await getOrderDocuments(order.id);
  const admin = audience === 'admin';
  const byId = new Map(docs.proformaHistory.map((d) => [d.id, d.number]));
  // Buyer view of an unpaid order on a pre-payment hold: no proforma (payment
  // request) is shown until the hold is released, even if its number exists.
  const prePaymentHeld = order.status === 'PENDING_PAYMENT' && !!order.holdReason && ['COMPLIANCE', 'VAT_REVIEW', 'ADDRESS_REVIEW', 'SHIPPING_PENDING'].includes(order.holdReason);
  const all = [...(admin || !prePaymentHeld ? docs.proformaHistory : []), ...docs.invoiceHistory, ...docs.creditNotes]
    .sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime());
  const paid = PAID.includes(order.status);
  // No invoice, or the only one was credited in full by a correction that has not been re-issued yet.
  const creditedOnCurrent = docs.invoice ? -docs.creditNotes.filter((c) => c.originalDocumentId === docs.invoice!.id).reduce((a, c) => a + c.totalCents, 0) : 0;
  const invoiceMissing = paid && order.status !== 'REFUNDED' && (!docs.invoice || creditedOnCurrent >= docs.invoice.totalCents);

  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden" data-section="order-documents">
      <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
        <FileText className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">Documents</h2>
        <span className="text-xs text-muted-foreground">issued documents never change — corrections are new documents</span>
      </div>
      <div className="px-5 py-2">
        {all.length === 0 ? (
          <>
          <p className="text-sm text-muted-foreground py-2">
            {order.status === 'PENDING_PAYMENT' && order.holdReason && ['COMPLIANCE', 'VAT_REVIEW', 'ADDRESS_REVIEW', 'SHIPPING_PENDING'].includes(order.holdReason)
              ? admin
                ? 'No proforma yet: the order is on hold (see “Pricing, VAT & holds”). The proforma — the payment request — is issued and emailed when the last hold is resolved.'
                : 'No proforma yet: we confirm the final total first. You receive the proforma (payment request) by email as soon as it is ready.'
              : order.status === 'PENDING_PAYMENT'
                ? admin
                  ? 'No proforma has been issued yet. Opening a link never issues one — use “Issue proforma” when the order is ready for payment.'
                  : 'Your proforma invoice (the payment request) is issued when you open the payment page, or when we email it to you.'
                : 'No documents were issued for this order.'}
          </p>
          {admin && order.status === 'PENDING_PAYMENT' && !docs.proforma && !prePaymentHeld && (
            <OrderActionForm action={issueOrderProformaAction} className="my-2 flex items-center gap-2 flex-wrap">
              <input type="hidden" name="orderId" value={order.id} />
              <button type="submit" className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90">
                Issue proforma
              </button>
              <span className="text-[11px] text-muted-foreground">Allocates the next proforma number for this order.</span>
            </OrderActionForm>
          )}
          </>
        ) : (
          <ul className="divide-y divide-border">
            {all.map((d) => <DocRow key={d.id} doc={d} admin={admin} paid={paid} replacedBy={d.supersededById ? byId.get(d.supersededById) ?? null : null} />)}
          </ul>
        )}
        {invoiceMissing && (
          admin ? (
            <div className="my-3 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 p-3 text-sm space-y-1">
              <p className="font-semibold inline-flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Paid, but no invoice issued yet</p>
              <p className="text-xs leading-relaxed">{(order.holdNote ?? 'The invoice was not issued.').split(' | ').map((n) => n.replace(/^(VAT_REVIEW|INVOICE_PENDING|COMPLIANCE|ADDRESS_REVIEW|SHIPPING_PENDING|PAYMENT_REVIEW):\s*/, '')).join(' · ')}</p>
              <p className="text-xs"><a href="#invoice-held" className="font-semibold underline">Resolve it under “Invoice, refunds &amp; corrections” ↓</a></p>
            </div>
          ) : (
            <p className="my-3 text-sm rounded-xl border border-border bg-foreground/[0.02] p-3 inline-flex items-start gap-2" data-testid="invoice-delayed">
              <Clock className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
              <span>{settingString('EMAIL_INVOICE_DELAYED_TEXT') || 'Your invoice is being prepared.'}</span>
            </p>
          )
        )}
        {admin && order.status === 'PENDING_PAYMENT' && docs.proforma && (
          <details className="my-2 text-xs">
            <summary className="cursor-pointer font-semibold text-muted-foreground hover:text-foreground">Issue a new proforma revision…</summary>
            <OrderActionForm action={reissueOrderProformaAction} className="mt-2 flex items-center gap-2 flex-wrap">
              <input type="hidden" name="orderId" value={order.id} />
              <input name="reason" required minLength={4} placeholder="Why (e.g. billing address added)" className="h-8 px-3 rounded-lg border border-input bg-background text-xs w-72" />
              <button type="submit" className="h-8 px-3 rounded-full border border-border text-xs font-bold hover:bg-muted">Issue revision</button>
            </OrderActionForm>
            <p className="mt-1 text-muted-foreground">The current proforma {docs.proforma.number} is kept as “Replaced”; the new revision reflects the order as it is now.</p>
          </details>
        )}
      </div>
    </section>
  );
}
