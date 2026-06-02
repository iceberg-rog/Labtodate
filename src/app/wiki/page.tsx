import Link from 'next/link';
import { BookOpen, ArrowRight } from 'lucide-react';
import { prisma } from '@/lib/db';

export const metadata = { title: 'Equipment Wiki' };
export const dynamic = 'force-dynamic';

export default async function WikiIndexPage() {
  const articles = await prisma.wikiArticle.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: [{ category: 'asc' }, { title: 'asc' }],
  });

  // Group by category
  const groups = articles.reduce((acc, a) => {
    const key = a.category ?? 'General';
    if (!acc[key]) acc[key] = [];
    acc[key].push(a);
    return acc;
  }, {} as Record<string, typeof articles>);

  return (
    <div className="container-px py-14 max-w-5xl mx-auto">
      <header className="mb-12">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">Equipment wiki</p>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight" style={{ letterSpacing: '-0.04em' }}>
          The handbook for lab equipment.
        </h1>
        <p className="mt-4 text-muted-foreground text-lg max-w-2xl">
          Glossary, comparison guides, and how-tos curated by lab2date&apos;s sourcing team.
        </p>
      </header>

      {articles.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <BookOpen className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">Wiki is empty</p>
          <p className="text-sm text-muted-foreground mt-2">Articles will appear here once published.</p>
        </div>
      ) : (
        <div className="space-y-10">
          {Object.entries(groups).map(([category, items]) => (
            <section key={category}>
              <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-muted-foreground mb-4">{category}</h2>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {items.map((a) => (
                  <li key={a.slug}>
                    <Link href={`/wiki/${a.slug}`} className="block rounded-xl border border-border bg-card p-5 hover:border-primary/40 hover:shadow-md transition-all group">
                      <h3 className="font-semibold group-hover:text-primary">{a.title}</h3>
                      <ArrowRight className="h-4 w-4 text-muted-foreground mt-2 group-hover:translate-x-0.5 transition-transform" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
