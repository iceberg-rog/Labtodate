'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { getServerSession, requireSession } from '@/lib/auth-server';
import { aiChat, type AIMessage } from '@/lib/ai';
import { ensureSettingsLoaded } from '@/lib/settings';
import { audit, notifyAdmins, notifyUser } from '@/lib/observability';
import { notifyAndMaybeEmail } from '@/lib/notify-throttled';

const GUEST_COOKIE = 'lab2_asst_g';
const GUEST_COOKIE_TTL_DAYS = 90;

/**
 * Resolve the conversation actor:
 *   - If logged in → { userId }
 *   - Else → { guestToken } (read existing cookie or mint a fresh one)
 *
 * Either way we have a stable handle to upsert/lookup the conversation.
 */
async function resolveActor(): Promise<{
  userId: string | null;
  guestToken: string | null;
  userName?: string;
  userEmail?: string;
}> {
  const session = await getServerSession();
  if (session?.user) {
    return {
      userId: session.user.id,
      guestToken: null,
      userName: session.user.name,
      userEmail: session.user.email,
    };
  }
  const cookieStore = await cookies();
  let token = cookieStore.get(GUEST_COOKIE)?.value;
  if (!token) {
    token = randomBytes(24).toString('hex');
    cookieStore.set(GUEST_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: GUEST_COOKIE_TTL_DAYS * 86400,
    });
  }
  return { userId: null, guestToken: token };
}

/**
 * Find the active conversation for this actor (status NOT in ARCHIVED).
 * One person at a time can have at most one open conversation — keeps the
 * model simple. Older archived ones stay around for history.
 */
async function findOrCreateConversation(actor: {
  userId: string | null;
  guestToken: string | null;
}): Promise<string> {
  const where = actor.userId
    ? { userId: actor.userId, archivedAt: null }
    : { guestToken: actor.guestToken!, archivedAt: null };
  const existing = await prisma.assistantConversation.findFirst({
    where,
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.assistantConversation.create({
    data: {
      userId: actor.userId,
      guestToken: actor.guestToken,
      status: 'AI',
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Send a user message. Always persists the message; if status=AI we call the
 * LLM for a reply and persist that too. If status=AWAITING_HUMAN or
 * WITH_HUMAN we just queue the message + ping admins. Returns the full
 * conversation snapshot so the client can re-render.
 */
export async function sendAssistantMessage(input: {
  body: string;
  attachments?: string[];
}): Promise<{
  conversationId: string;
  messages: Array<{ id: string; role: string; body: string; attachments: string[]; createdAt: string }>;
  status: string;
  rating: number | null;
  closedAt: string | null;
}> {
  await ensureSettingsLoaded();
  const actor = await resolveActor();
  const conversationId = await findOrCreateConversation(actor);
  const body = (input.body || '').trim().slice(0, 4000);
  const attachments = (input.attachments || []).slice(0, 4);
  if (!body && attachments.length === 0) {
    return readConversation(conversationId);
  }

  // Persist user message.
  await prisma.assistantMessage.create({
    data: {
      conversationId,
      role: 'user',
      authorId: actor.userId,
      body,
      attachments,
    },
  });

  // If subject is empty, snapshot the first user message as subject for the
  // admin queue.
  await prisma.assistantConversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: new Date(),
      subject: { set: (await prisma.assistantConversation.findUnique({ where: { id: conversationId }, select: { subject: true } }))?.subject || body.slice(0, 60) },
    },
  });

  const convo = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
    select: { status: true, userId: true, guestEmail: true, assignedToId: true },
  });
  if (!convo) return readConversation(conversationId);

  if (convo.status === 'AI') {
    // Build history for AI: most-recent 12 messages, mapped to the OpenAI
    // schema. Admin messages count as 'assistant' for the model's PoV.
    const history = await prisma.assistantMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 12,
      select: { role: true, body: true },
    });
    const aiHistory: AIMessage[] = history.map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.body,
    }));
    let reply: string;
    try {
      reply = await aiChat(aiHistory);
    } catch (e) {
      reply =
        'I hit a technical hiccup. If this is urgent, click "Talk to a human" and an operator will join shortly.';
      console.error('AI error', e);
    }
    await prisma.assistantMessage.create({
      data: { conversationId, role: 'assistant', body: reply },
    });
    await prisma.assistantConversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });
  } else if (convo.status === 'AWAITING_HUMAN' || convo.status === 'WITH_HUMAN') {
    // Ping admins so they can jump in.
    await notifyAdmins(
      `New customer message · ${conversationId.slice(-6).toUpperCase()}`,
      body.slice(0, 140),
      `/admin/messages/${conversationId}`,
      'SYSTEM',
    ).catch(() => null);
  }

  return readConversation(conversationId);
}

/**
 * User clicks "Talk to a human". Marks the conversation AWAITING_HUMAN and
 * pings admins. Optional name/email collected so the operator can address
 * the customer; passing them is recommended for guests but optional for
 * logged-in users (we already have their profile).
 */
export async function requestHumanEscalation(input: {
  name?: string;
  email?: string;
}): Promise<{ conversationId: string; status: string }> {
  await ensureSettingsLoaded();
  const actor = await resolveActor();
  const conversationId = await findOrCreateConversation(actor);
  const conv = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
    select: { status: true, subject: true, userId: true, guestName: true, guestEmail: true },
  });
  if (!conv) throw new Error('Conversation not found');
  if (conv.status === 'CLOSED' || conv.status === 'ARCHIVED') {
    return { conversationId, status: conv.status };
  }
  await prisma.assistantConversation.update({
    where: { id: conversationId },
    data: {
      status: 'AWAITING_HUMAN',
      lastMessageAt: new Date(),
      ...(actor.userId
        ? {}
        : {
            guestName: (input.name || conv.guestName)?.slice(0, 120) ?? null,
            guestEmail: (input.email || conv.guestEmail)?.slice(0, 120) ?? null,
          }),
    },
  });
  await prisma.assistantMessage.create({
    data: {
      conversationId,
      role: 'system',
      body: 'Customer requested a human operator.',
    },
  });
  const tag = actor.userId
    ? '(registered user)'
    : `(guest${input.name ? ` · ${input.name}` : ''}${input.email ? ` · ${input.email}` : ''})`;
  await notifyAdmins(
    `Live chat handoff · ${conversationId.slice(-6).toUpperCase()}`,
    `${conv.subject ?? 'New chat'} ${tag}`,
    `/admin/messages/${conversationId}`,
    'SYSTEM',
  ).catch(() => null);
  await audit('assistant.escalate', conversationId.slice(-6).toUpperCase(), tag);
  return { conversationId, status: 'AWAITING_HUMAN' };
}

/**
 * Admin claims an awaiting conversation (idempotent — second claim re-asserts).
 */
export async function adminClaimConversation(formData: FormData): Promise<void> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/messages' });
  const id = String(formData.get('conversationId') ?? '');
  if (!id) return;
  await prisma.assistantConversation.update({
    where: { id },
    data: { status: 'WITH_HUMAN', assignedToId: session.user.id, lastMessageAt: new Date() },
  });
  await prisma.assistantMessage.create({
    data: { conversationId: id, role: 'system', body: `${session.user.name} joined the chat.` },
  });
  await audit('assistant.claim', id.slice(-6).toUpperCase(), `by=${session.user.email}`);
  revalidatePath('/admin/messages');
  revalidatePath(`/admin/messages/${id}`);
}

/**
 * Admin reply. Persists, advances state if needed, pings user.
 */
export async function adminReplyConversation(formData: FormData): Promise<void> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/messages' });
  await ensureSettingsLoaded();
  const id = String(formData.get('conversationId') ?? '');
  const body = String(formData.get('body') ?? '').trim().slice(0, 4000);
  const attachmentsRaw = String(formData.get('attachments') ?? '').trim();
  const attachments = attachmentsRaw ? attachmentsRaw.split(',').filter((u) => u.startsWith('http')) : [];
  if (!id || (!body && attachments.length === 0)) return;

  const conv = await prisma.assistantConversation.findUnique({
    where: { id },
    select: { userId: true, guestEmail: true, guestName: true, status: true, subject: true, assignedToId: true },
  });
  if (!conv) return;

  await prisma.assistantMessage.create({
    data: {
      conversationId: id,
      role: 'admin',
      authorId: session.user.id,
      body,
      attachments,
    },
  });
  await prisma.assistantConversation.update({
    where: { id },
    data: {
      status: conv.status === 'AWAITING_HUMAN' ? 'WITH_HUMAN' : conv.status,
      assignedToId: session.user.id,
      lastMessageAt: new Date(),
    },
  });
  const ref = `CHT-${id.slice(-6).toUpperCase()}`;
  if (conv.userId) {
    await notifyAndMaybeEmail({
      userId: conv.userId,
      toEmail: (await prisma.user.findUnique({ where: { id: conv.userId }, select: { email: true } }))?.email ?? '',
      notifTitle: `New reply · ${ref}`,
      notifBody: `An operator replied: ${body.slice(0, 120)}`,
      notifHref: '/app#chat-open',
      emailSubject: `[${ref}] We replied to your chat on lab2date`,
      emailHtml: `<p>Hi,</p><p>An operator replied to your chat:</p><blockquote style="border-left:3px solid #ddd;padding-left:12px;color:#444;">${body.slice(0, 500)}</blockquote><p><a href="${(process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '')}/app">Open lab2date</a> to continue the conversation.</p>`,
      dedupeKey: ref,
    });
  } else if (conv.guestEmail) {
    // Guest — fire a one-shot email; throttle still applies via EmailLog.
    await notifyAndMaybeEmail({
      userId: null,
      toEmail: conv.guestEmail,
      notifTitle: '',
      notifBody: '',
      notifHref: '',
      emailSubject: `[${ref}] We replied to your chat on lab2date`,
      emailHtml: `<p>Hi ${conv.guestName ?? 'there'},</p><p>An operator replied to your chat:</p><blockquote style="border-left:3px solid #ddd;padding-left:12px;color:#444;">${body.slice(0, 500)}</blockquote><p>Re-open the chat at the bottom-right of <a href="${process.env.BETTER_AUTH_URL || 'https://labtodate.com'}">labtodate.com</a> to continue.</p>`,
      dedupeKey: ref,
    });
  }
  await audit('assistant.reply', ref, `by=${session.user.email}`);
  revalidatePath('/admin/messages');
  revalidatePath(`/admin/messages/${id}`);
}

/** Admin closes; user gets a rating prompt next time they open the widget. */
export async function adminCloseConversation(formData: FormData): Promise<void> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/messages' });
  const id = String(formData.get('conversationId') ?? '');
  if (!id) return;
  await prisma.assistantConversation.update({
    where: { id },
    data: { status: 'CLOSED', closedAt: new Date(), closedById: session.user.id, lastMessageAt: new Date() },
  });
  await prisma.assistantMessage.create({
    data: { conversationId: id, role: 'system', body: `${session.user.name} closed the chat.` },
  });
  const conv = await prisma.assistantConversation.findUnique({
    where: { id },
    select: { userId: true, guestEmail: true },
  });
  if (conv?.userId) {
    await notifyUser(
      conv.userId,
      `Chat closed — rate your experience`,
      `An operator closed your chat. Rate it next time you open the assistant.`,
      '/app#chat-open',
    ).catch(() => null);
  }
  await audit('assistant.close', id.slice(-6).toUpperCase(), `by=${session.user.email}`);
  revalidatePath('/admin/messages');
  revalidatePath(`/admin/messages/${id}`);
}

/** User rates a CLOSED conversation 1..5. Archives after submission. */
export async function rateAssistantConversation(input: {
  rating: number;
  note?: string;
}): Promise<{ ok: boolean }> {
  const actor = await resolveActor();
  const conversationId = await findOrCreateConversation(actor);
  const r = Math.max(1, Math.min(5, Math.round(input.rating || 0)));
  if (!r) return { ok: false };
  await prisma.assistantConversation.update({
    where: { id: conversationId },
    data: {
      rating: r,
      ratingNote: (input.note || '').slice(0, 500) || null,
      ratedAt: new Date(),
      status: 'ARCHIVED',
      archivedAt: new Date(),
    },
  });
  await audit('assistant.rate', conversationId.slice(-6).toUpperCase(), `rating=${r}`);
  return { ok: true };
}

/** Snapshot reader used by the widget on every send. */
export async function readConversation(conversationId: string): Promise<{
  conversationId: string;
  messages: Array<{ id: string; role: string; body: string; attachments: string[]; createdAt: string }>;
  status: string;
  rating: number | null;
  closedAt: string | null;
}> {
  const conv = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      status: true,
      rating: true,
      closedAt: true,
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, body: true, attachments: true, createdAt: true },
        take: 200,
      },
    },
  });
  if (!conv) {
    return { conversationId, messages: [], status: 'AI', rating: null, closedAt: null };
  }
  return {
    conversationId: conv.id,
    messages: conv.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    status: conv.status,
    rating: conv.rating,
    closedAt: conv.closedAt?.toISOString() ?? null,
  };
}

/** Initial snapshot for the widget on open — finds existing conversation. */
export async function getOrInitConversation(): Promise<{
  conversationId: string;
  messages: Array<{ id: string; role: string; body: string; attachments: string[]; createdAt: string }>;
  status: string;
  rating: number | null;
  closedAt: string | null;
  identity: { kind: 'user' | 'guest'; name: string | null; email: string | null };
}> {
  const actor = await resolveActor();
  const id = await findOrCreateConversation(actor);
  const snap = await readConversation(id);
  return {
    ...snap,
    identity: {
      kind: actor.userId ? 'user' : 'guest',
      name: actor.userName ?? null,
      email: actor.userEmail ?? null,
    },
  };
}

/**
 * Archive whatever non-archived conversation this actor has, then create a
 * fresh AI-mode one. Used by the widget's "Start a new chat" button after
 * the user rates a closed conversation. Returns the new empty snapshot.
 */
export async function startFreshConversation(): Promise<{
  conversationId: string;
  messages: Array<{ id: string; role: string; body: string; attachments: string[]; createdAt: string }>;
  status: string;
  rating: number | null;
  closedAt: string | null;
  identity: { kind: 'user' | 'guest'; name: string | null; email: string | null };
}> {
  const actor = await resolveActor();
  const where = actor.userId
    ? { userId: actor.userId, archivedAt: null }
    : { guestToken: actor.guestToken!, archivedAt: null };
  // Sweep any open conversation into archived so findOrCreateConversation
  // returns a fresh row on the next call. updateMany silently no-ops if
  // there's nothing to archive — fine.
  await prisma.assistantConversation.updateMany({
    where,
    data: { archivedAt: new Date(), status: 'ARCHIVED' },
  });
  const created = await prisma.assistantConversation.create({
    data: { userId: actor.userId, guestToken: actor.guestToken, status: 'AI' },
    select: { id: true },
  });
  return {
    conversationId: created.id,
    messages: [],
    status: 'AI',
    rating: null,
    closedAt: null,
    identity: {
      kind: actor.userId ? 'user' : 'guest',
      name: actor.userName ?? null,
      email: actor.userEmail ?? null,
    },
  };
}
