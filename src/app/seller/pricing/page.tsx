import { LegalShell, legalContext } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Pricing & fees' };

export default async function SellerPricingPage() {
  const c = await legalContext();
  const commission = (process.env.SELLER_COMMISSION_PCT || '8').trim();
  const listingFee = (process.env.SELLER_LISTING_FEE || 'Free').trim();
  const payout = (process.env.SELLER_PAYOUT_DAYS || '3 business days after delivery').trim();

  return (
    <LegalShell title="Pricing & fees" subtitle="Simple, transparent — you only pay when you sell.">
      <h2>What it costs to sell on {c.site}</h2>
      <table>
        <tbody>
          <tr><td><strong>Listing fee</strong></td><td>{listingFee}</td></tr>
          <tr><td><strong>Commission</strong></td><td>{commission}% of the final sale price</td></tr>
          <tr><td><strong>Payout</strong></td><td>{payout}</td></tr>
          <tr><td><strong>Logistics</strong></td><td>Crating, freight &amp; insurance coordinated by {c.site}</td></tr>
        </tbody>
      </table>

      <h2>How it works</h2>
      <ol>
        <li>List your equipment (or submit it via <a href="/sell">Sell equipment</a> for a managed listing).</li>
        <li>We publish it to the marketplace — no listing fee.</li>
        <li>When it sells, {c.site} handles payment, logistics and buyer protection.</li>
        <li>You receive your payout ({payout}), minus the {commission}% commission.</li>
      </ol>

      <h2>No hidden costs</h2>
      <p>
        No subscription, no per-listing charge, no payment surcharge. The commission is the only
        fee and applies solely to completed sales.
      </p>

      <h2>Questions?</h2>
      <p>
        Email <a href={`mailto:${c.email}`}>{c.email}</a> or read the{' '}
        <a href="/wiki/seller-guide">seller guide</a>.
      </p>
    </LegalShell>
  );
}
