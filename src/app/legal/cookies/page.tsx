import { LegalShell, legalContext } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cookie Policy' };

export default async function CookiesPage() {
  const c = await legalContext();
  return (
    <LegalShell title="Cookie Policy">
      <p>
        {c.site} uses only the cookies needed to make the site work — there is no third-party
        advertising or cross-site tracking.
      </p>
      <h2>Essential cookies</h2>
      <ul>
        <li><strong>Session / authentication</strong> — keeps you signed in to your account.</li>
        <li><strong>Security</strong> — protects forms and sign-in against abuse.</li>
      </ul>
      <p>
        These are strictly necessary and cannot be disabled without breaking core functionality.
        We do not set analytics or marketing cookies by default.
      </p>
      <h2>Managing cookies</h2>
      <p>
        You can clear or block cookies in your browser settings; note that sign-in will not work
        without the session cookie.
      </p>
      <h2>Contact</h2>
      <p><a href={`mailto:${c.email}`}>{c.email}</a></p>
    </LegalShell>
  );
}
