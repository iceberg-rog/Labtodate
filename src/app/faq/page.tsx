import { LegalShell, sitePage } from '@/components/site/LegalShell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'FAQ' };

/** Text: Admin → Site content → Page: FAQ ("## Question" + answer paragraphs). */
export default async function FaqPage() {
  const p = await sitePage('page_faq', { faq: true });
  return <LegalShell title={p.title} subtitle={p.subtitle} html={p.html} updated={p.updated} />;
}
