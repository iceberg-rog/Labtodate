import { requireCapability } from '@/lib/auth-server';
import { ContentForm } from '@/components/editor/ContentForm';
import { createBlogPost } from '@/lib/content/actions';
import type { BlogInputType } from '@/lib/content/actions';

export const dynamic = 'force-dynamic';

export default async function NewBlogPostPage() {
  await requireCapability('content:write');

  async function handle(data: { title: string; excerpt?: string | null; body: string; category?: string | null; illustration?: string | null; coverImage?: string | null; coverGradient?: string | null; readMinutes?: number; publish: boolean }) {
    'use server';
    const input: BlogInputType = {
      title: data.title,
      excerpt: data.excerpt ?? null,
      body: data.body,
      category: data.category ?? null,
      illustration: (data.illustration as BlogInputType['illustration']) ?? null,
      coverImage: data.coverImage ?? null,
      coverGradient: data.coverGradient ?? null,
      readMinutes: data.readMinutes ?? 5,
      publish: data.publish,
    };
    await createBlogPost(input);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">New blog post</h1>
      <ContentForm initial={{ kind: 'blog' }} onSubmit={handle} />
    </div>
  );
}
