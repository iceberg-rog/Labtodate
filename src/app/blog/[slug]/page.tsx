import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Clock, ChevronLeft, Calendar, Eye, MessageSquare } from 'lucide-react';
import { prisma } from '@/lib/db';
import { ArticleCover } from '@/components/content/ArticleCover';
import { BlogCommentForm } from '@/components/content/BlogCommentForm';
import { trackBlogView } from '@/lib/blog/actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const post = await prisma.blogPost.findUnique({ where: { slug: params.slug } });
  if (!post) return { title: 'Not found' };
  return { title: post.title, description: post.excerpt ?? undefined };
}

export default async function BlogPostPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const post = await prisma.blogPost.findUnique({
    where: { slug: params.slug },
    include: {
      author: { select: { name: true } },
      comments: {
        where: { approved: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, authorName: true, body: true, createdAt: true },
      },
    },
  });
  if (!post || post.status !== 'PUBLISHED') notFound();

  // Fire-and-forget — don't block the render on the view bump.
  trackBlogView(post.slug).catch(() => {});

  return (
    <article className="container-px py-12 max-w-3xl mx-auto">
      <Link href="/blog" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6">
        <ChevronLeft className="h-4 w-4" /> Back to blog
      </Link>

      <div className="mt-2 relative min-h-[420px] md:min-h-[480px] rounded-2xl overflow-hidden bg-muted">
        <ArticleCover
          illustration={post.illustration}
          coverImage={post.coverImage}
          coverGradient={post.coverGradient}
          eyebrow={post.category}
          seed={post.slug}
          variant="hero"
          title={post.title}
          className="absolute inset-0"
        >
          <span>By <strong className="text-white">{post.author.name}</strong></span>
          {post.publishedAt && (
            <>
              <span className="text-white/35">·</span>
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                {new Date(post.publishedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
            </>
          )}
          <span className="text-white/35">·</span>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" /> {post.readMinutes} min read
          </span>
        </ArticleCover>
      </div>

      <div className="mt-6 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5" /> <strong className="text-foreground tabular-nums">{post.viewCount.toLocaleString()}</strong> views
        </span>
        <span className="inline-flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />{' '}
          <strong className="text-foreground tabular-nums">{post.comments.length}</strong> comment{post.comments.length === 1 ? '' : 's'}
        </span>
      </div>

      {post.excerpt && (
        <p className="mt-10 text-xl text-muted-foreground leading-relaxed font-medium" style={{ letterSpacing: '-0.01em' }}>
          {post.excerpt}
        </p>
      )}

      <div
        className="prose-article mt-10 text-foreground"
        dangerouslySetInnerHTML={{ __html: post.body }}
      />

      <section className="mt-16 border-t border-border pt-10">
        <h2 className="text-xl font-bold tracking-tight mb-4 flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          Comments {post.comments.length > 0 && <span className="text-muted-foreground font-normal text-base">({post.comments.length})</span>}
        </h2>

        {post.comments.length === 0 ? (
          <p className="text-sm text-muted-foreground mb-6">Be the first to comment.</p>
        ) : (
          <ul className="space-y-4 mb-8">
            {post.comments.map((c) => (
              <li key={c.id} className="rounded-2xl border border-border bg-card p-4">
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                  {c.authorName} ·{' '}
                  {new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
                <p className="text-sm leading-relaxed mt-1.5 whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ul>
        )}

        <BlogCommentForm postId={post.id} />
      </section>
    </article>
  );
}
