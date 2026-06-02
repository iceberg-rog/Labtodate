import { notFound } from 'next/navigation';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ContentForm } from '@/components/editor/ContentForm';
import { updateBlogPost } from '@/lib/content/actions';
import type { BlogInputType } from '@/lib/content/actions';

export const dynamic = 'force-dynamic';

export default async function EditBlogPostPage({ params }: { params: { slug: string } }) {
  await requireCapability('content:write');
  const post = await prisma.blogPost.findUnique({ where: { slug: params.slug } });
  if (!post) notFound();

  const slug = post.slug;
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
    await updateBlogPost(slug, input);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Edit post</h1>
      <ContentForm
        initial={{
          kind: 'blog',
          title: post.title,
          excerpt: post.excerpt,
          body: post.body,
          category: post.category,
          illustration: post.illustration,
          coverImage: post.coverImage,
          coverGradient: post.coverGradient,
          readMinutes: post.readMinutes,
        }}
        onSubmit={handle}
      />
    </div>
  );
}
