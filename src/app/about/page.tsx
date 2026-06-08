import { LegalShell, legalContext } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'About' };

export default async function AboutPage() {
  const c = await legalContext();
  return (
    <LegalShell title={`About ${c.site}`} subtitle="The marketplace for laboratory & analytical instruments.">
      <p>
        {c.site} is a marketplace for refurbished and surplus laboratory and analytical
        equipment — chromatography, mass spectrometry, spectroscopy and the parts that keep them
        running.
      </p>
      <h2>What we do</h2>
      <ul>
        <li>List refurbished and surplus instruments from a working supply network.</li>
        <li>Ship worldwide — crated and insured.</li>
        <li>Handle quotes, proforma invoices, payment and logistics end to end.</li>
      </ul>
      <h2>Why buyers transact with us</h2>
      <p>
        You deal with {c.site} as a single accountable counterparty: one proforma, one invoice,
        one point of contact through delivery and after-sale support.
      </p>
      <h2>Contact</h2>
      <p>{c.legal}{c.address ? `, ${c.address}` : ''}{c.country ? `, ${c.country}` : ''}. Email <a href={`mailto:${c.email}`}>{c.email}</a>.</p>
    </LegalShell>
  );
}
