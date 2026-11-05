import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { prisma } from '@/lib/db';
import { InstrumentIllustration, type IllustrationName } from '@/components/illustrations/instruments';

export const metadata = { title: 'Case studies' };
export const dynamic = 'force-dynamic';

export default async function CaseStudiesPage() {
  const cases = await prisma.caseStudy.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: { publishedAt: 'desc' },
    take: 60,
  });

  return (
    <div className="container-px py-14 max-w-6xl mx-auto">
      <header className="mb-12">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">Case studies</p>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight" style={{ letterSpacing: '-0.04em' }}>
          Real labs. Real numbers.
        </h1>
        <p className="mt-4 text-muted-foreground text-lg max-w-2xl">
          How research teams cut procurement cost and time using Labtodate.
        </p>
      </header>

      {cases.length === 0 && (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <p className="text-lg font-semibold">No case studies published yet</p>
          <p className="text-sm text-muted-foreground mt-2">
            Check back soon, or <Link href="/contact" className="font-semibold text-primary hover:underline">ask us</Link> for references in your field.
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {cases.map((c) => (
          <Link key={c.slug} href={`/case-studies/${c.slug}`} className="group rounded-2xl border border-border bg-card overflow-hidden hover:border-primary/40 hover:shadow-xl transition-all">
            <div className="aspect-[16/9] bg-gradient-to-br from-primary via-[hsl(168_55%_30%)] to-[hsl(82_55%_50%)] p-12 relative">
              {c.illustration && (
                <div className="absolute inset-0 p-16 mix-blend-overlay opacity-90 transition-transform duration-500 group-hover:scale-105">
                  <InstrumentIllustration name={c.illustration as IllustrationName} />
                </div>
              )}
              <div className="absolute top-4 right-4 h-9 w-9 rounded-full bg-card/90 backdrop-blur flex items-center justify-center text-foreground group-hover:bg-accent transition-colors">
                <ArrowUpRight className="h-4 w-4 group-hover:rotate-12 transition-transform" />
              </div>
              <div className="absolute bottom-4 left-6 right-6">
                <p className="text-3xl font-bold text-white" style={{ letterSpacing: '-0.03em' }}>
                  {c.outcomeMetric}
                </p>
                <p className="text-sm text-white/80 mt-1">{c.customer}</p>
              </div>
            </div>
            <div className="p-6 space-y-3">
              <h2 className="text-xl font-bold leading-tight group-hover:text-primary transition-colors" style={{ letterSpacing: '-0.02em' }}>
                {c.title}
              </h2>
              <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">{c.excerpt}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
