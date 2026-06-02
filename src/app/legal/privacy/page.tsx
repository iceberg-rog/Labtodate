import { LegalShell, legalContext } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Privacy Policy' };

export default async function PrivacyPage() {
  const c = await legalContext();
  return (
    <LegalShell title="Privacy Policy">
      <p>
        {c.legal} (&ldquo;{c.site}&rdquo;) is the data controller for personal data processed
        through this site. This policy explains what we collect and why.
      </p>
      <h2>Data we collect</h2>
      <ul>
        <li>Account data: name, email, password hash, role.</li>
        <li>Transaction data: quotes, orders, invoices, shipping address, messages.</li>
        <li>Technical data: minimal logs needed to operate and secure the service.</li>
      </ul>
      <h2>How we use it</h2>
      <p>
        To provide the marketplace, process quotes and orders, send transactional emails and,
        where you have an account, service notifications and offers. We do not sell personal data.
      </p>
      <h2>Processors</h2>
      <p>
        We use a payment provider (for checkout) and an email provider (for transactional and
        account email). They process data only to deliver these functions.
      </p>
      <h2>Retention</h2>
      <p>
        Transaction and invoice records are kept as required by tax and accounting law; account
        data until you ask us to delete it.
      </p>
      <h2>Your rights</h2>
      <p>
        You may request access, correction or deletion of your data, or object to processing, by
        emailing <a href={`mailto:${c.email}`}>{c.email}</a>.
      </p>
      <h2>Contact</h2>
      <p>{c.legal}{c.address ? `, ${c.address}` : ''}{c.country ? `, ${c.country}` : ''} · <a href={`mailto:${c.email}`}>{c.email}</a></p>
    </LegalShell>
  );
}
