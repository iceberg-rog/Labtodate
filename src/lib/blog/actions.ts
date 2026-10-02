'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapability } from '@/lib/auth-server';
import { rateLimit } from '@/lib/ratelimit';
import { audit } from '@/lib/observability';

/** Bump a post's viewCount; fire-and-forget from the public post page.
 *  Cheap: single UPDATE … +1 statement. */
export async function trackBlogView(slug: string): Promise<void> {
  if (!slug) return;
  try {
    await prisma.blogPost.update({
      where: { slug },
      data: { viewCount: { increment: 1 } },
    });
  } catch {
    /* post may have been deleted between render and tick — ignore */
  }
}

const CommentInput = z.object({
  postId: z.string().min(1),
  authorName: z.string().trim().min(2).max(80),
  authorEmail: z.string().trim().email().max(180),
  body: z.string().trim().min(3).max(2000),
});

// Field-level messages people can act on (zod's defaults read like
// "String must contain at least 3 character(s)").
const COMMENT_FIELD_ERRORS: Record<string, string> = {
  authorName: 'Please enter your name (2–80 characters).',
  authorEmail: 'Please enter a valid email address, like name@example.com.',
  body: 'Please write a comment of 3–2,000 characters.',
};

/** Public comment submission — auto-held for moderation. */
export async function submitBlogComment(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const parsed = CommentInput.safeParse({
    postId: formData.get('postId'),
    authorName: formData.get('authorName'),
    authorEmail: formData.get('authorEmail'),
    body: formData.get('body'),
  });
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? '');
    return { ok: false, message: COMMENT_FIELD_ERRORS[field] ?? 'This comment could not be posted. Reload the page and try again.' };
  }
  // Honeypot — bots fill anything in this field; legit submitters never see it.
  if (String(formData.get('website') ?? '').trim() !== '') {
    return { ok: true, message: 'Thanks — your comment will appear after review.' };
  }
  // Keyed on the client IP only: including the typed email let anyone reset
  // the limit by changing the address.
  try {
    await rateLimit('blogcomment', 5, 60_000);
  } catch {
    return { ok: false, message: 'Too many comments — please wait a minute before posting again.' };
  }

  const post = await prisma.blogPost.findUnique({
    where: { id: parsed.data.postId },
    select: { slug: true, status: true },
  });
  if (!post || post.status !== 'PUBLISHED') return { ok: false, message: 'Post not found.' };

  await prisma.blogComment.create({
    data: {
      postId: parsed.data.postId,
      authorName: parsed.data.authorName,
      authorEmail: parsed.data.authorEmail,
      body: parsed.data.body,
      approved: false,
    },
  });
  revalidatePath(`/blog/${post.slug}`);
  revalidatePath('/admin/blog');
  return { ok: true, message: 'Thanks — your comment will appear after review.' };
}

/** Admin: approve / unapprove a comment. */
export async function setBlogCommentApproved(id: string, approved: boolean): Promise<void> {
  await requireCapability('content:write');
  const c = await prisma.blogComment.update({
    where: { id },
    data: { approved },
    select: { post: { select: { slug: true } } },
  });
  await audit('blogcomment.approve', id, approved ? 'approved' : 'unapproved');
  revalidatePath('/admin/blog');
  revalidatePath('/admin/blog/comments');
  if (c.post?.slug) revalidatePath(`/blog/${c.post.slug}`);
}

/** Admin: delete a comment (spam etc.). Idempotent — a second click on an
 *  already-deleted comment is a no-op instead of a P2025 crash. */
export async function deleteBlogComment(id: string): Promise<void> {
  await requireCapability('content:write');
  const c = await prisma.blogComment.findUnique({
    where: { id },
    select: { post: { select: { slug: true } } },
  });
  const { count } = await prisma.blogComment.deleteMany({ where: { id } });
  if (count > 0) await audit('blogcomment.delete', id);
  revalidatePath('/admin/blog');
  revalidatePath('/admin/blog/comments');
  if (c?.post?.slug) revalidatePath(`/blog/${c.post.slug}`);
}
