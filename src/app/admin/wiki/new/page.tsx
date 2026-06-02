import { requireCapability } from '@/lib/auth-server';
import { ContentForm } from '@/components/editor/ContentForm';
import { createWikiArticle } from '@/lib/content/actions';
import type { WikiInputType } from '@/lib/content/actions';

export const dynamic = 'force-dynamic';

export default async function NewWikiPage() {
  await requireCapability('content:write');

  async function handle(data: { title: string; body: string; category?: string | null; publish: boolean }) {
    'use server';
    const input: WikiInputType = {
      title: data.title,
      body: data.body,
      category: data.category ?? null,
      publish: data.publish,
    };
    await createWikiArticle(input);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">New wiki article</h1>
      <ContentForm initial={{ kind: 'wiki' }} onSubmit={handle} />
    </div>
  );
}
