import type { OfferCardProps } from '@/components/quotes/OfferCard';
import type { OfferFormProps } from '@/components/quotes/OfferForm';
import { vatTreatmentLabel, type VatDecision } from '@/lib/tax/determine';
import { decodeEntities } from '@/lib/marketplace/import-clean';
import { escapeHtml, escapeHtmlLines, headerText } from '@/lib/email-html';
import { formatPrice } from '@/lib/utils';
import { QUOTE_REF, fmtDay, isoDay, offerPhase, PAID_ORDER_STATES, offerMaxCents, placeCountries, sentence, type CountryRef } from './offer';
import { daysFrom, incotermLabel, offerAmounts, parseOfferTerms, pctLabel, type OfferTerms } from './pricing';
import { mailLayout, mailTable } from './mail';
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
  /** CHOSEN by whoever sent the offer, or read from the Incoterm PLACE (an offer without freight). */
  destinationSource: 'CHOSEN' | 'PLACE' | null;
  allowUnpublished: boolean;
}

const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Tolerant read of the item part of a stored offerTerms JSON. */
export function parseOfferItem(raw: unknown): OfferItem {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const cond = txt(o.itemCondition);
  const dest = txt(o.destinationCountry);
  const destinationCountry = dest && /^[A-Z]{2}$/.test(dest) ? dest : null;
  return {
    itemTitle: txt(o.itemTitle),
    itemDescription: txt(o.itemDescription),
    itemCondition: cond === 'NEW' || cond === 'REFURBISHED' || cond === 'USED' ? cond : null,
    itemSerial: txt(o.itemSerial),
    destinationCountry,
    destinationSource: destinationCountry && (o.destinationSource === 'CHOSEN' || o.destinationSource === 'PLACE') ? o.destinationSource : null,
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

/** The composer's item fields: what the form shows and sends back with the offer (OfferInput). */
export type OfferItemPrefill = OfferItem & {
  /** The request has no listing of its own: sendOffer refuses an offer without an item title. */
  titleRequired: boolean;
};

/**
 * Prefill of the offer composer's item fields: the current offer, else the
 * listing. The destination is the current offer's, else the country its
 * Incoterm place names (the ISO reading of "Berlin, DE" — staff confirm it; an
 * offer with freight is refused without an explicit destination).
 */
export function offerItemPrefill(
  sr: { offerTerms?: unknown; product?: { title: string } | null; productCategory?: string | null; similarToProductId?: string | null; productId?: string | null },
  place: { incoterm: string | null; incotermPlace: string | null; countries?: readonly CountryRef[] } = { incoterm: null, incotermPlace: null },
): OfferItemPrefill {
  const cur = parseOfferItem(sr.offerTerms);
  const fromPlace = cur.destinationCountry ? null : placeCountries(place.incoterm, place.incotermPlace, place.countries ?? [])?.[0] ?? null;
  return {
    ...cur,
    itemTitle: cur.itemTitle ?? (sr.product ? decodeEntities(sr.product.title) : null),
    destinationCountry: cur.destinationCountry ?? fromPlace,
    destinationSource: cur.destinationCountry ? cur.destinationSource : fromPlace ? 'PLACE' : null,
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
  /** The country list (countryOptions()): lets the item prefill read a destination from the Incoterm place. */
  countries?: readonly CountryRef[];
}

/**
 * The composer's props. `item` is the item prefill the form must send back
 * with the offer (itemTitle, itemDescription, itemCondition, itemSerial,
 * destinationCountry, allowUnpublished — see OfferInput in actions.ts): an
 * item title is required when `item.titleRequired`, a destination country
 * whenever the offer carries freight.
 */
export type OfferFormServerProps = Omit<OfferFormProps, 'quoteId' | 'onResult'> & { item: OfferItemPrefill };

/** Offer composer props for staff / the assigned seller; null when no offer can be sent.
 *  A declined offer can be re-quoted on the same request (revision + 1). */
export function offerFormProps(
  sr: SrForOffer & { archivedAt?: Date | null; productId: string | null; similarToProductId: string | null },
  order: OrderForOffer,
  ctx: OfferFormContext,
): OfferFormServerProps | null {
  if (sr.status !== 'PENDING' && sr.status !== 'RESPONDED' && sr.status !== 'DECLINED') return null;
  const phase = offerPhase(sr, order);
  if (phase === 'accepted') return null; // legacy: paid / proof in flight
  const terms = parseOfferTerms(sr.offerTerms);
  const d = ctx.defaults;
  const warranty = ctx.productWarranty && !/^no warranty/i.test(ctx.productWarranty) ? ctx.productWarranty : d.warrantyFallback || ctx.productWarranty || '';
  const hasOffer = sr.quotedPriceCents != null;
  return {
    item: offerItemPrefill(sr, {
      incoterm: hasOffer ? terms?.incoterm ?? null : d.incoterm,
      incotermPlace: hasOffer ? terms?.incotermPlace ?? null : d.incotermPlace,
      countries: ctx.countries,
    }),
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

// ── What the buyer reads about an offer (thread message, offer mail) ─────────

/** Amount rows of the offer / acceptance mails. */
export function offerMailRows(o: {
  qty: number; unitCents: number; goodsCents: number; shippingCents: number; vatDecided: boolean; vatRateBp: number | null;
  vatCents: number | null; vatLabel: string | null; totalCents: number; currency: string;
}): string {
  const m = (c: number) => escapeHtml(formatPrice(c, o.currency));
  const rows: Array<[string, string, boolean?]> = [];
  rows.push([o.qty > 1 ? `Price (${o.qty} × ${m(o.unitCents)})` : 'Price', m(o.goodsCents)]);
  if (o.shippingCents > 0) rows.push(['Freight / shipping', m(o.shippingCents)]);
  if (o.vatDecided) rows.push([`VAT ${pctLabel(o.vatRateBp)}${o.vatLabel ? ` <span style="color:#6b7280;font-size:12px;">(${escapeHtml(o.vatLabel)})</span>` : ''}`, m(o.vatCents ?? 0)]);
  else rows.push(['VAT', '<span style="color:#6b7280;">determined from your billing details when you accept</span>']);
  rows.push([o.vatDecided ? 'Total' : 'Total excl. VAT', m(o.totalCents), true]);
  return mailTable(rows);
}

/** Delivery / lead time / warranty / payment / validity rows of the offer mail. */
export function termsMailRows(t: OfferTerms, validUntil: Date): string {
  const rows: Array<[string, string]> = [];
  const inc = incotermLabel(t);
  if (inc) rows.push(['Delivery terms', escapeHtml(inc)]);
  if (t.leadTime) rows.push(['Lead time', `<span dir="auto">${escapeHtml(t.leadTime)}</span>`]);
  if (t.warranty) rows.push(['Warranty', `<span dir="auto">${escapeHtml(t.warranty)}</span>`]);
  rows.push(['Payment', escapeHtml(t.paymentTerms.text)]);
  rows.push(['Valid until', `<strong>${escapeHtml(fmtDay(validUntil))}</strong>`]);
  return mailTable(rows);
}

/** One offer revision as published: everything the thread message and the offer mail say. */
export interface OfferAnnouncement {
  quoteId: string;
  revision: number;
  isUpdate: boolean;
  itemTitle: string;
  item: Pick<OfferItem, 'itemCondition' | 'itemSerial' | 'itemDescription'>;
  /** Name of the country the offer is priced for; null = any. */
  destinationName: string | null;
  currency: string;
  qty: number;
  unitCents: number;
  goodsCents: number;
  shippingCents: number;
  /** Null while the VAT is decided at acceptance. */
  vat: { treatment: string; rateBp: number; cents: number } | null;
  totalCents: number;
  validUntil: Date;
  previous: { cents: number; currency: string; exclVat: boolean } | null;
  /** The frozen terms (Incoterm + place, lead time, warranty, payment). */
  terms: OfferTerms;
  note: string | null;
}

/** The offer as a message in the quote thread (no supplier as author — see publishOffer). */
export function offerThreadBody(a: OfferAnnouncement): string {
  const money = (x: number) => formatPrice(x, a.currency);
  return [
    `${a.isUpdate ? 'Updated offer' : 'Offer'} (revision ${a.revision}) for "${a.itemTitle}": ${a.qty > 1 ? `${a.qty} × ${money(a.unitCents)} = ` : ''}${money(a.goodsCents)}${a.shippingCents ? ` + freight ${money(a.shippingCents)}` : ''} excl. VAT${a.vat ? `; VAT ${pctLabel(a.vat.rateBp)}: ${money(a.vat.cents)}; total ${money(a.totalCents)}` : '; VAT is determined from your billing details when you accept'}. Valid until ${fmtDay(a.validUntil)}.`,
    [a.item.itemCondition ? `Condition: ${a.item.itemCondition.toLowerCase()}` : '', a.item.itemSerial ? `Serial number: ${a.item.itemSerial}` : '', a.destinationName ? `Priced for delivery to ${a.destinationName}` : ''].filter(Boolean).join(' · '),
    a.item.itemDescription ?? '',
    a.isUpdate && a.previous ? `Previous offer: ${formatPrice(a.previous.cents, a.previous.currency)}${a.previous.exclVat ? ' excl. VAT' : ''}.` : '',
    [incotermLabel(a.terms), a.terms.leadTime ? `Lead time: ${a.terms.leadTime}` : '', a.terms.warranty ? `Warranty: ${a.terms.warranty}` : '', a.terms.paymentTerms.text].filter(Boolean).join(' · '),
    'Accept or decline it at the top of this page. Nothing is ordered until you accept.',
    a.note ? `\nNote: ${a.note}` : '',
  ].filter(Boolean).join('\n');
}

/** The offer mail to the buyer ("Your offer is ready" / "Your offer was updated"). */
export function offerMail(
  a: OfferAnnouncement,
  m: { buyerName: string; buyerLink: string; termsHref: string; quotationAttached: boolean },
): { subject: string; html: string } {
  const money = (x: number) => formatPrice(x, a.currency);
  const itemRows: Array<[string, string]> = [];
  if (a.item.itemCondition) itemRows.push(['Condition', escapeHtml(a.item.itemCondition.charAt(0) + a.item.itemCondition.slice(1).toLowerCase())]);
  if (a.item.itemSerial) itemRows.push(['Serial number', `<span dir="auto">${escapeHtml(a.item.itemSerial)}</span>`]);
  if (a.destinationName) itemRows.push(['Priced for delivery to', escapeHtml(a.destinationName)]);
  const prevLine = a.isUpdate && a.previous
    ? `<p style="margin:0 0 12px;color:#4b5563;">Previous offer: <s>${escapeHtml(formatPrice(a.previous.cents, a.previous.currency))}${a.previous.exclVat ? ' excl. VAT' : ''}</s></p>`
    : '';
  return {
    subject: `[${QUOTE_REF(a.quoteId)}] ${a.isUpdate ? 'Updated offer' : 'Your offer'} for ${headerText(a.itemTitle, 90)}: ${money(a.totalCents)}${a.vat ? '' : ' excl. VAT'}`,
    html: mailLayout({
      heading: a.isUpdate ? 'Your offer was updated' : 'Your offer is ready',
      body: [
        `Hi <span dir="auto">${escapeHtml(m.buyerName)}</span>,`,
        `${a.isUpdate ? 'We updated our offer' : 'Here is our offer'} for <strong dir="auto">${escapeHtml(a.itemTitle)}</strong>:`,
        a.item.itemDescription ? `<p dir="auto" style="margin:0 0 12px;color:#374151;">${escapeHtmlLines(a.item.itemDescription)}</p>` : '',
        itemRows.length ? mailTable(itemRows) : '',
        offerMailRows({
          qty: a.qty, unitCents: a.unitCents, goodsCents: a.goodsCents, shippingCents: a.shippingCents, vatDecided: !!a.vat, vatRateBp: a.vat?.rateBp ?? null,
          vatCents: a.vat?.cents ?? null, vatLabel: a.vat ? vatTreatmentLabel(a.vat.treatment) : null, totalCents: a.totalCents, currency: a.currency,
        }),
        prevLine,
        termsMailRows(a.terms, a.validUntil),
        a.note ? `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;color:#374151;">${escapeHtmlLines(a.note)}</blockquote>` : '',
        m.quotationAttached ? 'The quotation is attached as a PDF (for your purchase order).' : '',
      ].filter(Boolean),
      cta: { href: m.buyerLink, label: 'Review and accept the offer' },
      footer: [
        'Nothing is ordered yet. When you accept, you confirm your billing and delivery details; we then create your order and email you the proforma invoice (PDF) with the bank details.',
        `This offer is subject to our <a href="${escapeHtml(m.termsHref)}">General Terms of Sale</a> · Reference ${QUOTE_REF(a.quoteId)}`,
      ],
    }),
  };
}

export { pctLabel };
