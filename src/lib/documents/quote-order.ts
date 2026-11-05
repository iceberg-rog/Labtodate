import type { QuoteDetails } from './build';
import type { DocLine, DocSnapshot } from './types';

/**
 * One mapping from an offer (the frozen quote document) to an order, used by
 * "send quote" (updating an order the buyer already accepted) and by the
 * buyer's Accept (creating it), so an order's lines, shipping and VAT are
 * always exactly what the quote PDF said.
 */

export function orderItemsFrom(lines: DocLine[], productId: string | null, brand: string | null = null) {
  return lines.map((l, i) => ({
    productId: i === 0 ? productId : null,
    titleSnapshot: l.title,
    brandSnapshot: i === 0 ? brand : null,
    priceCentsSnapshot: l.unitCents,
    quantity: Math.max(1, Math.round(l.qty)),
  }));
}

export function orderMoneyFrom(snap: DocSnapshot) {
  return {
    subtotalCents: snap.subtotalCents,
    shippingCents: snap.shippingCents,
    taxCents: snap.vat.cents,
    totalCents: snap.totalCents,
    currency: snap.currency,
    // A quote issued before editable documents carries "LEGACY": the order is
    // still new, so its invoice takes a number from the invoice series.
    vatTreatment: snap.vat.treatment,
    vatRateBp: snap.vat.rateBp,
    docLanguage: snap.lang,
  };
}

/** The quote's billing block in the order's billingAddress JSON shape. */
export function billingAddressFrom(details: QuoteDetails | null, fallback: { name: string; company: string | null }) {
  if (!details) return undefined;
  const b = details.billing;
  if (!b.addressLines.length && !b.vatId && !b.company && !b.country) return undefined;
  return {
    name: b.name || fallback.name,
    company: b.company || fallback.company || null,
    vat: b.vatId || null,
    address: {
      line1: b.addressLines[0] ?? '',
      line2: b.addressLines.slice(1).join(', '),
      country: b.country ?? '',
    },
  };
}
