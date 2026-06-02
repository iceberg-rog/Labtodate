import Link from 'next/link';
import { Plus, Edit2, Eye, MessageSquare, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function AdminBlogPage() {
  await requireCapability('content:write');
  const [posts, pendingComments] = await Promise.all([
    prisma.blogPost.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { comments: true } },
      },
    }),
    prisma.blogComment.count({ where: { approved: false } }),
  ]);

  const totalViews = posts.reduce((s, p) => s + p.viewCount, 0);
  const totalComments = posts.reduce((s, p) => s + p._count.comments, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Blog</h1>
          <p className="text-muted-foreground mt-1">
            {posts.length} post{posts.length === 1 ? '' : 's'} · {totalViews.toLocaleString()} total views · {totalComments} comments
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" className="rounded-full font-semibold">
            <Link href="/admin/blog/comments">
              <ShieldCheck className="h-4 w-4" />
              Moderate comments
              {pendingComments > 0 && (
                <span className="ml-1.5 bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full tabular-nums">
                  {pendingComments}
                </span>
              )}
            </Link>
          </Button>
          <Button asChild className="rounded-full font-semibold">
            <Link href="/admin/blog/new">
              <Plus className="h-4 w-4" /> New post
            </Link>
          </Button>
        </div>
      </div>

      <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
        {posts.length === 0 && (
          <li className="p-6 text-sm text-muted-foreground">No posts yet — write your first one.</li>
        )}
        {posts.map((p) => (
          <li key={p.id} className="p-4 flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <Link href={`/blog/${p.slug}`} className="font-semibold truncate hover:text-primary block">
                {p.title}
              </Link>
              <p className="text-xs text-muted-foreground mt-1">
                {p.category ?? '—'} · {p.readMinutes} min
              </p>
            </div>
            <span className="inline-flex items-center gap-1 text-xs font-bold tabular-nums text-muted-foreground">
              <Eye className="h-3.5 w-3.5" /> {p.viewCount.toLocaleString()}
            </span>
            <span className="inline-flex items-center gap-1 text-xs font-bold tabular-nums text-muted-foreground">
              <MessageSquare className="h-3.5 w-3.5" /> {p._count.comments}
            </span>
            <Badge variant={p.status === 'PUBLISHED' ? 'success' : 'secondary'}>{p.status.toLowerCase()}</Badge>
            <Button asChild variant="outline" size="sm" className="rounded-full font-medium">
              <Link href={`/admin/blog/${p.slug}/edit`}>
                <Edit2 className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
