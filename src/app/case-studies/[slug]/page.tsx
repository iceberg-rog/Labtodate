import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { prisma } from '@/lib/db';
import { InstrumentIllustration, type IllustrationName } from '@/components/illustrations/instruments';
import { sanitizeRichHtml } from '@/lib/sanitize';

export const dynamic = 'force-dynamic';

export async function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const c = await prisma.caseStudy.findUnique({ where: { slug: params.slug } });
  return { title: c?.title ?? 'Not found' };
}

export default async function CaseStudyPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const c = await prisma.caseStudy.findUnique({ where: { slug: params.slug } });
  if (!c || c.status !== 'PUBLISHED') notFound();

  return (
    <article className="container-px py-12 max-w-3xl mx-auto">
      <Link href="/case-studies" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6">
        <ChevronLeft className="h-4 w-4" /> All case studies
      </Link>

      <Badge variant="accent">{c.customer}</Badge>
      <h1 className="text-4xl md:text-5xl font-bold tracking-tight mt-4" style={{ letterSpacing: '-0.035em' }}>
        {c.title}
      </h1>

      <div className="mt-10 rounded-2xl bg-gradient-to-br from-primary via-[hsl(168_55%_30%)] to-[hsl(82_55%_50%)] p-12 text-center relative overflow-hidden">
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'radial-gradient(circle, white 1.5px, transparent 1.5px)', backgroundSize: '24px 24px' }} />
        {c.illustration && (
          <div className="absolute inset-0 p-16 mix-blend-overlay opacity-60">
            <InstrumentIllustration name={c.illustration as IllustrationName} />
          </div>
        )}
        <div className="relative">
          <p className="text-5xl md:text-6xl font-bold text-white" style={{ letterSpacing: '-0.04em' }}>
            {c.outcomeMetric}
          </p>
          <p className="text-white/80 mt-2">{c.customer}</p>
        </div>
      </div>

      <p className="mt-10 text-xl text-muted-foreground leading-relaxed font-medium" style={{ letterSpacing: '-0.01em' }}>
        {c.excerpt}
      </p>

      <div className="prose-article mt-10 text-foreground" dangerouslySetInnerHTML={{ __html: caseStudyBodyHtml(c.body) }} />
    </article>
  );
}

/** Bodies written in the admin's plain textarea have no markup, so rendering
 *  them as HTML collapsed every line break into one run-on line. Plain text is
 *  escaped and split into paragraphs on blank lines (single newline → <br>);
 *  bodies that already contain HTML (seeded content) are sanitized as before. */
function caseStudyBodyHtml(body: string | null | undefined): string {
  if (!body) return '';
  if (/<[a-z][^>]*>/i.test(body)) return sanitizeRichHtml(body);
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
