'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, X, Clock, FileText, AlertTriangle, Lock, CreditCard, Truck, ShieldCheck, Wallet, Package } from 'lucide-react';
import { formatPrice } from '@/lib/utils';
import type { DetailsPrefill, VatIdRule } from '@/lib/orders/details';
import type { CountryOption } from '@/components/orders/OrderDetailsFields';
import { AcceptOfferPanel } from './AcceptOfferPanel';
import { DeclineOfferDialog } from './DeclineOfferDialog';
import { CancelOrderButton } from '@/components/orders/CancelOrderButton';

export interface OfferCardAmounts {
  qty: number;
  unitCents: number;
  goodsCents: number;
  shippingCents: number;
  netCents: number;
  /** VAT known (offer sent to a buyer with billing details on file, or accepted). */
  vatDecided: boolean;
  vatRateBp: number | null;
  vatCents: number | null;
  /** "Standard rate", "Intra-EU supply, 0% (reverse charge)" … (the buyer's wording for the buyer). */
  vatLabel: string | null;
  /** Title of the VAT row ("VAT 21%", "VAT 21% on freight"); absent → "VAT <rate>". */
  vatRowLabel?: string | null;
  /** Gross when VAT is decided, else the net total. */
  totalCents: number;
  /** Why the VAT is what it is / when it will be decided. */
  vatNote: string | null;
}

export interface OfferCardProps {
  quoteId: string;
  itemTitle: string;
  currency: string;
  /** Offer revision (1, 2, …; 0 = legacy offer without a snapshot). */
  revision: number;
  amounts: OfferCardAmounts;
  terms: { incoterm: string | null; leadTime: string | null; warranty: string | null; payment: string | null };
  validUntilISO: string | null;
  note: string | null;
  phase: 'open' | 'expired' | 'accepted' | 'void';
  /** quotedAt — the page auto-refreshes; a change closes the confirm step. */
  offerVersion: string | null;
  sentAtISO: string | null;
  viewer: 'BUYER' | 'STAFF';
  orderNumber?: string | null;
  proformaNumber?: string | null;
  invoiceNumber?: string | null;
  /** Payment due date of the accepted order. */
  dueDateISO?: string | null;
  paymentState?: 'awaiting' | 'review' | 'paid' | 'terms' | 'canceled' | 'refunded' | null;
  /** "Previous offer: €8,750 excl. VAT" after an update. */
  previousLabel?: string | null;
  /** Why the deal ended (declined reason, canceled order …). */
  voidReason?: string | null;
  /** Buyer acceptance step (billing + delivery details). */
  accept?: { prefill: DetailsPrefill; countries: CountryOption[]; homeCountry: string; vatIdRule?: VatIdRule; requireTerms: boolean; termsUrl: string } | null;
  decline?: { reasons: string[] } | null;
  /** Buyer may cancel the accepted, unpaid order. */
  cancel?: { orderNumber: string; reasons: string[] } | null;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const pct = (bp: number | null) => (bp == null ? '' : `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`);

/**
 * The offer as both sides see it: amounts (net, freight, VAT — decided by the
 * VAT rules for the buyer — and total), terms (Incoterms, lead time, warranty,
 * payment), validity and note. For the buyer it is the only way to accept
 * (with billing + delivery details and the exact total confirmed) or decline.
 */
export function OfferCard(p: OfferCardProps) {
  const [mode, setMode] = useState<'idle' | 'accept' | 'decline'>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const money = (c: number) => formatPrice(c, p.currency);
  const isBuyer = p.viewer === 'BUYER';
  const a = p.amounts;

  // Staff updated the offer while the buyer was confirming: close the step, say so.
  const seenVersion = useRef(p.offerVersion);
  useEffect(() => {
    if (seenVersion.current !== p.offerVersion) {
      seenVersion.current = p.offerVersion;
      if (mode !== 'idle') {
        setMode('idle');
        setInfo('The offer was just updated — review the new offer before accepting.');
      }
    }
  }, [p.offerVersion, mode]);

  const tone =
    p.phase === 'open' ? 'border-primary/50 bg-primary/[0.04]'
      : p.phase === 'accepted' && p.paymentState !== 'refunded' ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/30'
      : p.phase === 'expired' ? 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30'
      : 'border-border bg-muted';
  const heading =
    p.phase === 'accepted'
      ? (p.paymentState === 'paid' ? 'Offer accepted · paid'
        : p.paymentState === 'terms' ? 'Offer accepted · approved on invoice terms'
        : p.paymentState === 'review' ? 'Offer accepted · payment being verified'
        : p.paymentState === 'refunded' ? 'Offer accepted · order refunded'
        : p.paymentState === 'canceled' ? 'Offer accepted · order canceled'
        : isBuyer ? 'Offer accepted · awaiting your payment' : 'Offer accepted · awaiting payment')
      : p.phase === 'expired' ? 'Offer expired'
      : p.phase === 'void' ? 'Offer void · no deal'
      : isBuyer ? 'Offer received — your decision' : 'Offer sent — awaiting buyer';
  const struck = p.phase === 'void' || p.paymentState === 'canceled' || p.paymentState === 'refunded';

  return (
    <section aria-label="Offer" data-testid="offer-card" data-phase={p.phase} className={`mb-5 rounded-2xl border-2 p-4 sm:p-5 ${tone} min-w-0`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground inline-flex items-center gap-1.5 flex-wrap">
            {p.phase === 'accepted' ? <Check className="h-3.5 w-3.5 text-emerald-600" />
              : p.phase === 'expired' ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
              : p.phase === 'void' ? <X className="h-3.5 w-3.5" />
              : <FileText className="h-3.5 w-3.5 text-primary" />}
            {heading}
            {p.revision > 1 && <span className="normal-case tracking-normal font-semibold text-[11px]">· revision {p.revision}</span>}
          </p>
          <p className="text-sm text-muted-foreground mt-1 [overflow-wrap:anywhere]" dir="auto">{p.itemTitle}</p>
        </div>
        <div className="text-right">
          <p className={`text-3xl font-bold tabular-nums tracking-tight ${struck ? 'line-through text-muted-foreground' : ''}`} data-testid="offer-total">
            {money(a.totalCents)}
          </p>
          <p className="text-[11px] text-muted-foreground">{a.vatDecided ? 'total incl. VAT' : 'total excl. VAT'}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 text-sm" data-testid="offer-breakdown">
          <dt className="text-muted-foreground">{a.qty > 1 ? `Price (${a.qty} × ${money(a.unitCents)})` : 'Price'}</dt>
          <dd className="text-right tabular-nums">{money(a.goodsCents)}</dd>
          {a.shippingCents > 0 && (
            <>
              <dt className="text-muted-foreground">Freight / shipping</dt>
              <dd className="text-right tabular-nums">{money(a.shippingCents)}</dd>
            </>
          )}
          {a.vatDecided ? (
            <>
              <dt className="text-muted-foreground">{a.vatRowLabel ?? `VAT ${pct(a.vatRateBp)}`}{a.vatLabel ? <span className="block text-[11px]">{a.vatLabel}</span> : null}</dt>
              <dd className="text-right tabular-nums">{money(a.vatCents ?? 0)}</dd>
            </>
          ) : (
            <>
              <dt className="text-muted-foreground">VAT</dt>
              <dd className="text-right text-xs text-muted-foreground max-w-[12rem]">at acceptance</dd>
            </>
          )}
          <dt className="font-bold border-t border-border pt-1">{a.vatDecided ? 'Total' : 'Total excl. VAT'}</dt>
          <dd className="text-right tabular-nums font-bold border-t border-border pt-1">{money(a.totalCents)}</dd>
          {a.vatNote && <dd className="col-span-2 text-[11px] text-muted-foreground mt-1 [overflow-wrap:anywhere]" data-testid="offer-vat-note">{a.vatNote}</dd>}
        </dl>

        <ul className="text-sm space-y-1.5 min-w-0" data-testid="offer-terms">
          {p.terms.incoterm && <Term icon={<Truck className="h-3.5 w-3.5" />} label="Delivery" value={p.terms.incoterm} />}
          {p.terms.leadTime && <Term icon={<Package className="h-3.5 w-3.5" />} label="Lead time" value={p.terms.leadTime} />}
          {p.terms.warranty && <Term icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Warranty" value={p.terms.warranty} />}
          {p.terms.payment && <Term icon={<Wallet className="h-3.5 w-3.5" />} label="Payment" value={p.terms.payment} />}
        </ul>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {p.phase === 'accepted' && p.dueDateISO && (p.paymentState === 'awaiting' || p.paymentState === 'review') && (
          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> Payment due by <strong className="text-foreground">{day(p.dueDateISO)}</strong></span>
        )}
        {p.phase !== 'accepted' && p.validUntilISO && (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {p.phase === 'expired' ? 'Expired on' : p.phase === 'void' ? 'Was valid until' : 'Valid until'} <strong className="text-foreground">{day(p.validUntilISO)}</strong>
          </span>
        )}
        {p.sentAtISO && <span>Sent {day(p.sentAtISO)}</span>}
        {p.previousLabel && p.phase === 'open' && <span>Previous offer: <s>{p.previousLabel}</s></span>}
        {p.proformaNumber && <span>Proforma <span className="font-mono font-semibold text-foreground">{p.proformaNumber}</span></span>}
        {p.invoiceNumber && <span>Invoice <span className="font-mono font-semibold text-foreground">{p.invoiceNumber}</span></span>}
        {p.orderNumber && <span>Order <span className="font-mono font-semibold text-foreground">{p.orderNumber}</span></span>}
      </div>

      {p.note && (
        <blockquote dir="auto" className="mt-3 border-l-[3px] border-accent pl-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          {p.note}
        </blockquote>
      )}
      {p.voidReason && (
        <p className="mt-3 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-testid="offer-void-reason">{p.voidReason}</p>
      )}

      {/* ─── Buyer decision ─── */}
      {isBuyer && p.phase === 'open' && mode === 'idle' && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { setInfo(null); setMode('accept'); }}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 shadow-sm"
          >
            <Check className="h-4 w-4" /> Accept offer
          </button>
          {p.decline && (
            <button
              type="button"
              onClick={() => { setInfo(null); setMode('decline'); }}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-5 py-2.5 text-sm font-semibold hover:bg-foreground/5"
            >
              <X className="h-4 w-4" /> Decline
            </button>
          )}
          <span className="text-xs text-muted-foreground basis-full sm:basis-auto">Questions? Reply in the conversation below — nothing is ordered until you accept.</span>
        </div>
      )}
      {isBuyer && p.phase === 'open' && mode === 'accept' && p.accept && (
        <AcceptOfferPanel
          quoteId={p.quoteId}
          revision={p.revision}
          offerVersion={p.offerVersion}
          currency={p.currency}
          offerTotalLabel={`${money(a.totalCents)}${a.vatDecided ? '' : ' excl. VAT'}`}
          {...p.accept}
          onCancel={() => setMode('idle')}
        />
      )}
      {isBuyer && p.phase === 'open' && mode === 'decline' && p.decline && (
        <DeclineOfferDialog
          quoteId={p.quoteId}
          reasons={p.decline.reasons}
          onCancel={() => setMode('idle')}
          onDone={(msg) => { setMode('idle'); setNotice(msg); }}
        />
      )}
      {isBuyer && p.phase === 'expired' && (
        <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 px-4 py-3 text-sm" role="status">
          <strong>This offer expired — ask for a new offer.</strong> Write to us in the conversation below; you can accept as soon as we send an updated offer.
        </p>
      )}
      {!isBuyer && p.phase === 'accepted' && p.paymentState !== 'canceled' && p.paymentState !== 'refunded' && (
        <p className="mt-4 text-xs text-muted-foreground inline-flex items-start gap-1.5">
          <Lock className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> Price locked — the buyer accepted. A change means canceling the order (lab2date staff only) and a new offer.
        </p>
      )}
      {isBuyer && p.phase === 'accepted' && p.orderNumber && (
        <div className="mt-4 flex flex-wrap gap-2 items-center">
          {(p.paymentState === 'awaiting' || p.paymentState === 'review') && (
            <>
              <a href={`/app/orders/${p.orderNumber}/payment`} className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90">
                <CreditCard className="h-4 w-4" /> {p.paymentState === 'review' ? 'View payment status' : 'Go to payment'}
              </a>
              <a href={`/api/documents/proforma/${p.orderNumber}/pdf`} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-5 py-2.5 text-sm font-semibold hover:bg-foreground/5">
                <FileText className="h-4 w-4" /> Proforma (PDF)
              </a>
            </>
          )}
          {(p.paymentState === 'paid' || p.paymentState === 'terms' || p.paymentState === 'refunded') && (
            <>
              {p.invoiceNumber && (
                <a href={`/api/documents/invoice/${p.orderNumber}/pdf`} className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90">
                  <FileText className="h-4 w-4" /> Invoice {p.invoiceNumber} (PDF)
                </a>
              )}
              <a href={`/app/orders/${p.orderNumber}`} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-5 py-2.5 text-sm font-semibold hover:bg-foreground/5">
                View order
              </a>
            </>
          )}
          {p.cancel && p.paymentState === 'awaiting' && <CancelOrderButton orderNumber={p.cancel.orderNumber} reasons={p.cancel.reasons} compact />}
        </div>
      )}

      {info && (
        <p role="status" className="mt-4 text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-800">{info}</p>
      )}
      {notice && (
        <p role="status" className="mt-4 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800">{notice}</p>
      )}
    </section>
  );
}

function Term({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <li className="flex items-start gap-2 min-w-0">
      <span className="text-muted-foreground mt-0.5 flex-shrink-0">{icon}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]"><span className="text-muted-foreground">{label}: </span><span dir="auto">{value}</span></span>
    </li>
  );
}
