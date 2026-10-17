'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Send, Lightbulb, Package } from 'lucide-react';
import { sendOffer, type QuoteActionResult } from '@/lib/quotes/actions';
import { formatPrice } from '@/lib/utils';
import { previewTax } from '@/lib/quotes/pricing';

export interface OfferFormProps {
  quoteId: string;
  /** STAFF publish the offer to the buyer; a SELLER sends a proposal to lab2date. */
  mode: 'STAFF' | 'SELLER';
  /** The open offer, prefilled when updating. */
  current?: {
    unitCents: number; qty: number; currency: string; shippingCents: number; note: string | null; validUntilISO: string | null; expired: boolean;
    incoterm: string | null; incotermPlace: string | null; leadTime: string; warranty: string; paymentDays: number; revision: number;
  } | null;
  /** Settings → Quotes & offers / Payments defaults (server). */
  defaults: {
    currency: string; currencies: string[]; shippingCents: number; incoterms: string[]; incoterm: string; incotermPlace: string;
    leadTime: string; warranty: string; paymentDays: number; validUntil: string;
    /** Settings → Quotes & offers → Largest offer amount (goods, cents). */
    maxOfferCents?: number;
  };
  /** VAT the buyer gets (from their saved billing details), or decided at acceptance. */
  vat: { status: 'DECIDED'; goodsRateBp: number; shippingRateBp: number; label: string; explanation: string } | { status: 'AT_ACCEPTANCE'; explanation: string };
  /** Shown above the price — who receives the email. */
  recipientLabel: string;
  /** A supplier proposal waiting for review (staff only). */
  proposal?: { costCents: number; currency: string; note: string | null; leadTime: string | null; warranty: string | null; suggestedUnitCents: number; markupLabel: string; atISO: string } | null;
  /** Availability of the listed unit. */
  stock?: { text: string; tone: 'ok' | 'warn' | 'bad' } | null;
  /** SELLER mode with review switched off: the price goes to the buyer (+ lab2date margin) at once. */
  sellerDirect?: boolean;
  onResult?: (r: QuoteActionResult) => void;
}

const field = 'h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent';
const lbl = 'block text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1';
const pct = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/**
 * Staff "Send offer" / "Update offer" — price × quantity, freight, currency,
 * validity, Incoterms + place, lead time, warranty, payment term and a note.
 * The server freezes all of it as the offer snapshot. A supplier's form sends
 * a PROPOSAL to lab2date instead (price to lab2date, lead time, warranty).
 * No order or proforma is created until the buyer accepts.
 */
export function OfferForm(p: OfferFormProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const cur = p.current;
  const d = p.defaults;
  const maxOffer = d.maxOfferCents ?? 100_000_000;
  const seller = p.mode === 'SELLER';
  const [price, setPrice] = useState(cur ? (cur.unitCents / 100).toFixed(2) : '');
  const [qty, setQty] = useState(String(cur?.qty ?? 1));
  const [currency, setCurrency] = useState<string>(cur?.currency ?? d.currency);
  const [shipping, setShipping] = useState(((cur?.shippingCents ?? d.shippingCents) / 100).toFixed(2));
  const [validUntil, setValidUntil] = useState(cur?.validUntilISO && !cur.expired ? cur.validUntilISO.slice(0, 10) : d.validUntil);
  const [incoterm, setIncoterm] = useState(cur?.incoterm ?? d.incoterm);
  const [place, setPlace] = useState(cur?.incotermPlace ?? d.incotermPlace);
  const [leadTime, setLeadTime] = useState(cur?.leadTime || d.leadTime);
  const [warranty, setWarranty] = useState(cur?.warranty || d.warranty);
  const [paymentDays, setPaymentDays] = useState(String(cur?.paymentDays ?? d.paymentDays));
  const [note, setNote] = useState(cur?.note ?? '');
  const [result, setResult] = useState<QuoteActionResult | null>(null);

  const unit = Math.round(parseFloat(price || '0') * 100);
  const q = Math.max(1, parseInt(qty || '1', 10) || 1);
  const ship = seller ? 0 : Math.max(0, Math.round(parseFloat(shipping || '0') * 100) || 0);
  const goods = unit * q;
  const valid = Number.isFinite(unit) && unit > 0;
  const tax = valid && p.vat.status === 'DECIDED' ? previewTax(goods, ship, p.vat.goodsRateBp, p.vat.shippingRateBp) : 0;
  const total = goods + ship + tax;

  function useProposal() {
    if (!p.proposal) return;
    setPrice((p.proposal.suggestedUnitCents / 100).toFixed(2));
    setQty('1');
    setCurrency(p.proposal.currency);
    if (p.proposal.leadTime) setLeadTime(p.proposal.leadTime);
    if (p.proposal.warranty) setWarranty(p.proposal.warranty);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    if (!valid) { setResult({ error: 'Enter a valid price.' }); return; }
    if (goods > maxOffer) { setResult({ error: `The maximum offer amount is ${formatPrice(maxOffer, currency)} (Settings → Quotes & offers).` }); return; }
    start(async () => {
      let r: QuoteActionResult;
      try {
        r = await sendOffer({
          sourcingRequestId: p.quoteId,
          priceCents: unit,
          qty: q,
          currency,
          shippingCents: ship,
          note: note.trim() || null,
          validUntil,
          incoterm: seller ? null : incoterm || null,
          incotermPlace: seller ? null : place.trim() || null,
          leadTime: leadTime.trim() || null,
          warranty: warranty.trim() || null,
          paymentDays: seller ? null : parseInt(paymentDays, 10) || null,
        });
      } catch (err) {
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        r = { error: 'The offer could not be sent — the request failed. Reload the page to check whether it was saved, then try again.' };
      }
      setResult(r);
      p.onResult?.(r);
      if (!r.error) router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 min-w-0" data-testid="offer-form">
      <p className="text-[11px] text-muted-foreground">{p.recipientLabel}</p>

      {p.stock && (
        <p className={`text-xs rounded-md px-3 py-1.5 border inline-flex items-center gap-1.5 ${
          p.stock.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
            : p.stock.tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
            : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
        }`} data-testid="offer-stock">
          <Package className="h-3.5 w-3.5 flex-shrink-0" /> {p.stock.text}
        </p>
      )}

      {!seller && p.proposal && (
        <div className="rounded-lg border-2 border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40 p-3 text-sm space-y-1" data-testid="offer-proposal">
          <p className="font-bold inline-flex items-center gap-1.5"><Lightbulb className="h-4 w-4" /> Supplier proposal: {formatPrice(p.proposal.costCents, p.proposal.currency)} excl. VAT</p>
          <p className="text-xs text-muted-foreground">Suggested buyer price {formatPrice(p.proposal.suggestedUnitCents, p.proposal.currency)} ({p.proposal.markupLabel}). The buyer has not seen anything yet.</p>
          {(p.proposal.leadTime || p.proposal.warranty) && (
            <p className="text-xs">{[p.proposal.leadTime && `Lead time: ${p.proposal.leadTime}`, p.proposal.warranty && `Warranty: ${p.proposal.warranty}`].filter(Boolean).join(' · ')}</p>
          )}
          {p.proposal.note && <p className="text-xs whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">“{p.proposal.note}”</p>}
          <button type="button" onClick={useProposal} className="mt-1 inline-flex items-center rounded-full bg-sky-700 text-white px-3 py-1 text-xs font-bold hover:bg-sky-800">
            Use the suggested price
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <label className="block col-span-2 sm:col-span-1">
          <span className={lbl}>{seller ? 'Your price (excl. VAT)' : 'Unit price (excl. VAT)'}</span>
          <input type="number" min="0.01" max={maxOffer / 100} step="0.01" required name="offerPrice" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="18500.00" className={`${field} w-full`} />
        </label>
        <label className="block">
          <span className={lbl}>Quantity</span>
          <input type="number" min="1" max="999" step="1" name="offerQty" value={qty} onChange={(e) => setQty(e.target.value)} className={`${field} w-full`} />
        </label>
        <label className="block">
          <span className={lbl}>Currency</span>
          <select name="offerCurrency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={`${field} w-full font-semibold px-2`}>
            {d.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        {!seller && (
          <label className="block col-span-2 sm:col-span-1">
            <span className={lbl}>Freight (excl. VAT)</span>
            <input type="number" min="0" step="0.01" name="offerShipping" value={shipping} onChange={(e) => setShipping(e.target.value)} className={`${field} w-full`} />
          </label>
        )}
        <label className="block col-span-2 sm:col-span-1">
          <span className={lbl}>Valid until</span>
          <input type="date" required name="offerValidUntil" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className={`${field} w-full`} />
        </label>
        {!seller && (
          <>
            <label className="block">
              <span className={lbl}>Incoterm</span>
              <select name="offerIncoterm" value={incoterm} onChange={(e) => setIncoterm(e.target.value)} className={`${field} w-full px-2 font-semibold`}>
                {d.incoterms.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="block col-span-2 sm:col-span-2">
              <span className={lbl}>Named place</span>
              <input name="offerIncotermPlace" value={place} onChange={(e) => setPlace(e.target.value.slice(0, 120))} placeholder="e.g. Zoetermeer, NL" className={`${field} w-full`} />
            </label>
            <label className="block">
              <span className={lbl}>Pay within (days)</span>
              <input type="number" min="1" max="120" step="1" name="offerPaymentDays" value={paymentDays} onChange={(e) => setPaymentDays(e.target.value)} className={`${field} w-full`} />
            </label>
          </>
        )}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={lbl}>Lead time</span>
          <input name="offerLeadTime" value={leadTime} onChange={(e) => setLeadTime(e.target.value.slice(0, 200))} placeholder="e.g. Ships within 10 business days after payment" dir="auto" className={`${field} w-full`} />
        </label>
        <label className="block">
          <span className={lbl}>Warranty</span>
          <input name="offerWarranty" value={warranty} onChange={(e) => setWarranty(e.target.value.slice(0, 200))} placeholder="e.g. 6 months parts & labour" dir="auto" className={`${field} w-full`} />
        </label>
      </div>

      {valid && (
        <div className="rounded-lg bg-accent/[0.10] border border-accent/30 px-3 py-2 text-xs space-y-0.5" data-testid="offer-preview">
          {seller ? (
            <p><span className="text-muted-foreground">Your price to lab2date: </span><strong className="tabular-nums">{formatPrice(goods, currency)}</strong><span className="text-muted-foreground"> excl. VAT. {p.sellerDirect ? 'lab2date adds its margin and sends the buyer the offer right away.' : 'lab2date reviews it and sets the buyer price.'}</span></p>
          ) : (
            <>
              <p>
                <span className="text-muted-foreground">Buyer sees </span>
                <strong className="tabular-nums">{formatPrice(goods, currency)}</strong>
                {ship > 0 && <span className="text-muted-foreground"> + freight {formatPrice(ship, currency)}</span>}
                {p.vat.status === 'DECIDED'
                  ? <><span className="text-muted-foreground"> + VAT {pct(p.vat.goodsRateBp)} {formatPrice(tax, currency)} = </span><strong className="tabular-nums">{formatPrice(total, currency)}</strong></>
                  : <><span className="text-muted-foreground"> = </span><strong className="tabular-nums">{formatPrice(total, currency)}</strong><span className="text-muted-foreground"> excl. VAT</span></>}
              </p>
              <p className="text-muted-foreground">{p.vat.status === 'DECIDED' ? `${p.vat.label}: ${p.vat.explanation}` : p.vat.explanation}</p>
            </>
          )}
        </div>
      )}

      <label className="block">
        <span className={lbl}>{seller ? 'Note to lab2date (optional)' : 'Note to the buyer (optional)'}</span>
        <textarea
          name="offerNote" value={note} onChange={(e) => setNote(e.target.value.slice(0, 2000))}
          rows={3} maxLength={2000} dir="auto"
          placeholder={seller ? 'Condition, what is included, how soon you can ship…' : 'What is included, condition, installation…'}
          className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
        />
        <div className="text-right text-[10px] text-muted-foreground mt-1 tabular-nums">{note.length} / 2000</div>
      </label>
      {result?.error && <p role="alert" className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-md px-3 py-2 [overflow-wrap:anywhere]">{result.error}</p>}
      {result?.warning && <p role="status" className="text-xs text-amber-900 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded-md px-3 py-2">{result.warning}</p>}
      {result?.notice && <p role="status" className="text-xs text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-md px-3 py-2">{result.notice}</p>}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-muted-foreground max-w-md">
          {seller
            ? (p.sellerDirect ? 'The buyer gets an offer at your price plus lab2date’s margin (you stay anonymous to the buyer).' : 'lab2date reviews your price before the buyer sees an offer (you stay anonymous to the buyer).')
            : 'The buyer is emailed a link to review the offer and accept or decline it. No order or proforma is created until they accept.'}
        </p>
        <button type="submit" disabled={pending} className="rounded-full bg-accent text-accent-foreground hover:bg-accent/90 px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2 shadow-sm">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {seller ? (p.sellerDirect ? 'Send offer' : 'Send proposal to lab2date') : cur ? 'Update offer' : 'Send offer'}
        </button>
      </div>
    </form>
  );
}
