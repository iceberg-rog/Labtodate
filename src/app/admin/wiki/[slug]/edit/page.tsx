import { notFound } from 'next/navigation';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { ContentForm } from '@/components/editor/ContentForm';
import { updateWikiArticle } from '@/lib/content/actions';
import type { WikiInputType } from '@/lib/content/actions';

export const dynamic = 'force-dynamic';

export function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  return adminDetailTitle('content:write', 'Edit wiki article', async () => {
    const { slug } = await props.params;
    const article =
      (await prisma.wikiArticle.findUnique({ where: { slug }, select: { title: true } })) ??
      (await prisma.wikiArticle.findUnique({ where: { id: slug }, select: { title: true } }));
    return article && `Edit article: ${article.title}`;
  });
}

export default async function EditWikiPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  await requireCapability('content:write');
  // Rows whose slug came out empty (non-Latin title) are linked by id instead.
  const article =
    (await prisma.wikiArticle.findUnique({ where: { slug: params.slug } })) ??
    (await prisma.wikiArticle.findUnique({ where: { id: params.slug } }));
  if (!article) notFound();

  const slug = article.slug;
  async function handle(data: { title: string; body: string; category?: string | null; publish: boolean }) {
    'use server';
    const input: WikiInputType = {
      title: data.title,
      body: data.body,
      category: data.category ?? null,
      publish: data.publish,
    };
    return updateWikiArticle(slug, input);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Edit article</h1>
      <ContentForm
        initial={{ kind: 'wiki', status: article.status, title: article.title, body: article.body, category: article.category }}
        onSubmit={handle}
      />
    </div>
  );
}
