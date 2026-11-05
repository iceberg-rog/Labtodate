import { LegalShell, sitePage } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cookie Policy' };

/** Text: Admin → Site content → Page: Cookie Policy. */
export default async function CookiesPage() {
  const p = await sitePage('page_cookies');
  return <LegalShell title={p.title} subtitle={p.subtitle} html={p.html} updated={p.updated} />;
}
