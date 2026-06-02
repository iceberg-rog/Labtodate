'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';

const CreateThreadInput = z.object({
  productSlug: z.string().min(1),
  initialMessage: z.string().min(2).max(4000),
});

export async function startThreadWithSeller(input: z.infer<typeof CreateThreadInput>) {
  const parsed = CreateThreadInput.parse(input);
  const session = await requireSession({ redirectTo: `/marketplace/${parsed.productSlug}` });

  const product = await prisma.product.findUnique({
    where: { slug: parsed.productSlug },
    select: { id: true, sellerId: true, title: true },
  });
  if (!product) throw new Error('Product not found');
  if (product.sellerId === session.user.id) throw new Error("You can't message yourself");

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
    select: { buyerId: true, sellerId: true },
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
  revalidatePath(`/app/inbox/${parsed.threadId}`);
}
