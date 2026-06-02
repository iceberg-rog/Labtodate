import Link from 'next/link';
import { ChevronLeft, CheckCircle2, EyeOff, Trash2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { setBlogCommentApproved, deleteBlogComment } from '@/lib/blog/actions';

export const dynamic = 'force-dynamic';

export default async function AdminBlogCommentsPage({
  searchParams,
}: {
  searchParams?: { filter?: string };
}) {
  await requireCapability('content:write');
  const filter = (searchParams?.filter ?? 'pending').toLowerCase();

  const where =
    filter === 'all'
      ? {}
      : filter === 'approved'
        ? { approved: true }
        : { approved: false };

  const [comments, counts] = await Promise.all([
    prisma.blogComment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { post: { select: { slug: true, title: true } } },
    }),
    prisma.blogComment.groupBy({ by: ['approved'], _count: { _all: true } }),
  ]);

  const pending = counts.find((c) => c.approved === false)?._count._all ?? 0;
  const approved = counts.find((c) => c.approved === true)?._count._all ?? 0;

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/admin/blog" className="hover:text-foreground inline-flex items-center gap-1">
          <ChevronLeft className="h-3 w-3" /> Blog
        </Link>
      </nav>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">Blog comments</h1>
        <p className="text-muted-foreground mt-1">
          {pending} pending · {approved} approved
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <FilterPill href="/admin/blog/comments?filter=pending" label="Pending" count={pending} active={filter === 'pending'} accent="amber" />
        <FilterPill href="/admin/blog/comments?filter=approved" label="Approved" count={approved} active={filter === 'approved'} accent="emerald" />
        <FilterPill href="/admin/blog/comments?filter=all" label="All" count={pending + approved} active={filter === 'all'} />
      </div>

      {comments.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <MessageSquare className="h-7 w-7 mx-auto text-muted-foreground mb-2" />
          <p className="text-lg font-semibold">No comments in this view</p>
          <p className="text-sm text-muted-foreground mt-1">
            New submissions on the public blog land here first for moderation.
          </p>
        </div>
      ) : (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
          {comments.map((c) => (
            <li key={c.id} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                    {c.authorName} ({c.authorEmail}) ·{' '}
                    {new Date(c.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                  </p>
                  <p className="text-xs mt-0.5">
                    on{' '}
                    <Link href={`/blog/${c.post.slug}`} className="font-semibold hover:text-primary">
                      {c.post.title}
                    </Link>
                  </p>
                </div>
                <Badge variant={c.approved ? 'success' : 'warning'}>
                  {c.approved ? 'approved' : 'pending'}
                </Badge>
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{c.body}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <form action={setBlogCommentApproved.bind(null, c.id, !c.approved)}>
                  <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium">
                    {c.approved ? (
                      <>
                        <EyeOff className="h-3.5 w-3.5" /> Unapprove
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                      </>
                    )}
                  </Button>
                </form>
                <form action={deleteBlogComment.bind(null, c.id)}>
                  <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium text-destructive">
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterPill({
  href,
  label,
  count,
  active,
  accent,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
  accent?: 'amber' | 'emerald';
}) {
  const tint = accent === 'amber' ? 'text-amber-700' : accent === 'emerald' ? 'text-emerald-700' : 'text-foreground';
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-full text-xs font-semibold inline-flex items-center gap-1.5 border ${
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-card border-border hover:bg-foreground/5'
      }`}
    >
      {label}
      <span className={`tabular-nums ${active ? '' : tint}`}>{count}</span>
    </Link>
  );
}
