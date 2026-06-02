import { notFound } from 'next/navigation';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ContentForm } from '@/components/editor/ContentForm';
import { updateWikiArticle } from '@/lib/content/actions';
import type { WikiInputType } from '@/lib/content/actions';

export const dynamic = 'force-dynamic';

export default async function EditWikiPage({ params }: { params: { slug: string } }) {
  await requireCapability('content:write');
  const article = await prisma.wikiArticle.findUnique({ where: { slug: params.slug } });
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
    await updateWikiArticle(slug, input);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Edit article</h1>
      <ContentForm
        initial={{ kind: 'wiki', title: article.title, body: article.body, category: article.category }}
        onSubmit={handle}
      />
    </div>
  );
}
