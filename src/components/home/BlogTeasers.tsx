import Link from 'next/link';
import { ArrowRight, Clock, ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { prisma } from '@/lib/db';
import { ArticleCover } from '@/components/content/ArticleCover';
import { Reveal } from '@/components/motion/Reveal';
import { homeField } from '@/lib/home-sections';

const def = (k: string) => homeField(k)!.default;

/** Extra module “Blog teasers”: the three newest published articles; texts and button from Admin → Homepage. */
export async function BlogTeasers({
  kicker = def('HOME_BLOG_KICKER'),
  title = def('HOME_BLOG_TITLE'),
  button = ['All articles', '/blog'],
  readTime = def('HOME_BLOG_READ'),
}: { kicker?: string; title?: string; button?: [string, string]; readTime?: string } = {}) {
  const posts = await prisma.blogPost.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: { publishedAt: 'desc' },
    take: 3,
  });
  if (posts.length === 0) return null;

  return (
    <section id="blog" data-hud="NOTES" className="container-px py-24">
      <Reveal>
        <div className="flex items-end justify-between mb-12 gap-6 flex-wrap">
          <div>
            {kicker && <span className="kicker mb-4">{kicker}</span>}
            <h2 className="text-3xl md:text-5xl font-bold text-foreground max-w-2xl" style={{ letterSpacing: '-0.035em' }}>
              {title}
            </h2>
          </div>
          <Link href={button[1]} className="inline-flex items-center gap-2 px-5 py-3 rounded-full border border-[hsl(var(--teal)/0.24)] bg-[hsl(var(--teal)/0.05)] text-sm font-semibold text-foreground hover:border-primary/60 transition-colors group">
            {button[0]}
            <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
      </Reveal>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {posts.map((post, i) => (
          <Reveal key={post.slug} delay={i * 90}>
            <Link
              href={`/blog/${post.slug}`}
              className="group glass-panel block rounded-2xl overflow-hidden hover:border-primary/40 transition-all"
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
                <div className="absolute top-4 right-4 h-9 w-9 rounded-full bg-card/90 backdrop-blur flex items-center justify-center text-foreground group-hover:bg-accent transition-colors">
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
                    <Clock className="h-3 w-3" /> {readTime.replaceAll('{N}', String(post.readMinutes))}
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
