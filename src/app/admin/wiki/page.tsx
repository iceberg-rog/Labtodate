import Link from 'next/link';
import { Plus, Edit2, Eye, EyeOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { setWikiArticlePublished, deleteWikiArticle } from '@/lib/content/actions';
import { ConfirmSubmitButton } from '@/components/admin/ConfirmSubmitButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Wiki' };

export default async function AdminWikiPage() {
  await requireCapability('content:write');
  const articles = await prisma.wikiArticle.findMany({ orderBy: { updatedAt: 'desc' } });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Wiki</h1>
          <p className="text-muted-foreground mt-1">{articles.length} articles</p>
        </div>
        <Button asChild className="rounded-full font-semibold">
          <Link href="/admin/wiki/new"><Plus className="h-4 w-4" /> New article</Link>
        </Button>
      </div>
      <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
        {articles.map((a) => (
          <li key={a.id} className="p-4 flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              {a.slug ? (
                <Link href={`/wiki/${a.slug}`} className="font-semibold truncate hover:text-primary block">{a.title}</Link>
              ) : (
                <span className="font-semibold truncate block">{a.title}</span>
              )}
              <p className="text-xs text-muted-foreground mt-1">{a.category ?? '—'}</p>
            </div>
            <Badge variant={a.status === 'PUBLISHED' ? 'success' : 'secondary'}>{a.status.toLowerCase()}</Badge>
            <Button asChild variant="outline" size="sm" className="rounded-full font-medium">
              <Link href={`/admin/wiki/${a.slug || a.id}/edit`}><Edit2 className="h-3.5 w-3.5" /> Edit</Link>
            </Button>
            <form action={setWikiArticlePublished.bind(null, a.id, a.status !== 'PUBLISHED')}>
              <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium">
                {a.status === 'PUBLISHED' ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {a.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
              </Button>
            </form>
            <form action={deleteWikiArticle.bind(null, a.id)}>
              <ConfirmSubmitButton
                message={`Delete the wiki article "${a.title}"? This cannot be undone.`}
                variant="outline"
                size="sm"
                className="rounded-full font-medium text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </ConfirmSubmitButton>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
