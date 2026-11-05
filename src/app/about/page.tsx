import { LegalShell, sitePage } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'About' };

/** Text: Admin → Site content → Page: About. */
export default async function AboutPage() {
  const p = await sitePage('page_about');
  return <LegalShell title={p.title} subtitle={p.subtitle} html={p.html} updated={p.updated} />;
}
