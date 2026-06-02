import { LegalShell, legalContext } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'About' };

export default async function AboutPage() {
  const c = await legalContext();
  return (
    <LegalShell title={`About ${c.site}`} subtitle="The marketplace for laboratory & analytical instruments.">
      <p>
        {c.site} is a curated marketplace for refurbished and surplus laboratory and analytical
        equipment — chromatography, mass spectrometry, spectroscopy and the parts that keep them
        running. Every listing is sourced through our verified supply network and passes a
        14-point inspection before it ships.
      </p>
      <h2>What we do</h2>
      <ul>
        <li>Source and vet refurbished instruments from a trusted supply network.</li>
        <li>Inspect, warranty and ship worldwide — crated and insured.</li>
        <li>Handle quotes, proforma invoices, payment and logistics end to end.</li>
      </ul>
      <h2>Why buyers trust us</h2>
      <p>
        You transact with {c.site} as a single accountable counterparty — with buyer protection,
        a 90-day warranty on refurbished units, and support throughout.
      </p>
      <h2>Contact</h2>
      <p>{c.legal}{c.address ? `, ${c.address}` : ''}{c.country ? `, ${c.country}` : ''}. Email <a href={`mailto:${c.email}`}>{c.email}</a>.</p>
    </LegalShell>
  );
}
