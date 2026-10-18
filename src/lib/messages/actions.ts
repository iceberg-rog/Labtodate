'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapability, requireSession } from '@/lib/auth-server';
import { isDeliverableEmail } from '@/lib/email';
import { escapeHtml, headerText } from '@/lib/email-html';
import { audit, notifyAdmins, notifyUser } from '@/lib/observability';
import { notifyAndMaybeEmail } from '@/lib/notify-throttled';
import { askAboutProduct } from '@/lib/catalog/product-question';
import { ensureSettingsLoaded, settingEnum, settingInt } from '@/lib/settings';
import { siteName } from '@/lib/brand/identity';
import { clientIp, rateLimitKey } from '@/lib/ratelimit';
import { mailLayout } from '@/lib/quotes/mail';
import {
  CONTACT_REMOVED, deliveryState, mediateMessage, mediationMode, messageText, sanitizeMessageInput, screeningSummary, storedBody,
  type MediationResult, type MessageAuthorKind,
} from './mediation';
import { isHouseSeller } from './house';
import { moveThreadToTicket } from './to-ticket';
import { participantMessages, type ParticipantMessage } from './view';

/**
 * Buyer ↔ supplier messages (“Message seller” on a supplier listing). Every
 * message goes through mediateMessage() under MESSAGE_MEDIATION_MODE; staff
 * are notified of every new conversation and of every message that had
 * details removed, was flagged or waits for release, and can reply or release
 * from Admin → Buyer-supplier threads. Questions about house stock (./house.ts)
 * are support tickets, never threads.
 */

const CreateThreadInput = z.object({
  productSlug: z.string().min(1),
  initialMessage: z.string().min(2).max(4000),
});

const LIMIT_TEXT = 'You have sent a lot of messages in a short time. Please wait a few minutes and try again.';

const threadRef = (threadId: string) => `MSG-${threadId.slice(-6).toUpperCase()}`;
const adminThreadHref = (threadId: string) => `/admin/messages/threads/${threadId}`;

/** Hosts of the site itself: links to our own listings are never removed. */
function ownHosts(): string[] {
  const hosts = new Set<string>();
  for (const raw of [process.env.BETTER_AUTH_URL, process.env.COMPANY_WEBSITE]) {
    const v = (raw ?? '').trim();
    if (!v) continue;
    try {
      hosts.add(new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname.replace(/^www\./, '').toLowerCase());
    } catch {
      /* not a URL — nothing to allow */
    }
  }
  return [...hosts];
}

/** Per-account limit (Settings → Suppliers, MESSAGE_RATE_LIMIT per hour), shared by new conversations and replies. */
async function overMessageLimit(userId: string): Promise<boolean> {
  try {
    await rateLimitKey(`messages:${userId}`, settingInt('MESSAGE_RATE_LIMIT', 30), 60 * 60_000);
    return false;
  } catch {
    return true;
  }
}

/** Tell the other participant a message arrived: bell always, email unless a
 *  chat burst already emailed them (throttled per thread). */
async function notifyRecipient(
  threadId: string,
  recipient: { id: string; email: string },
  productTitle: string | null,
) {
  const site = siteName();
  const ref = threadRef(threadId);
  const href = `/app/inbox/${threadId}`;
  const about = productTitle ? ` about "${productTitle}"` : '';
  if (!isDeliverableEmail(recipient.email)) {
    await notifyUser(recipient.id, 'New message', `You have a new message${about}.`, href);
    return;
  }
  const base = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
  await notifyAndMaybeEmail({
    userId: recipient.id,
    toEmail: recipient.email,
    notifTitle: 'New message',
    notifBody: `You have a new message${about}.`,
    notifHref: href,
    emailSubject: `[${ref}] New message on ${headerText(site, 60)}${productTitle ? ` about "${headerText(productTitle, 120)}"` : ''}`,
    emailHtml: mailLayout({
      heading: 'New message',
      body: [`You have a new message${escapeHtml(about)} on ${escapeHtml(site)}.`, 'Open the conversation to read and reply.'],
      cta: { href: `${base}${href}`, label: 'Open the conversation' },
      footer: ['While a conversation is active we email at most once every couple of hours — newer messages are in your inbox.'],
    }),
    dedupeKey: ref,
  }).catch(() => null);
}

/** Store one participant message as mediated; keeps the original for staff when something was removed. */
async function storeMediated(p: {
  threadId: string;
  author: { id: string; email: string; kind: MessageAuthorKind };
  text: string;
}): Promise<{ message: { id: string; body: string; createdAt: Date }; result: MediationResult }> {
  const result = mediateMessage({
    mode: mediationMode(settingEnum('MESSAGE_MEDIATION_MODE')),
    author: p.author.kind,
    body: p.text,
    allowHosts: ownHosts(),
  });
  const now = new Date();
  const message = await prisma.message.create({
    data: {
      threadId: p.threadId,
      authorId: p.author.id,
      body: storedBody(result.held ? 'HELD' : 'DELIVERED', result.body),
      // Held messages are nobody's "unread" until staff release them.
      readAt: result.held ? now : null,
    },
    select: { id: true, body: true, createdAt: true },
  });
  if (!result.held) {
    await prisma.messageThread.update({ where: { id: p.threadId }, data: { lastMessageAt: now } });
  }
  if (result.held || result.removed.length || result.flags.length) {
    // Full text in the audit trail (the audit() helper cuts meta at 1,000 characters).
    await prisma.auditLog.create({
      data: {
        actorId: p.author.id,
        actorEmail: p.author.email,
        ip: await clientIp().catch(() => null),
        action: 'message.screened',
        target: p.threadId,
        meta: JSON.stringify({
          messageId: message.id,
          author: p.author.kind,
          held: result.held,
          removed: result.removed,
          flags: result.flags,
          ...(result.removed.length ? { original: p.text } : {}),
        }),
      },
    }).catch(() => null);
  }
  return { message, result };
}

async function notifyStaffOfScreening(threadId: string, kind: MessageAuthorKind, productTitle: string | null, result: MediationResult) {
  if (!result.held && !result.removed.length && !result.flags.length) return;
  const who = kind === 'SUPPLIER' ? 'Supplier' : 'Buyer';
  const about = productTitle ? ` on “${productTitle.slice(0, 100)}”` : '';
  const summary = screeningSummary(result);
  await notifyAdmins(
    result.held ? `Supplier message waiting for release — ${threadRef(threadId)}` : `Message screened — ${threadRef(threadId)}`,
    `${who} message${about}${summary ? `: ${summary}` : ''}.`,
    adminThreadHref(threadId),
    'SYSTEM',
  );
}

export async function startThreadWithSeller(
  input: z.infer<typeof CreateThreadInput>,
): Promise<{ error: string }> {
  const result = CreateThreadInput.safeParse(input);
  if (!result.success) return { error: 'Write a message of 2–4,000 characters.' };
  const parsed = result.data;
  const session = await requireSession({ redirectTo: `/marketplace/${parsed.productSlug}` });
  await ensureSettingsLoaded();

  const product = await prisma.product.findUnique({
    where: { slug: parsed.productSlug },
    select: {
      id: true, sellerId: true, title: true,
      seller: { select: { email: true, name: true, role: true, companyId: true } },
    },
  });
  if (!product) return { error: 'This listing is no longer available.' };
  if (product.sellerId === session.user.id) return { error: "You can't message yourself." };

  // House stock — created by an admin, owned by an account without a supplier
  // company, or an importer placeholder nobody reads: the site is the seller
  // of record, so the question is a support ticket for the whole team (topic
  // “Product question”, product linked), never a private thread in one
  // person's inbox and never a quote request.
  if (isHouseSeller(product.seller)) {
    return askAboutProduct({ productSlug: parsed.productSlug, message: parsed.initialMessage, kind: 'QUESTION' });
  }

  const text = sanitizeMessageInput(parsed.initialMessage);
  if (text.length < 2) return { error: 'Write a message of 2–4,000 characters.' };
  if (await overMessageLimit(session.user.id)) return { error: LIMIT_TEXT };

  // Reuse existing thread between this buyer + seller + product if exists.
  let thread = await prisma.messageThread.findFirst({
    where: { buyerId: session.user.id, sellerId: product.sellerId, productId: product.id },
    select: { id: true },
  });
  const isNew = !thread;
  if (!thread) {
    thread = await prisma.messageThread.create({
      data: {
        buyerId: session.user.id,
        sellerId: product.sellerId,
        productId: product.id,
        subject: `About: ${product.title}`,
        lastMessageAt: new Date(),
      },
      select: { id: true },
    });
  }

  const kind: MessageAuthorKind = session.user.role === 'ADMIN' ? 'STAFF' : 'BUYER';
  const { result: screened } = await storeMediated({
    threadId: thread.id,
    author: { id: session.user.id, email: session.user.email, kind },
    text,
  });
  await notifyRecipient(thread.id, { id: product.sellerId, email: product.seller.email }, product.title);
  if (isNew) {
    const summary = screeningSummary(screened);
    await notifyAdmins(
      `New buyer–supplier conversation — ${threadRef(thread.id)}`,
      `${session.user.name || session.user.email} asked ${product.seller.name || product.seller.email} about “${product.title.slice(0, 100)}”${summary ? ` (${summary})` : ''}.`,
      adminThreadHref(thread.id),
      'SYSTEM',
    );
  } else {
    await notifyStaffOfScreening(thread.id, kind, product.title, screened);
  }

  revalidatePath('/app/inbox');
  revalidatePath('/admin/messages/threads');
  redirect(`/app/inbox/${thread.id}`);
}

const SendInput = z.object({
  threadId: z.string().min(1),
  body: z.string().min(1).max(4000),
});

export type SendMessageResult =
  | { ok: true; message?: ParticipantMessage; notice?: string; movedTo?: string }
  | { ok: false; error: string };

export async function sendMessage(input: z.infer<typeof SendInput>): Promise<SendMessageResult> {
  const parsed = SendInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Write a message of up to 4,000 characters.' };
  const session = await requireSession({ redirectTo: '/app/inbox' });
  await ensureSettingsLoaded();
  const userId = session.user.id;
  const { threadId } = parsed.data;
  const text = sanitizeMessageInput(parsed.data.body);
  if (!text) return { ok: false, error: 'Write a message first.' };

  const thread = await prisma.messageThread.findUnique({
    where: { id: threadId },
    select: {
      buyerId: true, sellerId: true,
      buyer: { select: { email: true } },
      seller: { select: { email: true, role: true, companyId: true } },
      product: { select: { title: true } },
    },
  });
  if (!thread || (thread.buyerId !== userId && thread.sellerId !== userId)) {
    return { ok: false, error: 'This conversation was not found.' };
  }
  if (await overMessageLimit(userId)) return { ok: false, error: LIMIT_TEXT };
  const isBuyer = thread.buyerId === userId;
  const site = siteName();

  // An older conversation about house stock: it moves to the ticket queue
  // (with this message) instead of growing in one admin's personal inbox.
  if (isHouseSeller(thread.seller)) {
    const moved = await moveThreadToTicket(threadId, {
      buyerMessage: isBuyer ? text : null,
      actor: { id: userId, email: session.user.email },
      notify: 'all',
    });
    revalidatePath(`/app/inbox/${threadId}`);
    revalidatePath('/admin/tickets');
    if (!moved) return { ok: false, error: 'This conversation was not found.' };
    if (!isBuyer) {
      return {
        ok: false,
        error: session.user.role === 'ADMIN'
          ? `This question is support ticket ${moved.ref} now: answer it in Admin → Tickets, where the whole team sees it.`
          : `The ${site} team answers this buyer now (support ticket ${moved.ref}).`,
      };
    }
    if (!moved.created) {
      return { ok: false, error: `This conversation continues as support ticket ${moved.ref}: reply under Support in your account.` };
    }
    return { ok: true, movedTo: `/app/support?sent=${encodeURIComponent(moved.ref)}`, notice: `Sent — this conversation continues as support ticket ${moved.ref}.` };
  }

  const kind: MessageAuthorKind = session.user.role === 'ADMIN' ? 'STAFF' : isBuyer ? 'BUYER' : 'SUPPLIER';
  const { message, result } = await storeMediated({ threadId, author: { id: userId, email: session.user.email, kind }, text });
  if (!result.held) {
    const recipient = isBuyer
      ? { id: thread.sellerId, email: thread.seller.email }
      : { id: thread.buyerId, email: thread.buyer.email };
    await notifyRecipient(threadId, recipient, thread.product?.title ?? null);
  }
  await notifyStaffOfScreening(threadId, kind, thread.product?.title ?? null, result);
  revalidatePath(`/app/inbox/${threadId}`);
  revalidatePath('/app/inbox');

  const [view] = participantMessages(
    [{ ...message, authorId: userId, authorRole: session.user.role }],
    { viewerId: userId, viewerIsBuyer: isBuyer, site },
  );
  return {
    ok: true,
    message: view,
    notice: result.removed.length ? `Contact details were removed from your message — all contact runs through ${site}.` : undefined,
  };
}

// ── Staff (Admin → Buyer-supplier threads) ───────────────────────────────────

type StaffResult = { ok: boolean; message: string };

/** A reply from the site's team, visible to both participants as “<Site> team”. */
export async function staffReplyToThread(threadId: string, formData: FormData): Promise<StaffResult> {
  const session = await requireCapability('messages:reply', { redirectTo: adminThreadHref(threadId) });
  await ensureSettingsLoaded();
  const text = sanitizeMessageInput(String(formData.get('body') ?? '')).slice(0, 4000);
  if (text.length < 2) return { ok: false, message: 'Write a reply first.' };
  const thread = await prisma.messageThread.findUnique({
    where: { id: threadId },
    select: {
      buyerId: true, sellerId: true,
      buyer: { select: { email: true } },
      seller: { select: { email: true } },
      product: { select: { title: true } },
    },
  });
  if (!thread) return { ok: false, message: 'This conversation no longer exists.' };
  const now = new Date();
  await prisma.message.create({ data: { threadId, authorId: session.user.id, body: text } });
  await prisma.messageThread.update({ where: { id: threadId }, data: { lastMessageAt: now } });
  const title = thread.product?.title ?? null;
  await notifyRecipient(threadId, { id: thread.buyerId, email: thread.buyer.email }, title);
  await notifyRecipient(threadId, { id: thread.sellerId, email: thread.seller.email }, title);
  await audit('message.staff_reply', threadId, threadRef(threadId));
  revalidatePath(adminThreadHref(threadId));
  revalidatePath('/admin/messages/threads');
  revalidatePath(`/app/inbox/${threadId}`);
  return { ok: true, message: `Reply posted. The buyer and the supplier both see it from “${siteName()} team” and were notified.` };
}

/** What a participant typed before contact details were removed (audit trail), or null. */
async function screenedOriginal(threadId: string, messageId: string): Promise<string | null> {
  const row = await prisma.auditLog.findFirst({
    where: { action: 'message.screened', target: threadId, meta: { contains: `"messageId":"${messageId}"` } },
    orderBy: { createdAt: 'desc' },
    select: { meta: true },
  });
  try {
    const v = JSON.parse(row?.meta ?? '') as { original?: unknown };
    return typeof v.original === 'string' ? v.original : null;
  } catch {
    return null;
  }
}

async function heldMessage(messageId: string) {
  return prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true, body: true, threadId: true, authorId: true,
      thread: {
        select: {
          buyerId: true, sellerId: true,
          buyer: { select: { email: true } },
          seller: { select: { email: true } },
          product: { select: { title: true } },
        },
      },
    },
  });
}

/** Deliver a held supplier message — as screened (contact details removed) or as written. */
export async function releaseHeldMessage(messageId: string, how: 'SCREENED' | 'AS_WRITTEN'): Promise<StaffResult> {
  const session = await requireCapability('messages:reply', { redirectTo: '/admin/messages/threads' });
  await ensureSettingsLoaded();
  const m = await heldMessage(messageId);
  if (!m || deliveryState(m.body) !== 'HELD') return { ok: false, message: 'This message is no longer waiting for release.' };
  const original = how === 'AS_WRITTEN' ? await screenedOriginal(m.threadId, m.id) : null;
  const text = original ?? messageText(m.body);
  const now = new Date();
  // Claim on the exact stored body, so two staff members can't both deliver it.
  const claimed = await prisma.message.updateMany({
    where: { id: m.id, body: m.body },
    data: { body: text, readAt: null, createdAt: now },
  });
  if (claimed.count === 0) return { ok: false, message: 'Another staff member handled this message just now.' };
  await prisma.messageThread.update({ where: { id: m.threadId }, data: { lastMessageAt: now } });
  const toBuyer = m.authorId !== m.thread.buyerId;
  await notifyRecipient(
    m.threadId,
    toBuyer ? { id: m.thread.buyerId, email: m.thread.buyer.email } : { id: m.thread.sellerId, email: m.thread.seller.email },
    m.thread.product?.title ?? null,
  );
  await audit('message.release', m.threadId, `message=${m.id} as=${original ? 'written' : 'screened'} by=${session.user.email}`);
  revalidatePath(adminThreadHref(m.threadId));
  revalidatePath('/admin/messages/threads');
  revalidatePath(`/app/inbox/${m.threadId}`);
  return {
    ok: true,
    message: original ? 'Delivered as written.' : text.includes(CONTACT_REMOVED) ? 'Delivered with the contact details removed.' : 'Delivered.',
  };
}

/** Don't deliver a held message; its author is told. */
export async function withholdHeldMessage(messageId: string): Promise<StaffResult> {
  const session = await requireCapability('messages:reply', { redirectTo: '/admin/messages/threads' });
  await ensureSettingsLoaded();
  const m = await heldMessage(messageId);
  if (!m || deliveryState(m.body) !== 'HELD') return { ok: false, message: 'This message is no longer waiting for release.' };
  const claimed = await prisma.message.updateMany({
    where: { id: m.id, body: m.body },
    data: { body: storedBody('WITHHELD', messageText(m.body)), createdAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, message: 'Another staff member handled this message just now.' };
  const site = siteName();
  await notifyUser(
    m.authorId,
    'Message not delivered',
    `The ${site} team did not pass on your message in conversation ${threadRef(m.threadId)}. Please keep prices, payment and contact on ${site}.`,
    `/app/inbox/${m.threadId}`,
  );
  await audit('message.withhold', m.threadId, `message=${m.id} by=${session.user.email}`);
  revalidatePath(adminThreadHref(m.threadId));
  revalidatePath('/admin/messages/threads');
  revalidatePath(`/app/inbox/${m.threadId}`);
  return { ok: true, message: 'Not delivered. The supplier was told.' };
}
