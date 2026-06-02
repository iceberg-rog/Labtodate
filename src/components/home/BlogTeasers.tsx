import Link from 'next/link';
import { ArrowRight, Clock, ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { prisma } from '@/lib/db';
import { ArticleCover } from '@/components/content/ArticleCover';
import { Reveal } from '@/components/motion/Reveal';

export async function BlogTeasers() {
  const posts = await prisma.blogPost.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: { publishedAt: 'desc' },
    take: 3,
  });
  if (posts.length === 0) return null;

  return (
    <section className="container-px py-24">
      <Reveal>
        <div className="flex items-end justify-between mb-12 gap-6 flex-wrap">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">Field notes</p>
            <h2 className="text-3xl md:text-5xl font-bold text-foreground max-w-2xl" style={{ letterSpacing: '-0.035em' }}>
              What lab managers wish they knew before buying.
            </h2>
          </div>
          <Link href="/blog" className="inline-flex items-center gap-2 px-5 py-3 rounded-full border-2 border-foreground/10 text-sm font-semibold text-foreground hover:bg-foreground hover:text-background transition-colors group">
            All articles
            <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
      </Reveal>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {posts.map((post, i) => (
          <Reveal key={post.slug} delay={i * 90}>
            <Link
              href={`/blog/${post.slug}`}
              className="group block rounded-2xl border border-border bg-card overflow-hidden hover:border-primary/30 hover:shadow-[0_20px_50px_-20px_rgba(15,79,64,0.35)] transition-all"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-muted">
                <ArticleCover
                  illustration={post.illustration}
                  coverImage={post.coverImage}
                  coverGradient={post.coverGradient}
                  eyebrow={null}
                  seed={post.slug}
                  variant="card"
                  className="h-full w-full transition-transform duration-700 group-hover:scale-105"
                />
                {post.category && (
                  <div className="absolute top-4 left-4 z-10">
                    <Badge variant="accent">{post.category}</Badge>
                  </div>
                )}
                <div className="absolute top-4 right-4 h-9 w-9 rounded-full bg-white/90 backdrop-blur flex items-center justify-center text-foreground group-hover:bg-accent transition-colors">
                  <ArrowUpRight className="h-4 w-4 group-hover:rotate-12 transition-transform" />
                </div>
              </div>
              <div className="p-6 space-y-3">
                <h3 className="text-xl font-bold leading-tight group-hover:text-primary transition-colors" style={{ letterSpacing: '-0.02em' }}>
                  {post.title}
                </h3>
                {post.excerpt && <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">{post.excerpt}</p>}
                <div className="flex items-center justify-between text-xs text-muted-foreground pt-3 border-t">
                  {post.publishedAt && (
                    <time dateTime={post.publishedAt.toISOString()} className="font-medium">
                      {new Date(post.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </time>
                  )}
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <Clock className="h-3 w-3" /> {post.readMinutes} min read
                  </span>
                </div>
              </div>
            </Link>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
