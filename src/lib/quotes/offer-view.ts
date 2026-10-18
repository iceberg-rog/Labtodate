import type { OfferCardProps } from '@/components/quotes/OfferCard';
import type { OfferFormProps } from '@/components/quotes/OfferForm';
import { vatTreatmentLabel, type VatDecision } from '@/lib/tax/determine';
import { decodeEntities } from '@/lib/marketplace/import-clean';
import { formatPrice } from '@/lib/utils';
import { isoDay, offerPhase, PAID_ORDER_STATES, offerMaxCents, sentence } from './offer';
import { daysFrom, incotermLabel, offerAmounts, parseOfferTerms, pctLabel } from './pricing';
import type { OfferDefaults } from './policy';

/**
 * Server-side builders for the offer UI, shared by the buyer quote page, the
 * seller inbox thread and the admin quote workspace — so every side shows the
 * same offer, the same totals and the same state. Pure (the pages load the data).
 */

// ── The offered item (offerTerms, next to the pricing snapshot of pricing.ts) ──

export type OfferItemCondition = 'NEW' | 'REFURBISHED' | 'USED';

/**
 * What the offer says it sells and where to: frozen in offerTerms with the
 * offer (itemTitle / itemDescription / itemCondition / itemSerial,
 * destinationCountry) and printed on the order line, the proforma and the
 * invoice. allowUnpublished: staff offered a listing that is not published.
 */
export interface OfferItem {
  itemTitle: string | null;
  itemDescription: string | null;
  itemCondition: OfferItemCondition | null;
  itemSerial: string | null;
  /** ISO country the offer (freight, VAT) is priced for; null = any. */
  destinationCountry: string | null;
  allowUnpublished: boolean;
}

const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Tolerant read of the item part of a stored offerTerms JSON. */
export function parseOfferItem(raw: unknown): OfferItem {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const cond = txt(o.itemCondition);
  const dest = txt(o.destinationCountry);
  return {
    itemTitle: txt(o.itemTitle),
    itemDescription: txt(o.itemDescription),
    itemCondition: cond === 'NEW' || cond === 'REFURBISHED' || cond === 'USED' ? cond : null,
    itemSerial: txt(o.itemSerial),
    destinationCountry: dest && /^[A-Z]{2}$/.test(dest) ? dest : null,
    allowUnpublished: o.allowUnpublished === true,
  };
}

/**
 * The goods line of a quote: the offer's item title, else the listing title,
 * else what the buyer asked for — as plain text (imported titles carry HTML
 * entities such as "&#8211;").
 */
export function offerItemTitle(sr: { offerTerms?: unknown; product?: { title: string } | null; productCategory?: string | null }): string {
  const t = parseOfferItem(sr.offerTerms).itemTitle ?? sr.product?.title ?? sr.productCategory ?? 'Requested equipment';
  return decodeEntities(t).replace(/\s+/g, ' ').trim() || 'Requested equipment';
}

/** Prefill of the offer composer's item fields (the current offer, else the listing). */
export function offerItemPrefill(sr: { offerTerms?: unknown; product?: { title: string } | null; productCategory?: string | null; similarToProductId?: string | null; productId?: string | null }): OfferItem & { titleRequired: boolean } {
  const cur = parseOfferItem(sr.offerTerms);
  return {
    ...cur,
    itemTitle: cur.itemTitle ?? (sr.product ? decodeEntities(sr.product.title) : null),
    // A request without its own listing ("Let us find it", "similar to …") has no title to fall back on.
    titleRequired: !sr.productId || !!sr.similarToProductId,
  };
}

/**
 * The buyer's explanation of a VAT decision — plain language, never the
 * engine's staff reasons ("… (policy)", "keep the export evidence"). A decision
 * that already carries a buyer explanation (VAT engine) keeps it.
 */
export function buyerVatExplanation(d: Pick<VatDecision, 'treatment' | 'rateBp' | 'shippingRateBp' | 'lines'> & { buyerExplanation?: string | null }): string {
  if (d.buyerExplanation) return d.buyerExplanation;
  const pct = pctLabel(d.rateBp);
  const main = ((): string => {
    switch (d.treatment) {
      case 'DOMESTIC_STANDARD': return `VAT ${pct} applies to this delivery.`;
      case 'EU_ICS_ZERO': return '0% VAT: intra-EU supply to a business with a valid EU VAT ID (reverse charge — you account for the VAT in your country).';
      case 'EU_B2C_HOME': return `VAT ${pct}: delivery within the EU without a confirmed EU VAT ID.`;
      case 'EU_B2C_OSS': return `VAT ${pct} of the delivery country.`;
      case 'EXPORT_ZERO': return '0% VAT: the goods are exported outside the EU.';
      case 'MARGIN_SCHEME': return 'Margin scheme for second-hand goods: the VAT is included in the price and not shown separately.';
      default: return 'The VAT is confirmed by our team before payment.';
    }
  })();
  const freight = d.lines.some((l) => l.lineType === 'SHIPPING') && d.shippingRateBp !== d.rateBp
    ? ` Freight: VAT ${pctLabel(d.shippingRateBp)}.`
    : '';
  return `${main}${freight}`;
}

export type SrForOffer = {
  id: string;
  status: string;
  quotedPriceCents: number | null;
  quotedCurrency: string | null;
  quotedNote: string | null;
  quotedAt: Date | null;
  validUntilAt: Date | null;
  proformaNumber: string | null;
  productCategory: string | null;
  product?: { title: string } | null;
  offerRevision?: number;
  offerSubtotalCents?: number | null;
  offerShippingCents?: number | null;
  offerVatTreatment?: string | null;
  offerVatRateBp?: number | null;
  offerVatCents?: number | null;
  offerTotalCents?: number | null;
  offerTerms?: unknown;
  lostReason?: string | null;
  lostNote?: string | null;
};

export type OrderForOffer = {
  orderNumber: string;
  status: string;
  paymentSubmittedAt?: Date | null;
  paymentVerificationStatus?: string | null;
  subtotalCents?: number;
  shippingCents?: number;
  taxCents?: number;
  totalCents?: number;
  currency?: string;
  vatTreatment?: string | null;
  vatRateBp?: number | null;
  dueAt?: Date | null;
  financialStatus?: string | null;
  items?: Array<{ quantity: number; priceCentsSnapshot: number }>;
} | null | undefined;

/** Payment state of a quote order as the offer card shows it. */
export function orderPaymentState(o: NonNullable<OrderForOffer> | null): OfferCardProps['paymentState'] {
  if (!o) return null;
  if (o.status === 'CANCELED') return 'canceled';
  if (o.status === 'REFUNDED') return 'refunded';
  if (o.financialStatus === 'INVOICED_ON_TERMS' || o.financialStatus === 'CREDIT_APPROVED' || o.financialStatus === 'OVERDUE') return 'terms';
  if (PAID_ORDER_STATES.includes(o.status)) return 'paid';
  if (o.paymentSubmittedAt) return 'review';
  return 'awaiting';
}

export function offerCardProps(
  sr: SrForOffer,
  order: OrderForOffer,
  viewer: 'BUYER' | 'STAFF',
  extra: Pick<OfferCardProps, 'accept' | 'decline' | 'cancel' | 'invoiceNumber'> = {},
): OfferCardProps | null {
  if (sr.quotedPriceCents == null) return null;
  const phase = offerPhase(sr, order);
  if (phase === 'none') return null;
  const terms = parseOfferTerms(sr.offerTerms);
  const snap = offerAmounts(sr);
  const qty = terms?.qty ?? 1;
  const paymentState = order ? orderPaymentState(order) : null;
  const accepted = phase === 'accepted' && !!order && order.totalCents != null && order.subtotalCents != null;
  const legacyVat = accepted && (!order?.vatTreatment || order.vatTreatment === 'LEGACY_UNSPECIFIED');
  const currency = (accepted && order?.currency) || sr.quotedCurrency || 'EUR';

  const amounts: OfferCardProps['amounts'] = accepted && order
    ? {
        qty: order.items?.[0]?.quantity ?? qty,
        unitCents: order.items?.[0]?.priceCentsSnapshot ?? order.subtotalCents ?? 0,
        goodsCents: order.subtotalCents ?? 0,
        shippingCents: order.shippingCents ?? 0,
        netCents: (order.subtotalCents ?? 0) + (order.shippingCents ?? 0),
        vatDecided: true,
        // Never derived back from cents (a 21.01% rate does not exist).
        vatRateBp: legacyVat ? null : order.vatRateBp ?? null,
        vatCents: order.taxCents ?? 0,
        vatLabel: legacyVat ? 'as charged (priced before the VAT rules)' : vatTreatmentLabel(order.vatTreatment),
        totalCents: order.totalCents ?? 0,
        vatNote: null,
      }
    : {
        qty,
        unitCents: terms?.unitCents || Math.round(snap.goodsCents / qty),
        goodsCents: snap.goodsCents,
        shippingCents: snap.shippingCents,
        netCents: snap.netCents,
        vatDecided: snap.vatDecided,
        vatRateBp: snap.vatRateBp,
        vatCents: snap.vatCents,
        vatLabel: snap.vatTreatmentLabel,
        totalCents: snap.totalCents,
        vatNote: snap.vatDecided
          ? `${viewer === 'BUYER' ? 'Based on your billing details' : 'Based on the buyer’s billing details'}${terms?.vatBasis.country ? ` (${terms.vatBasis.country}${terms.vatBasis.vatId ? `, VAT ID ${terms.vatBasis.vatId}` : ''})` : ''} — confirmed when ${viewer === 'BUYER' ? 'you accept' : 'the buyer accepts'}.${terms?.vatBasis.legalText ? ` ${terms.vatBasis.legalText}` : ''}`
          : viewer === 'BUYER'
            ? 'VAT is added according to your billing country and VAT ID, which you confirm when you accept (e.g. 0% for EU businesses with a valid VAT ID or exports outside the EU).'
            : `VAT determined at acceptance — ${terms?.vatBasis.reasons[0] ?? 'the buyer has no billing details on file yet.'}`,
      };

  const voidReason =
    phase !== 'void' ? null
      : sr.status === 'DECLINED' ? sentence(`${viewer === 'BUYER' ? 'You declined this offer' : 'The buyer declined this offer'}${sr.lostReason ? ` — ${sr.lostReason}` : ''}`)
      : sr.status === 'CLOSED' ? `${sr.lostReason ? sentence(sr.lostReason) : 'Closed without a deal.'}${order?.status === 'CANCELED' ? ` Order ${order.orderNumber} was canceled — no payment is due.` : ''}`
      : order?.status === 'CANCELED' ? `Order ${order.orderNumber} was canceled — this offer can no longer be accepted.`
      : null;

  return {
    quoteId: sr.id,
    itemTitle: offerItemTitle(sr),
    currency,
    revision: sr.offerRevision ?? 0,
    amounts,
    terms: {
      incoterm: incotermLabel(terms),
      leadTime: terms?.leadTime ?? null,
      warranty: terms?.warranty ?? null,
      payment: terms?.paymentTerms.text || null,
    },
    validUntilISO: sr.validUntilAt?.toISOString() ?? null,
    note: sr.quotedNote,
    phase,
    offerVersion: sr.quotedAt?.toISOString() ?? null,
    sentAtISO: sr.quotedAt?.toISOString() ?? null,
    viewer,
    orderNumber: phase === 'accepted' && order ? order.orderNumber : null,
    proformaNumber: phase === 'accepted' ? sr.proformaNumber : null,
    dueDateISO: phase === 'accepted' ? (order?.dueAt ?? (sr.status === 'ACCEPTED' ? sr.validUntilAt : null))?.toISOString() ?? null : null,
    paymentState: phase === 'accepted' ? paymentState : null,
    previousLabel: terms?.previous
      ? `${formatPrice(terms.previous.totalCents ?? terms.previous.netCents, terms.previous.currency)}${terms.previous.totalCents == null ? ' excl. VAT' : ''}`
      : null,
    voidReason,
    accept: phase === 'open' && viewer === 'BUYER' ? extra.accept ?? null : null,
    decline: phase === 'open' && viewer === 'BUYER' ? extra.decline ?? null : null,
    cancel: phase === 'accepted' && viewer === 'BUYER' && paymentState === 'awaiting' ? extra.cancel ?? null : null,
    invoiceNumber: extra.invoiceNumber ?? null,
  };
}

export interface OfferFormContext {
  mode: 'STAFF' | 'SELLER';
  recipientLabel: string;
  defaults: OfferDefaults;
  /** VAT the buyer would get (saved billing profile), or deferred to acceptance. */
  vat: OfferFormProps['vat'];
  /** The quoted listing's own warranty (item → condition), for the prefill. */
  productWarranty?: string | null;
  proposal?: OfferFormProps['proposal'];
  stock?: OfferFormProps['stock'];
}

/** Offer composer props for staff / the assigned seller; null when no offer can be sent.
 *  A declined offer can be re-quoted on the same request (revision + 1). */
export function offerFormProps(sr: SrForOffer & { archivedAt?: Date | null }, order: OrderForOffer, ctx: OfferFormContext): Omit<OfferFormProps, 'quoteId' | 'onResult'> | null {
  if (sr.status !== 'PENDING' && sr.status !== 'RESPONDED' && sr.status !== 'DECLINED') return null;
  const phase = offerPhase(sr, order);
  if (phase === 'accepted') return null; // legacy: paid / proof in flight
  const terms = parseOfferTerms(sr.offerTerms);
  const d = ctx.defaults;
  const warranty = ctx.productWarranty && !/^no warranty/i.test(ctx.productWarranty) ? ctx.productWarranty : d.warrantyFallback || ctx.productWarranty || '';
  return {
    mode: ctx.mode,
    current:
      sr.quotedPriceCents != null
        ? {
            unitCents: terms?.unitCents || Math.round((sr.offerSubtotalCents ?? sr.quotedPriceCents) / (terms?.qty ?? 1)),
            qty: terms?.qty ?? 1,
            currency: sr.quotedCurrency || d.currency,
            shippingCents: sr.offerShippingCents ?? 0,
            note: sr.quotedNote,
            validUntilISO: sr.validUntilAt?.toISOString() ?? null,
            expired: phase === 'expired',
            incoterm: terms?.incoterm ?? d.incoterm,
            incotermPlace: terms?.incotermPlace ?? d.incotermPlace,
            leadTime: terms?.leadTime ?? '',
            warranty: terms?.warranty ?? '',
            paymentDays: terms?.paymentTerms.days ?? d.paymentTermDays,
            revision: sr.offerRevision ?? 0,
          }
        : null,
    defaults: {
      currency: d.currency,
      currencies: d.currencies,
      shippingCents: d.shippingCents,
      incoterms: d.incoterms,
      incoterm: d.incoterm,
      incotermPlace: d.incotermPlace,
      leadTime: d.leadTime,
      warranty,
      paymentDays: d.paymentTermDays,
      validUntil: isoDay(daysFrom(new Date(), d.validDays)),
      maxOfferCents: offerMaxCents(),
    },
    vat: ctx.vat,
    recipientLabel: ctx.recipientLabel,
    proposal: ctx.proposal ?? null,
    stock: ctx.stock ?? null,
  };
}

/** Why staff can't change the price any more (accepted), else null. */
export function priceLockedMessage(sr: { status: string; proformaNumber: string | null }, order: OrderForOffer): string | null {
  if (sr.status !== 'ACCEPTED') return null;
  if (order?.status === 'CANCELED') return 'The accepted order was canceled — this quote is finished. Use “New quote for this buyer” to start a new request and send a new offer.';
  return `Price locked — the buyer accepted this offer${order ? ` (order ${order.orderNumber}` : ''}${sr.proformaNumber ? `${order ? ', ' : ' ('}proforma ${sr.proformaNumber})` : order ? ')' : ''}. To change it, cancel the order (“Cancel order” in the Deal panel while unpaid, a refund once paid), then use “New quote for this buyer”.`;
}

export { pctLabel };
