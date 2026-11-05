import { LegalShell, sitePage } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Privacy Policy' };

/** Text: Admin → Site content → Page: Privacy Policy. */
export default async function PrivacyPage() {
  const p = await sitePage('page_privacy');
  return <LegalShell title={p.title} subtitle={p.subtitle} html={p.html} updated={p.updated} />;
}
