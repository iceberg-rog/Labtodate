/**
 * Default buyer-facing texts of the catalog area — the registry defaults of
 * the settings in settings-defs.ts (every one is editable in Admin → Settings)
 * and the Terms of Service template with its placeholders. Pure.
 */

export const CATALOG_TEXT_DEFAULTS = {
  inspectionNone: 'No inspection report is recorded for this unit. Ask us before ordering if you need one.',
  noPhotoLabel: 'Photo on request',
  illustrationLabel: 'Illustration – not the actual item',
  soldTitle: 'Sold',
  soldText: 'This unit is no longer available. We can source a similar one.',
  unavailableTitle: 'Not available',
  unavailableText: 'This unit is currently not available from our supply network. We can source a similar one.',
  backorderTitle: 'On backorder',
  backorderText: 'Our supplier has this item on backorder, so it cannot be ordered right now. Ask us when it is expected, or let us source a similar one.',
  backorderLeadTime: 'On backorder at our supplier — the delivery time is confirmed with your order.',
  reservedText: 'This unit is reserved for another buyer’s order. If that order is not completed, it becomes available again. We can also source a similar one.',
  priceReview: 'The price of this unit is being confirmed. Request a quote and we reply with the current price.',
  noDescription: 'Ask us for the full specifications of this unit.',
  askPhotosLabel: 'Request photos of this unit',
  askPhotosMessage: 'Hello, could you send me photos of this unit ({TITLE})?',
  reviewsEmpty: 'No reviews yet.',
  siteTitleSuffix: 'Used laboratory equipment',
  siteMetaDescription: 'Used laboratory and analytical equipment — buy online or request a written quote.',
  footerTagline: 'B2B marketplace for laboratory and analytical equipment.',
  sourcingNoObligation: 'No obligation: you decide after you have seen our written offer.',
  caseStudiesIntro: 'How customers use equipment they bought through us. Published only with their permission.',
  labRentalIntro: 'Instruments a facility offers to book by the hour or day. A facility is listed only after it has confirmed its offer.',
  blogIntro: 'Articles about buying, installing and running laboratory equipment.',
  wikiIntro: 'Glossary, comparison guides and how-to articles about laboratory equipment.',
} as const;

/** Placeholders the Terms of Service text may use (all filled from settings). */
export const TERMS_TOKENS = [
  '{SITE}',
  '{LEGAL_NAME}',
  '{COUNTRY}',
  '{CONTACT}',
  '{RETURN_DAYS}',
  '{OFFER_VALID_DAYS}',
  '{PAYMENT_TERM_DAYS}',
  '{PRICE_BASIS}',
  '{WARRANTY_FALLBACK}',
  '{INSPECTION_REPORT_CLAUSE}',
  '{SHIPPING_SENTENCE}',
] as const;

export const DEFAULT_TERMS_TEXT = `These terms govern use of {SITE}, operated by {LEGAL_NAME}{COUNTRY}. By using the site or placing an order you accept them.

## 1. The marketplace
{SITE} sells used and refurbished laboratory equipment sourced through its supply network. {LEGAL_NAME} is the seller of every item. Listings, specifications and availability may change without notice.

## 2. Quotes, offers & proforma invoices
A written offer is valid for {OFFER_VALID_DAYS} days unless the offer states otherwise. When you accept an offer or place an order, you receive a proforma invoice: it states the amount to pay and its due date ({PAYMENT_TERM_DAYS} days unless stated otherwise). A proforma invoice is a payment request, not a tax invoice; the VAT invoice follows when your payment is received.

## 3. Pricing, taxes & payment
Prices are shown {PRICE_BASIS}. VAT and shipping are determined for your delivery country and shown before you order. Card payments are processed by our payment provider; we do not store card details.

## 4. Inspection & warranty
Each listing states the warranty for that unit — its length and scope — or that the unit is sold without warranty (“{WARRANTY_FALLBACK}”). That statement is repeated on your order and invoice and is the warranty that applies, unless we agreed otherwise in writing.

A unit is described as inspected only when an inspection is recorded for it{INSPECTION_REPORT_CLAUSE}. No other statement on the site implies that a unit was inspected or tested.

## 5. Shipping & risk
{SHIPPING_SENTENCE} Title and risk pass on delivery to the address you provide. Inspect the goods on receipt and report any discrepancy within {RETURN_DAYS} days of delivery.

## 6. Items that differ from their description
If an item materially differs from its description, contact {CONTACT} within {RETURN_DAYS} days of delivery for a resolution or a refund.

## 7. Liability
To the extent permitted by law, liability is limited to the amount paid for the item. Equipment is sold for professional use; the buyer is responsible for safe installation, qualification and compliance.

## 8. Contact
{LEGAL_NAME} · {CONTACT}`;

export type TermsBlock = { kind: 'h2' | 'p'; parts: Array<{ text: string } | { contact: true }> };

/**
 * Parse the terms text into headings and paragraphs, with every placeholder
 * filled in. {CONTACT} stays a marker so the page can render it as a link.
 * Unknown placeholders are left as written (visible to the owner, not hidden).
 */
export function renderTermsBlocks(text: string, values: Record<string, string>): TermsBlock[] {
  const fill = (s: string) => s.replace(/\{[A-Z_]+\}/g, (t) => (t === '{CONTACT}' ? t : values[t] ?? t));
  const blocks: TermsBlock[] = [];
  for (const chunk of text.replace(/\r\n/g, '\n').split(/\n\s*\n|\n(?=##\s)/)) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    let para: string[] = [];
    const flush = () => {
      if (!para.length) return;
      const s = fill(para.join(' '));
      const parts = s.split('{CONTACT}').flatMap((t, i) => (i === 0 ? [{ text: t }] : [{ contact: true as const }, { text: t }])).filter((p) => !('text' in p) || p.text);
      blocks.push({ kind: 'p', parts });
      para = [];
    };
    for (const line of lines) {
      if (line.startsWith('## ')) {
        flush();
        blocks.push({ kind: 'h2', parts: [{ text: fill(line.slice(3).trim()) }] });
      } else para.push(line);
    }
    flush();
  }
  return blocks;
}
