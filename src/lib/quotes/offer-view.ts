import type { OfferCardProps } from '@/components/quotes/OfferCard';
import type { OfferFormProps } from '@/components/quotes/OfferForm';
import { buyerVatRow, orderBuyerVatRow, vatTreatmentLabel } from '@/lib/tax/determine';
import { formatPrice } from '@/lib/utils';
import { isoDay, offerPhase, PAID_ORDER_STATES, offerMaxCents } from './offer';
import { daysFrom, incotermLabel, offerAmounts, parseOfferTerms, pctLabel } from './pricing';
import type { OfferDefaults } from './policy';

/**
 * Server-side builders for the offer UI, shared by the buyer quote page, the
 * seller inbox thread and the admin quote workspace — so every side shows the
 * same offer, the same totals and the same state. Pure (the pages load the data).
 */

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
  /** For the buyer's VAT row (freight rate, recorded buyer label — orderBuyerVatRow). */
  shippingVatRateBp?: number | null;
  buyerVatId?: string | null;
  vatDecidedAt?: Date | null;
  pricingSnapshot?: unknown;
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
  // The VAT row as the buyer read it (title "VAT 21% on freight", buyer label);
  // staff keep the treatment's own name next to it.
  const orderRow = accepted && order && !legacyVat ? orderBuyerVatRow(order) : null;
  const offerRow = snap.vatDecided
    ? buyerVatRow({
        treatment: snap.vatTreatment, rateBp: snap.vatRateBp, shippingRateBp: terms?.vatBasis.shippingRateBp, shippingCents: snap.shippingCents,
        taxCents: snap.vatCents, buyerLabel: terms?.vatBasis.buyerLabel, hasVatId: !!terms?.vatBasis.vatId,
      })
    : null;

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
        vatLabel: legacyVat ? 'as charged (priced before the VAT rules)' : viewer === 'BUYER' && orderRow ? orderRow.label : vatTreatmentLabel(order.vatTreatment),
        vatRowLabel: orderRow?.title ?? null,
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
        vatLabel: viewer === 'BUYER' && offerRow ? offerRow.label : snap.vatTreatmentLabel,
        vatRowLabel: offerRow?.title ?? null,
        totalCents: snap.totalCents,
        vatNote: snap.vatDecided
          ? `${viewer === 'BUYER' ? 'Based on your billing details' : 'Based on the buyer’s billing details'}${terms?.vatBasis.country ? ` (${terms.vatBasis.country}${terms.vatBasis.vatId ? `, VAT ID ${terms.vatBasis.vatId}` : ''})` : ''} — confirmed when ${viewer === 'BUYER' ? 'you accept' : 'the buyer accepts'}.${terms?.vatBasis.legalText ? ` ${terms.vatBasis.legalText}` : ''}`
          : viewer === 'BUYER'
            ? 'VAT is added according to your billing country and VAT ID, which you confirm when you accept (e.g. 0% for EU businesses with a valid VAT ID or exports outside the EU).'
            : `VAT determined at acceptance — ${terms?.vatBasis.reasons[0] ?? 'the buyer has no billing details on file yet.'}`,
      };

  const voidReason =
    phase !== 'void' ? null
      : sr.status === 'DECLINED' ? `${viewer === 'BUYER' ? 'You declined this offer' : 'The buyer declined this offer'}${sr.lostReason ? ` — ${sr.lostReason}` : ''}.`
      : sr.status === 'CLOSED' ? `${sr.lostReason ? `${sr.lostReason}.` : 'Closed without a deal.'}${order?.status === 'CANCELED' ? ` Order ${order.orderNumber} was canceled — no payment is due.` : ''}`
      : order?.status === 'CANCELED' ? `Order ${order.orderNumber} was canceled — this offer can no longer be accepted.`
      : null;

  return {
    quoteId: sr.id,
    itemTitle: sr.product?.title ?? sr.productCategory ?? 'Requested equipment',
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

/** Offer composer props for staff / the assigned seller; null when no offer can be sent. */
export function offerFormProps(sr: SrForOffer & { archivedAt?: Date | null }, order: OrderForOffer, ctx: OfferFormContext): Omit<OfferFormProps, 'quoteId' | 'onResult'> | null {
  if (sr.status !== 'PENDING' && sr.status !== 'RESPONDED') return null;
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
  if (order?.status === 'CANCELED') return 'The accepted order was canceled — this quote is finished. Open a new quote for the buyer to send a new offer.';
  return `Price locked — the buyer accepted this offer${order ? ` (order ${order.orderNumber}` : ''}${sr.proformaNumber ? `${order ? ', ' : ' ('}proforma ${sr.proformaNumber})` : order ? ')' : ''}. To change it, cancel the order in the Deal panel (unpaid) or refund it (paid), then make a new offer on a new quote.`;
}

export { pctLabel };
