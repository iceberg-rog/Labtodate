import { LegalShell, legalContext } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'FAQ' };

export default async function FaqPage() {
  const c = await legalContext();
  return (
    <LegalShell title="Frequently asked questions">
      <div className="faq">
        <h3>Is the equipment tested?</h3>
        <p>Yes. Each unit is checked before shipping; specific warranty terms are stated on the listing.</p>
        <h3>How does pricing work?</h3>
        <p>Some items have a list price (buy now); others are quote-only. Request a quote and we send a proforma invoice with the price and terms.</p>
        <h3>Do you ship internationally?</h3>
        <p>Yes — crated and insured, worldwide. Shipping and any tax are shown at checkout.</p>
        <h3>What payment methods are accepted?</h3>
        <p>Card payment via our secure payment provider at checkout. For quote-based orders we issue a proforma and payment instructions.</p>
        <h3>Can I sell my equipment?</h3>
        <p>Yes — submit it via <a href="/sell">Sell equipment</a> for a free valuation within 2 business days.</p>
        <h3>What if an item is not as described?</h3>
        <p>Contact <a href={`mailto:${c.email}`}>{c.email}</a> within 7 days of delivery; buyer protection covers a resolution or refund.</p>
        <h3>How do I track my order?</h3>
        <p>Sign in and open the order under <a href="/app/orders">My orders</a> — you&apos;ll see the fulfillment status and tracking number once shipped.</p>
      </div>
    </LegalShell>
  );
}
