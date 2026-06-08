import { LegalShell, legalContext } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Terms of Service' };

export default async function TermsPage() {
  const c = await legalContext();
  return (
    <LegalShell title="Terms of Service">
      <p>
        These terms govern use of {c.site}, operated by {c.legal}
        {c.country ? ` (${c.country})` : ''}. By using the site or placing an order you accept them.
      </p>
      <h2>1. The marketplace</h2>
      <p>
        {c.site} sells refurbished and surplus laboratory equipment sourced through its
        supply network. Listings, specifications and availability may change without notice.
      </p>
      <h2>2. Quotes &amp; proforma invoices</h2>
      <p>
        A proforma invoice confirms a quoted price and is valid for 14 days unless stated
        otherwise. It is not a tax invoice and not a demand for payment. An order is formed only
        when payment is completed or written acceptance is received.
      </p>
      <h2>3. Pricing, taxes &amp; payment</h2>
      <p>
        Prices are shown excluding VAT unless stated. Applicable tax and shipping are added at
        checkout. Payment is processed by our payment provider; we do not store card details.
      </p>
      <h2>4. Inspection &amp; warranty</h2>
      <p>
        Refurbished units are checked before shipping; warranty terms, if any,
        covering functional defects, unless a different term is stated on the listing.
      </p>
      <h2>5. Shipping &amp; risk</h2>
      <p>
        Items are crated and insured. Title and risk pass on delivery to the address you provide.
        Inspect on receipt and report discrepancies within 7 days.
      </p>
      <h2>6. Returns</h2>
      <p>
        If an item materially differs from its description, contact <a href={`mailto:${c.email}`}>{c.email}</a> within
        7 days of delivery for a resolution or refund under buyer protection.
      </p>
      <h2>7. Liability</h2>
      <p>
        To the extent permitted by law, liability is limited to the amount paid for the item.
        Equipment is sold for professional use; the buyer is responsible for safe installation,
        qualification and compliance.
      </p>
      <h2>8. Contact</h2>
      <p>{c.legal} · <a href={`mailto:${c.email}`}>{c.email}</a></p>
    </LegalShell>
  );
}
