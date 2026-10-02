'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { isDeliverableEmail } from '@/lib/email';
import { escapeHtml, headerText } from '@/lib/email-html';
import { notifyUser } from '@/lib/observability';
import { notifyAndMaybeEmail } from '@/lib/notify-throttled';
import { submitSourcingRequest } from '@/lib/quotes/actions';

const CreateThreadInput = z.object({
  productSlug: z.string().min(1),
  initialMessage: z.string().min(2).max(4000),
});

/** Tell the other participant a message arrived: bell always, email unless a
 *  chat burst already emailed them (throttled per thread). */
async function notifyRecipient(
  threadId: string,
  recipient: { id: string; email: string },
  productTitle: string | null,
) {
  const ref = `MSG-${threadId.slice(-6).toUpperCase()}`;
  const href = `/app/inbox/${threadId}`;
  const about = productTitle ? ` about "${productTitle}"` : '';
  if (!isDeliverableEmail(recipient.email)) {
    await notifyUser(recipient.id, 'New message', `You have a new message${about}.`, href);
    return;
  }
  await notifyAndMaybeEmail({
    userId: recipient.id,
    toEmail: recipient.email,
    notifTitle: 'New message',
    notifBody: `You have a new message${about}.`,
    notifHref: href,
    emailSubject: `[${ref}] New message on lab2date${productTitle ? ` about "${headerText(productTitle, 120)}"` : ''}`,
    emailHtml: `<p>You have a new message${escapeHtml(about)} on lab2date.</p>
                <p><a href="${(process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '')}${href}">Open the conversation</a> to read and reply.</p>
                <p style="color:#888;font-size:12px;">While a conversation is active we email at most once every couple of hours — newer messages are in your inbox.</p>`,
    dedupeKey: ref,
  }).catch(() => null);
}

export async function startThreadWithSeller(
  input: z.infer<typeof CreateThreadInput>,
): Promise<{ error: string }> {
  const result = CreateThreadInput.safeParse(input);
  if (!result.success) return { error: 'Write a message of 2–4,000 characters.' };
  const parsed = result.data;
  const session = await requireSession({ redirectTo: `/marketplace/${parsed.productSlug}` });

  const product = await prisma.product.findUnique({
    where: { slug: parsed.productSlug },
    select: { id: true, sellerId: true, title: true, seller: { select: { email: true } } },
  });
  if (!product) return { error: 'This listing is no longer available.' };
  if (product.sellerId === session.user.id) return { error: "You can't message yourself." };

  // Imported listings belong to placeholder seller accounts nobody reads
  // (e.g. sales@<shop>.import). A thread there is a black hole, so the
  // question goes to the lab2date team as a quote request on this product —
  // the mediated flow that emails the intake inbox and the buyer's replies.
  if (!isDeliverableEmail(product.seller.email)) {
    let quoteId: string;
    try {
      ({ id: quoteId } = await submitSourcingRequest({
        buyerEmail: session.user.email,
        buyerName: session.user.name ?? '',
        description: parsed.initialMessage,
        productSlug: parsed.productSlug,
      }));
    } catch (e) {
      if (e instanceof z.ZodError) {
        const field = String(e.issues[0]?.path[0] ?? '');
        if (field === 'description') return { error: 'Please write at least 20 characters so the team can help.' };
        if (field === 'buyerName') return { error: 'Your account has no name. Add your name in your profile, then try again.' };
        return { error: 'Your message could not be sent. Please check it and try again.' };
      }
      const msg = e instanceof Error ? e.message : '';
      if (msg.startsWith('Too many submissions')) return { error: msg };
      console.error('[messages] product question failed', e);
      return { error: 'Your message was not sent. Please try again in a minute.' };
    }
    redirect(`/app/quotes/${quoteId}`);
  }

  // Reuse existing thread between this buyer + seller + product if exists.
  let thread = await prisma.messageThread.findFirst({
    where: { buyerId: session.user.id, sellerId: product.sellerId, productId: product.id },
  });

  if (!thread) {
    thread = await prisma.messageThread.create({
      data: {
        buyerId: session.user.id,
        sellerId: product.sellerId,
        productId: product.id,
        subject: `About: ${product.title}`,
        lastMessageAt: new Date(),
      },
    });
  }

  await prisma.message.create({
    data: {
      threadId: thread.id,
      authorId: session.user.id,
      body: parsed.initialMessage,
    },
  });
  await prisma.messageThread.update({
    where: { id: thread.id },
    data: { lastMessageAt: new Date() },
  });
  await notifyRecipient(thread.id, { id: product.sellerId, email: product.seller.email }, product.title);

  revalidatePath('/app/inbox');
  redirect(`/app/inbox/${thread.id}`);
}

const SendInput = z.object({
  threadId: z.string().min(1),
  body: z.string().min(1).max(4000),
});

export async function sendMessage(input: z.infer<typeof SendInput>) {
  const parsed = SendInput.parse(input);
  const session = await requireSession({ redirectTo: '/app/inbox' });

  const thread = await prisma.messageThread.findUnique({
    where: { id: parsed.threadId },
    select: {
      buyerId: true, sellerId: true,
      buyer: { select: { email: true } },
      seller: { select: { email: true } },
      product: { select: { title: true } },
    },
  });
  if (!thread) throw new Error('Thread not found');
  if (thread.buyerId !== session.user.id && thread.sellerId !== session.user.id) {
    throw new Error('Forbidden');
  }

  await prisma.message.create({
    data: { threadId: parsed.threadId, authorId: session.user.id, body: parsed.body },
  });
  await prisma.messageThread.update({
    where: { id: parsed.threadId },
    data: { lastMessageAt: new Date() },
  });
  const recipient = thread.buyerId === session.user.id
    ? { id: thread.sellerId, email: thread.seller.email }
    : { id: thread.buyerId, email: thread.buyer.email };
  await notifyRecipient(parsed.threadId, recipient, thread.product?.title ?? null);
  revalidatePath(`/app/inbox/${parsed.threadId}`);
}
