import { notFound } from 'next/navigation';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { ContentForm } from '@/components/editor/ContentForm';
import { updateBlogPost } from '@/lib/content/actions';
import type { BlogInputType } from '@/lib/content/actions';

export const dynamic = 'force-dynamic';

export function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  return adminDetailTitle('content:write', 'Edit blog post', async () => {
    const { slug } = await props.params;
    const post =
      (await prisma.blogPost.findUnique({ where: { slug }, select: { title: true } })) ??
      (await prisma.blogPost.findUnique({ where: { id: slug }, select: { title: true } }));
    return post && `Edit post: ${post.title}`;
  });
}

export default async function EditBlogPostPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  await requireCapability('content:write');
  // Rows whose slug came out empty (non-Latin title) are linked by id instead.
  const post =
    (await prisma.blogPost.findUnique({ where: { slug: params.slug } })) ??
    (await prisma.blogPost.findUnique({ where: { id: params.slug } }));
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
    return updateBlogPost(slug, input);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Edit post</h1>
      <ContentForm
        initial={{
          kind: 'blog',
          status: post.status,
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
