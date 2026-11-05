import { LegalShell, sitePage } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Terms of Service' };

/** Text: Admin → Site content → Page: Terms of Service (validity and report window come from the rules). */
export default async function TermsPage() {
  const p = await sitePage('page_terms');
  return <LegalShell title={p.title} subtitle={p.subtitle} html={p.html} updated={p.updated} />;
}
