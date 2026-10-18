'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Send, Lightbulb, Package, AlertTriangle } from 'lucide-react';
import { sendOffer, type QuoteActionResult } from '@/lib/quotes/actions';
import { formatPrice } from '@/lib/utils';
import { previewTax } from '@/lib/quotes/pricing';
import { validUntilBounds } from './quote-view';

export type OfferItemConditionValue = 'NEW' | 'REFURBISHED' | 'USED';

/** The offered item as the composer prefills and sends it (offerTerms). */
export interface OfferFormItem {
  itemTitle: string | null;
  itemDescription: string | null;
  itemCondition: OfferItemConditionValue | null;
  itemSerial: string | null;
  /** ISO country the offer (freight, VAT) is priced for. */
  destinationCountry: string | null;
  /** The request has no listing of its own: the item title is required. */
  titleRequired?: boolean;
  /** Staff confirmed offering a listing that is not published (current offer). */
  allowUnpublished?: boolean;
}

export interface OfferFormProps {
  quoteId: string;
  /** STAFF publish the offer to the buyer; a SELLER sends a proposal to us. */
  mode: 'STAFF' | 'SELLER';
  /** The site name (siteName()). */
  brand?: string;
  /** The open offer, prefilled when updating. */
  current?: {
    unitCents: number; qty: number; currency: string; shippingCents: number; note: string | null; validUntilISO: string | null; expired: boolean;
    incoterm: string | null; incotermPlace: string | null; leadTime: string; warranty: string; paymentDays: number; revision: number;
  } | null;
  /** Item title / description / serial / condition and the destination (current offer, else the listing). */
  item?: OfferFormItem | null;
  /** Countries for the destination (countryOptions()); without them the field is a 2-letter code. */
  countries?: Array<{ code: string; name: string }>;
  /** Status of the quoted listing when it is not published (draft, under review …): staff must confirm. */
  listingUnpublished?: string | null;
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
  /** SELLER mode with review switched off: the price goes to the buyer (+ our margin) at once. */
  sellerDirect?: boolean;
  onResult?: (r: QuoteActionResult) => void;
}

const field = 'h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent';
const lbl = 'block text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1';
const pct = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/**
 * Staff "Send offer" / "Update offer" — the item (title, description, serial,
 * condition: printed on the proforma and the invoice), price × quantity,
 * freight and the country it is priced for, currency, validity, Incoterms +
 * place, lead time, warranty, payment term and a remark. The server freezes
 * all of it as the offer snapshot. A supplier's form sends a PROPOSAL to us
 * instead (price, item, lead time, warranty). No order or proforma is created
 * until the buyer accepts.
 */
export function OfferForm(p: OfferFormProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const cur = p.current;
  const d = p.defaults;
  // Our side by name ("Labtodate reviews it"); every page passes the brand.
  const us = p.brand || 'the team';
  const Us = us.charAt(0).toUpperCase() + us.slice(1);
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
  const [itemTitle, setItemTitle] = useState(p.item?.itemTitle ?? '');
  const [itemDescription, setItemDescription] = useState(p.item?.itemDescription ?? '');
  const [itemSerial, setItemSerial] = useState(p.item?.itemSerial ?? '');
  const [itemCondition, setItemCondition] = useState<OfferItemConditionValue | ''>(p.item?.itemCondition ?? '');
  const [destination, setDestination] = useState((p.item?.destinationCountry ?? '').toUpperCase());
  const [allowUnpublished, setAllowUnpublished] = useState(!!p.item?.allowUnpublished);
  const [result, setResult] = useState<QuoteActionResult | null>(null);
  const bounds = validUntilBounds();

  const unit = Math.round(parseFloat(price || '0') * 100);
  const q = Math.max(1, parseInt(qty || '1', 10) || 1);
  const ship = seller ? 0 : Math.max(0, Math.round(parseFloat(shipping || '0') * 100) || 0);
  const goods = unit * q;
  const valid = Number.isFinite(unit) && unit > 0;
  const tax = valid && p.vat.status === 'DECIDED' ? previewTax(goods, ship, p.vat.goodsRateBp, p.vat.shippingRateBp) : 0;
  const total = goods + ship + tax;
  const titleRequired = !!p.item?.titleRequired;
  const destinationNeeded = !seller && ship > 0;

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
    if (titleRequired && !itemTitle.trim()) { setResult({ error: 'Enter the item title — it is the goods line on the proforma and the invoice.' }); return; }
    if (!validUntil || validUntil < bounds.min || validUntil > bounds.max) { setResult({ error: 'The "valid until" date must be between today and one year from today.' }); return; }
    if (destinationNeeded && !/^[A-Z]{2}$/.test(destination)) { setResult({ error: 'Choose the destination country — the freight is priced for delivery there.' }); return; }
    if (!seller && p.listingUnpublished && !allowUnpublished) { setResult({ error: `The listing is not published (${p.listingUnpublished}). Tick the box to offer it anyway, or publish it first.` }); return; }
    // Built as a value first: fields the server does not know yet are dropped by its schema.
    const input = {
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
      itemTitle: itemTitle.trim() || null,
      itemDescription: itemDescription.trim() || null,
      itemCondition: itemCondition || null,
      itemSerial: itemSerial.trim() || null,
      destinationCountry: seller ? null : destination || null,
      ...(seller ? {} : { allowUnpublished: !!p.listingUnpublished && allowUnpublished }),
    };
    start(async () => {
      let r: QuoteActionResult;
      try {
        r = await sendOffer(input);
      } catch (err) {
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        r = { error: 'The offer could not be sent — the request failed. Reload the page to check whether it was saved, then try again.' };
      }
      setResult(r);
      p.onResult?.(r);
      if (!r.error) router.refresh();
    });
  }

  const countryName = p.countries?.find((c) => c.code === destination)?.name ?? null;

  return (
    <form onSubmit={submit} className="space-y-3 min-w-0" data-testid="offer-form">
      <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{p.recipientLabel}</p>

      {p.stock && (
        <p className={`text-xs rounded-md px-3 py-1.5 border inline-flex items-center gap-1.5 max-w-full [overflow-wrap:anywhere] ${
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

      {/* ─── The item: the goods line of the proforma and the invoice ─── */}
      <fieldset className="rounded-lg border border-border p-3 space-y-3 min-w-0" data-testid="offer-item">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Item</legend>
        <label className="block">
          <span className={lbl}>Item title (printed on proforma and invoice){titleRequired && <span className="text-red-600 dark:text-red-400"> *</span>}</span>
          <input
            name="offerItemTitle" value={itemTitle} onChange={(e) => setItemTitle(e.target.value.slice(0, 200))}
            required={titleRequired} maxLength={200} dir="auto"
            placeholder="e.g. Zeiss LSM 980 confocal microscope, 2021"
            className={`${field} w-full`}
          />
        </label>
        <label className="block">
          <span className={lbl}>Make / model and description (printed under the title)</span>
          <textarea
            name="offerItemDescription" value={itemDescription} onChange={(e) => setItemDescription(e.target.value.slice(0, 4000))}
            rows={2} maxLength={4000} dir="auto"
            placeholder="Make, model, year, configuration, what is included…"
            className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
          />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block min-w-0">
            <span className={lbl}>Serial number</span>
            <input name="offerItemSerial" value={itemSerial} onChange={(e) => setItemSerial(e.target.value.slice(0, 120))} maxLength={120} dir="auto" placeholder="e.g. 2802001234" className={`${field} w-full`} />
          </label>
          <label className="block min-w-0">
            <span className={lbl}>Condition</span>
            <select name="offerItemCondition" value={itemCondition} onChange={(e) => setItemCondition(e.target.value as OfferItemConditionValue | '')} className={`${field} w-full px-2`}>
              <option value="">— not stated —</option>
              <option value="NEW">New</option>
              <option value="REFURBISHED">Refurbished</option>
              <option value="USED">Used</option>
            </select>
          </label>
        </div>
      </fieldset>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <label className="block col-span-2 sm:col-span-1 min-w-0">
          <span className={lbl}>{seller ? 'Your price (excl. VAT)' : 'Unit price (excl. VAT)'}</span>
          <input type="number" min="0.01" max={maxOffer / 100} step="0.01" required name="offerPrice" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="18500.00" className={`${field} w-full`} />
        </label>
        <label className="block min-w-0">
          <span className={lbl}>Quantity</span>
          <input type="number" min="1" max="999" step="1" name="offerQty" value={qty} onChange={(e) => setQty(e.target.value)} className={`${field} w-full`} />
        </label>
        <label className="block min-w-0">
          <span className={lbl}>Currency</span>
          <select name="offerCurrency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={`${field} w-full font-semibold px-2`}>
            {d.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        {!seller && (
          <label className="block col-span-2 sm:col-span-1 min-w-0">
            <span className={lbl}>Freight (excl. VAT)</span>
            <input type="number" min="0" step="0.01" name="offerShipping" value={shipping} onChange={(e) => setShipping(e.target.value)} className={`${field} w-full`} />
          </label>
        )}
        <label className="block col-span-2 sm:col-span-1 min-w-0">
          <span className={lbl}>Valid until</span>
          <input type="date" required min={bounds.min} max={bounds.max} name="offerValidUntil" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className={`${field} w-full`} />
        </label>
        {!seller && (
          <>
            <label className="block min-w-0">
              <span className={lbl}>Incoterm</span>
              <select name="offerIncoterm" value={incoterm} onChange={(e) => setIncoterm(e.target.value)} className={`${field} w-full px-2 font-semibold`}>
                {d.incoterms.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="block col-span-2 sm:col-span-2 min-w-0">
              <span className={lbl}>Named place</span>
              <input name="offerIncotermPlace" value={place} onChange={(e) => setPlace(e.target.value.slice(0, 120))} placeholder="e.g. Zoetermeer, NL" className={`${field} w-full`} />
            </label>
            <label className="block min-w-0">
              <span className={lbl}>Pay within (days)</span>
              <input type="number" min="1" max="120" step="1" name="offerPaymentDays" value={paymentDays} onChange={(e) => setPaymentDays(e.target.value)} className={`${field} w-full`} />
            </label>
            <label className="block col-span-2 sm:col-span-4 min-w-0">
              <span className={lbl}>Destination country{destinationNeeded && <span className="text-red-600 dark:text-red-400"> *</span>} <span className="normal-case tracking-normal font-normal">(freight and VAT are priced for it; the buyer can not accept for another country)</span></span>
              {p.countries?.length ? (
                <select name="offerDestination" value={destination} onChange={(e) => setDestination(e.target.value)} required={destinationNeeded} className={`${field} w-full px-2`}>
                  <option value="">{destinationNeeded ? '— choose the country —' : '— not fixed (no freight) —'}</option>
                  {destination && !p.countries.some((c) => c.code === destination) && <option value={destination}>{destination}</option>}
                  {p.countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
              ) : (
                <input
                  name="offerDestination" value={destination} onChange={(e) => setDestination(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2))}
                  required={destinationNeeded} pattern="[A-Z]{2}" placeholder="e.g. DE" className={`${field} w-28`}
                />
              )}
            </label>
          </>
        )}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block min-w-0">
          <span className={lbl}>Lead time</span>
          <input name="offerLeadTime" value={leadTime} onChange={(e) => setLeadTime(e.target.value.slice(0, 200))} placeholder="e.g. Ships within 10 business days after payment" dir="auto" className={`${field} w-full`} />
        </label>
        <label className="block min-w-0">
          <span className={lbl}>Warranty</span>
          <input name="offerWarranty" value={warranty} onChange={(e) => setWarranty(e.target.value.slice(0, 200))} placeholder="e.g. 6 months parts & labour" dir="auto" className={`${field} w-full`} />
        </label>
      </div>

      {!seller && p.listingUnpublished && (
        <label className="flex items-start gap-2 text-xs rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 px-3 py-2 cursor-pointer" data-testid="offer-unpublished">
          <input type="checkbox" checked={allowUnpublished} onChange={(e) => setAllowUnpublished(e.target.checked)} className="mt-0.5 h-4 w-4" />
          <span><AlertTriangle className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />The listing is not published ({p.listingUnpublished}). Offer it anyway — recorded in the audit log.</span>
        </label>
      )}

      {valid && (
        <div className="rounded-lg bg-accent/[0.10] border border-accent/30 px-3 py-2 text-xs space-y-0.5 [overflow-wrap:anywhere]" data-testid="offer-preview">
          {seller ? (
            <p><span className="text-muted-foreground">Your price to {us}: </span><strong className="tabular-nums">{formatPrice(goods, currency)}</strong><span className="text-muted-foreground"> excl. VAT. {p.sellerDirect ? `${Us} adds its margin and sends the buyer the offer right away.` : `${Us} reviews it and sets the buyer price.`}</span></p>
          ) : (
            <>
              <p>
                <span className="text-muted-foreground">Buyer sees </span>
                <strong className="tabular-nums">{formatPrice(goods, currency)}</strong>
                {ship > 0 && <span className="text-muted-foreground"> + freight {formatPrice(ship, currency)}{countryName ? ` to ${countryName}` : ''}</span>}
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
        <span className={lbl}>{seller ? `Note to ${us} (optional)` : 'Remark to the buyer (also printed on documents) — optional'}</span>
        <textarea
          name="offerNote" value={note} onChange={(e) => setNote(e.target.value.slice(0, 2000))}
          rows={3} maxLength={2000} dir="auto"
          placeholder={seller ? 'Condition, what is included, how soon you can ship…' : 'Installation, delivery window, anything the buyer should know…'}
          className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
        />
        <div className="text-right text-[10px] text-muted-foreground mt-1 tabular-nums">{note.length} / 2000</div>
      </label>
      {result?.error && <p role="alert" className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-md px-3 py-2 [overflow-wrap:anywhere]">{result.error}</p>}
      {result?.warning && <p role="status" className="text-xs text-amber-900 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded-md px-3 py-2 [overflow-wrap:anywhere]">{result.warning}</p>}
      {result?.notice && <p role="status" className="text-xs text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-md px-3 py-2 [overflow-wrap:anywhere]">{result.notice}</p>}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-muted-foreground max-w-md">
          {seller
            ? (p.sellerDirect ? `The buyer gets an offer at your price plus ${us}’s margin (you stay anonymous to the buyer).` : `${Us} reviews your price before the buyer sees an offer (you stay anonymous to the buyer).`)
            : 'The buyer is emailed a link to review the offer and accept or decline it. No order or proforma is created until they accept.'}
        </p>
        <button type="submit" disabled={pending} className="rounded-full bg-accent text-accent-foreground hover:bg-accent/90 px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2 shadow-sm">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {seller ? (p.sellerDirect ? 'Send offer' : `Send proposal to ${us}`) : cur ? 'Update offer' : 'Send offer'}
        </button>
      </div>
    </form>
  );
}
