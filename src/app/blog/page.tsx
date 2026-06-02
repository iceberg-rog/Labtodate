import Link from 'next/link';
import { Clock, ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { prisma } from '@/lib/db';
import { ArticleCover } from '@/components/content/ArticleCover';

export const metadata = { title: 'Blog' };
export const dynamic = 'force-dynamic';

export default async function BlogIndexPage() {
  const posts = await prisma.blogPost.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: { publishedAt: 'desc' },
  });

  return (
    <div className="container-px py-14 max-w-6xl mx-auto">
      <header className="mb-12">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">Field notes</p>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight" style={{ letterSpacing: '-0.04em' }}>
          The lab2date journal.
        </h1>
        <p className="mt-4 text-muted-foreground text-lg max-w-2xl">
          Buying guides, cost analyses, and technical deep-dives from procurement teams who&apos;ve done it before.
        </p>
      </header>

      {posts.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <p className="text-lg font-semibold">No posts yet</p>
          <p className="text-sm text-muted-foreground mt-2">Check back soon.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {posts.map((p) => (
            <Link
              key={p.slug}
              href={`/blog/${p.slug}`}
              className="group rounded-2xl border border-border bg-card overflow-hidden hover:border-primary/40 hover:shadow-xl transition-all"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-muted">
                <ArticleCover
                  illustration={p.illustration}
                  coverImage={p.coverImage}
                  coverGradient={p.coverGradient}
                  eyebrow={null}
                  seed={p.slug}
                  variant="card"
                  className="h-full w-full transition-transform duration-700 group-hover:scale-105"
                />
                {p.category && (
                  <div className="absolute top-4 left-4 z-10">
                    <Badge variant="accent">{p.category}</Badge>
                  </div>
                )}
                <div className="absolute top-4 right-4 h-9 w-9 rounded-full bg-white/90 backdrop-blur flex items-center justify-center group-hover:bg-accent transition-colors z-10">
                  <ArrowUpRight className="h-4 w-4 group-hover:rotate-12 transition-transform" />
                </div>
              </div>
              <div className="p-6 space-y-3">
                {p.category && <Badge variant="secondary" className="inline-flex">{p.category}</Badge>}
                <h2 className="text-xl font-bold leading-tight group-hover:text-primary transition-colors" style={{ letterSpacing: '-0.02em' }}>
                  {p.title}
                </h2>
                {p.excerpt && <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">{p.excerpt}</p>}
                <div className="flex items-center justify-between text-xs text-muted-foreground pt-3 border-t">
                  {p.publishedAt && (
                    <time dateTime={p.publishedAt.toISOString()}>
                      {new Date(p.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </time>
                  )}
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <Clock className="h-3 w-3" /> {p.readMinutes} min read
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
