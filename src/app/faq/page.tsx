import { LegalShell, legalContext } from '@/components/site/LegalShell';
import { getCatalogPolicy } from '@/lib/catalog/policy';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'FAQ' };

export default async function FaqPage() {
  const [c, policy] = await Promise.all([legalContext(), getCatalogPolicy()]);
  return (
    <LegalShell title="Frequently asked questions">
      <div className="faq">
        <h3>Is the equipment tested? Is there a warranty?</h3>
        <p>
          Each listing states the condition and the warranty of that unit — or that it is sold without warranty.
          A unit is described as inspected only when an inspection is recorded for it, with the report on the listing.
          If you need a test or inspection report that the listing does not show, ask us before you order.
        </p>
        <h3>How does pricing work?</h3>
        <p>Some items have a list price (buy now); others are quote-only. Request a quote and we send you an offer with the price, terms and validity. When you accept it in your dashboard, we create your order and issue a proforma invoice.</p>
        <h3>Do you ship internationally?</h3>
        {policy.shippingClaim ? (
          <p>{policy.shippingClaim}. Shipping costs and any tax are confirmed before you pay.</p>
        ) : (
          <p>
            Shipping depends on the item and the destination. Contact us before you order if you need a shipping
            quote or a specific carrier, packaging or insurance.
          </p>
        )}
        <h3>What payment methods are accepted?</h3>
        <p>Card payment via our secure payment provider at checkout. For quote-based orders, accepting our offer issues a proforma invoice (PDF) with the bank-transfer instructions.</p>
        <h3>Can I sell my equipment?</h3>
        <p>
          Yes — submit it via <a href="/sell">Sell equipment</a> for a free valuation
          {policy.sellValuationTurnaround ? `, usually within ${policy.sellValuationTurnaround}` : ''}.
        </p>
        <h3>What if an item is not as described?</h3>
        <p>Contact <a href={c.contactHref}>{c.contactLabel}</a> within {policy.returnWindowDays} days of delivery; under our <a href="/legal/terms">terms</a> we resolve it or refund you.</p>
        <h3>How do I track my order?</h3>
        <p>Sign in and open the order under <a href="/app/orders">My orders</a> — you&apos;ll see the fulfillment status and tracking number once shipped.</p>
      </div>
    </LegalShell>
  );
}
