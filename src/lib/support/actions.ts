'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession, requireSession, requireCapability } from '@/lib/auth-server';
import { sendEmail } from '@/lib/email';
import { ensureSettingsLoaded } from '@/lib/settings';
import { rateLimit } from '@/lib/ratelimit';
import { notifyAdmins, notifyUser, audit } from '@/lib/observability';

// ────────────────────────────────────────────────────────────────────────────
//   Slice A helpers — priority + SLA + linked-commerce auto-detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * SLA tier defaults (hours). Customer-configurable later via Settings, but
 * these are the baked defaults that drive `dueAt` + the "overdue" badge.
 * URGENT / VIP share the same tightest tier (2h response).
 */
const SLA_HOURS: Record<string, number> = {
  URGENT: 2,
  VIP: 2,
  HIGH: 8,
  NORMAL: 24,
  LOW: 72,
};

/** Cents threshold (lifetime paid value) above which a buyer is auto-VIP. */
const VIP_LIFETIME_CENTS = 50_000_00; // €50,000

/** Words in the ticket body that bump priority. Conservative — only obvious
 *  red flags. Tweak via Settings later (slice E). */
const URGENT_WORDS = /\b(fraud|scam|chargeback|dispute|stolen|hacked|unauthorised|unauthorized)\b/i;
const SHIPPING_WORDS = /\b(missing|lost|never arrived|damaged|broken|wrong item|customs)\b/i;
const PAYMENT_WORDS = /\b(refund|wrong amount|double charge|invoice wrong|paid twice)\b/i;

/**
 * Compute an initial priority for a brand-new ticket. Order of precedence:
 *   1. VIP customer (lifetime spend ≥ threshold) — fixed at VIP
 *   2. Body contains URGENT words (fraud/chargeback) → URGENT
 *   3. Body contains SHIPPING_WORDS → HIGH
 *   4. Body contains PAYMENT_WORDS → HIGH
 *   5. Linked to an unpaid (>24h) order → HIGH
 *   6. Otherwise → NORMAL
 */
async function computeInitialPriority(opts: {
  body: string;
  subject: string;
  submittedById: string | null;
  linkedOrderId: string | null;
}): Promise<string> {
  const text = `${opts.subject} ${opts.body}`;
  if (opts.submittedById) {
    const agg = await prisma.order.aggregate({
      where: {
        buyerId: opts.submittedById,
        status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
      },
      _sum: { totalCents: true },
    });
    const ltv = agg._sum.totalCents ?? 0;
    if (ltv >= VIP_LIFETIME_CENTS) return 'VIP';
  }
  if (URGENT_WORDS.test(text)) return 'URGENT';
  if (SHIPPING_WORDS.test(text) || PAYMENT_WORDS.test(text)) return 'HIGH';
  if (opts.linkedOrderId) {
    const o = await prisma.order.findUnique({
      where: { id: opts.linkedOrderId },
      select: { status: true, createdAt: true },
    });
    if (
      o && o.status === 'PENDING_PAYMENT' &&
      Date.now() - o.createdAt.getTime() > 24 * 3600e3
    ) return 'HIGH';
  }
  return 'NORMAL';
}

/** dueAt = createdAt + hours(priority). */
function computeDueAt(createdAt: Date, priority: string): Date {
  const h = SLA_HOURS[priority] ?? SLA_HOURS.NORMAL;
  return new Date(createdAt.getTime() + h * 3600e3);
}

/** Find a linked Order via order-number mention in the body/subject. */
async function detectLinkedOrder(opts: {
  body: string;
  subject: string;
  email: string;
}): Promise<{ orderId: string | null; sourcingRequestId: string | null }> {
  const blob = `${opts.subject} ${opts.body}`;
  const m = blob.match(/L2D-\d{4}-[A-Z0-9]{6}/i);
  if (m) {
    const o = await prisma.order.findUnique({
      where: { orderNumber: m[0].toUpperCase() },
      select: { id: true },
    });
    if (o) return { orderId: o.id, sourcingRequestId: null };
  }
  const pro = blob.match(/PRO-\d{4}-[A-Z0-9]{6}/i);
  if (pro) {
    const sr = await prisma.sourcingRequest.findUnique({
      where: { proformaNumber: pro[0].toUpperCase() },
      select: { id: true },
    });
    if (sr) return { orderId: null, sourcingRequestId: sr.id };
  }
  return { orderId: null, sourcingRequestId: null };
}

/** Magic-link access token. URL-safe base64 of 24 random bytes. */
function makeAccessToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Default magic-link TTL — 14 days from issue. */
const MAGIC_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
function tokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + MAGIC_LINK_TTL_MS);
}

const TicketInput = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  subject: z.string().min(3).max(160),
  category: z.string().max(60).optional().nullable(),
  body: z.string().min(10).max(5000),
  hp: z.string().optional(),
});

function ref(): string {
  return `TKT-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/** Retry a ticket-ref-bearing create on the rare unique collision. */
export async function withUniqueTicketRef<T>(
  create: (ref: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await create(ref());
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        attempt < 5
      ) {
        continue;
      }
      throw e;
    }
  }
  throw new Error('Could not allocate a ticket reference');
}

export async function submitTicket(input: z.infer<typeof TicketInput>) {
  const p = TicketInput.parse(input);
  if (p.hp && p.hp.trim()) return { ref: 'TKT-OK' }; // honeypot: silently drop bots
  await rateLimit('ticket');
  await ensureSettingsLoaded();
  const session = await getServerSession();

  // Auto-detect linked commerce + compute priority. These are cheap (single
  // indexed lookup each) and run BEFORE the insert so dueAt is right on disk.
  const linked = await detectLinkedOrder({ body: p.body, subject: p.subject, email: p.email });
  const priority = await computeInitialPriority({
    body: p.body,
    subject: p.subject,
    submittedById: session?.user.id ?? null,
    linkedOrderId: linked.orderId,
  });
  const now = new Date();
  const dueAt = computeDueAt(now, priority);
  const customerType = session?.user.id ? 'REGISTERED' : 'GUEST';
  const accessToken = customerType === 'GUEST' ? makeAccessToken() : null;
  const accessTokenIssuedAt = accessToken ? now : null;
  const accessTokenExpiresAt = accessToken ? tokenExpiry(now) : null;

  const ticket = await withUniqueTicketRef((r) =>
    prisma.supportTicket.create({
      data: {
        ref: r,
        name: p.name,
        email: p.email,
        subject: p.subject,
        category: p.category || null,
        submittedById: session?.user.id ?? null,
        priority,
        dueAt,
        customerType,
        accessToken,
        accessTokenIssuedAt,
        accessTokenExpiresAt,
        orderId: linked.orderId,
        sourcingRequestId: linked.sourcingRequestId,
        lastReplyAt: now,
        lastReplyByStaff: false,
        status: 'WAITING_ON_SUPPORT', // a new ticket is always our turn
        messages: { create: { fromStaff: false, authorId: session?.user.id ?? null, body: p.body } },
      },
    }),
  );

  const site = process.env.SITE_NAME || 'lab2date';
  // GUEST tickets get a magic-link button so the customer can follow up
  // without creating an account. REGISTERED tickets get a dashboard link.
  const followUpHref = accessToken
    ? `${process.env.BETTER_AUTH_URL ?? ''}/support/t/${accessToken}`
    : `${process.env.BETTER_AUTH_URL ?? ''}/app/support`;
  await sendEmail({
    to: p.email,
    subject: `[${ticket.ref}] We received your request`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:560px;">
        <h2 style="color:#0E4F40;">We&rsquo;re on it, ${p.name}</h2>
        <p>Your support ticket has been logged. Our team will reply by email.</p>
        <p><strong>Reference:</strong> ${ticket.ref}<br><strong>Subject:</strong> ${p.subject}</p>
        <blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${p.body.replace(/\n/g, '<br>')}</blockquote>
        <p style="margin:18px 0;">
          <a href="${followUpHref}" style="background:#0E4F40;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
            ${accessToken ? 'View / reply to ticket' : 'Open in dashboard'}
          </a>
        </p>
        ${accessToken ? `<p style="color:#888;font-size:11px;">This is a private link tied to your ticket — keep it to yourself.</p>` : ''}
        <p style="color:#888;font-size:12px;">${site}</p>
      </div>`,
  });

  const ops =
    process.env.SUPPORT_INTAKE_EMAIL ||
    process.env.SUPPORT_EMAIL ||
    process.env.COMPANY_EMAIL ||
    'support@lab2date.com';
  await sendEmail({
    to: ops,
    subject: `New support ticket ${ticket.ref}: ${p.subject}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:600px;">
        <h2 style="color:#0E4F40;">New support ticket</h2>
        <p>From <strong>${p.name}</strong> &lt;${p.email}&gt;${p.category ? ` · ${p.category}` : ''}</p>
        <p><strong>${p.subject}</strong></p>
        <blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${p.body.replace(/\n/g, '<br>')}</blockquote>
        <p style="color:#888;font-size:12px;">Ref ${ticket.ref}</p>
      </div>`,
  });

  if (session?.user.id) {
    await prisma.notification.create({
      data: {
        userId: session.user.id,
        title: `Ticket ${ticket.ref} received`,
        body: `We logged your request: "${p.subject}". Track it and reply under Support.`,
        href: '/app/support',
        kind: 'SYSTEM',
      },
    });
  }

  // Toast/bell + webhook event. Title hints at priority for the operator
  // who's about to triage — they should see "URGENT" or "VIP" before
  // clicking through.
  const pri = priority === 'NORMAL' ? '' : ` [${priority}]`;
  await notifyAdmins(
    `New support ticket ${ticket.ref}${pri}`,
    `${p.name}: ${p.subject}`,
    `/admin/tickets/${ticket.id}`,
    'TICKET_NEW',
  );

  await audit('ticket.create', ticket.ref, `priority=${priority} type=${customerType}${linked.orderId ? ` orderId=${linked.orderId}` : ''}${linked.sourcingRequestId ? ` rfqId=${linked.sourcingRequestId}` : ''}`);

  revalidatePath('/admin/tickets');
  revalidatePath('/app/notifications');
  return { ref: ticket.ref, accessToken };
}

export async function submitTicketAndRedirect(input: z.infer<typeof TicketInput>) {
  const { ref: r } = await submitTicket(input);
  redirect(`/support/thanks?ref=${r}`);
}

function parseAttachments(v: FormDataEntryValue | null): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const arr = JSON.parse(v);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((u): u is string => typeof u === 'string')
      // Allow ONLY the auth-gated proxy URL going forward. Legacy `/media/`
      // and full S3 URLs are explicitly rejected — they'd leak through
      // straight S3 GET and bypass the support-attachment auth check.
      .filter((u) => u.startsWith('/api/support-attachment/'))
      .slice(0, 5);
  } catch {
    return [];
  }
}

export async function replyTicket(formData: FormData) {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:reply', { redirectTo: '/admin/tickets' });
  await ensureSettingsLoaded();
  const ticketId = String(formData.get('ticketId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const attachments = parseAttachments(formData.get('attachments'));
  // Internal notes are admin-only — they're stored on the same SupportMessage
  // table with isInternalNote=true and NEVER emailed to the customer.
  const isInternalNote = String(formData.get('internal') ?? '') === '1';
  if (!ticketId || (body.length < 1 && attachments.length === 0)) return;

  const t = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!t) throw new Error('Ticket not found');

  const now = new Date();
  await prisma.supportMessage.create({
    data: {
      ticketId,
      fromStaff: true,
      authorId: session.user.id,
      body: body.slice(0, 5000),
      attachments,
      isInternalNote,
    },
  });

  // Status transitions: an admin reply (non-internal) moves us to
  // WAITING_ON_CUSTOMER. Internal notes don't shift state — they're just
  // commentary the customer never sees. Closed stays closed.
  if (!isInternalNote) {
    await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: t.status === 'CLOSED' || t.status === 'RESOLVED' ? t.status : 'WAITING_ON_CUSTOMER',
        lastReplyAt: now,
        lastReplyByStaff: true,
      },
    });
  }

  // Email — only on customer-facing replies. Internal notes stay in the
  // admin UI. The "reply to this email" line is dead weight until slice D
  // (inbound parsing); the magic link line is the actionable one for guests.
  if (!isInternalNote) {
    const site = process.env.SITE_NAME || 'lab2date';
    const continueLine = t.accessToken
      ? `<p style="margin-top:18px;"><a href="${process.env.BETTER_AUTH_URL ?? ''}/support/t/${t.accessToken}" style="background:#0E4F40;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Open ticket ${t.ref}</a></p>`
      : `<p style="margin-top:18px;"><a href="${process.env.BETTER_AUTH_URL ?? ''}/app/support" style="background:#0E4F40;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Open ticket ${t.ref}</a></p>`;
    await sendEmail({
      to: t.email,
      subject: `[${t.ref}] Reply from ${site} support`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:560px;">
          <h2 style="color:#0E4F40;">Re: ${t.subject}</h2>
          <div style="font-size:14px;line-height:1.7;color:#333;">${body.replace(/\n/g, '<br>')}</div>
          ${continueLine}
          <p style="color:#888;font-size:12px;margin-top:18px;">Ref ${t.ref} · ${site}</p>
        </div>`,
    });

    if (t.submittedById) {
      await prisma.notification.create({
        data: {
          userId: t.submittedById,
          title: `Support replied · ${t.ref}`,
          body: `New reply on "${t.subject}". Open Support to read and respond.`,
          href: '/app/support',
          kind: 'SYSTEM',
        },
      });
    }
  }

  await audit(isInternalNote ? 'ticket.note.add' : 'ticket.reply', t.ref, `${session.user.email}${attachments.length ? ` +${attachments.length}attach` : ''}`);

  revalidatePath('/admin/tickets');
  revalidatePath(`/admin/tickets/${ticketId}`);
  revalidatePath('/app/notifications');
  revalidatePath('/app/support');
}

export async function customerReplyTicket(formData: FormData) {
  const session = await requireSession({ redirectTo: '/app/support' });
  await ensureSettingsLoaded();
  const ticketId = String(formData.get('ticketId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const attachments = parseAttachments(formData.get('attachments'));
  if (!ticketId || (body.length < 1 && attachments.length === 0)) return;

  const t = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!t) throw new Error('Ticket not found');
  if (t.submittedById !== session.user.id && t.email !== session.user.email) {
    throw new Error('Forbidden');
  }

  const now = new Date();
  await prisma.supportMessage.create({
    data: { ticketId, fromStaff: false, authorId: session.user.id, body: body.slice(0, 5000), attachments },
  });
  await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      status: 'WAITING_ON_SUPPORT',
      lastReplyAt: now,
      lastReplyByStaff: false,
      // BUG-018: a customer reply MUST resurface the ticket to the working
      // queue. Without this, a reply on an admin-archived ticket stays hidden
      // in Archived and is effectively a lost customer message.
      archivedAt: null,
      archivedById: null,
    },
  });

  const ops =
    process.env.SUPPORT_INTAKE_EMAIL || process.env.SUPPORT_EMAIL || process.env.COMPANY_EMAIL || 'support@lab2date.com';
  await sendEmail({
    to: ops,
    subject: `[${t.ref}] Customer reply: ${t.subject}`,
    html: `<p>${session.user.name} replied to ticket ${t.ref}:</p><blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${body.replace(/\n/g, '<br>')}</blockquote>`,
  });

  await notifyAdmins(
    `Customer replied · ${t.ref}`,
    `${session.user.name} replied on "${t.subject}"`,
    `/admin/tickets/${ticketId}`,
    'TICKET_NEW',
  );
  await audit('ticket.customer.reply', t.ref, session.user.email);

  revalidatePath('/app/support');
  revalidatePath('/admin/tickets');
  revalidatePath(`/admin/tickets/${ticketId}`);
}

// ────────────────────────────────────────────────────────────────────────────
//   Status / priority / assignment / linked-commerce
// ────────────────────────────────────────────────────────────────────────────

const ALLOWED_STATUSES = ['OPEN', 'WAITING_ON_CUSTOMER', 'WAITING_ON_SUPPORT', 'RESOLVED', 'CLOSED', 'SPAM'] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];
const ALLOWED_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT', 'VIP'] as const;
type AllowedPriority = (typeof ALLOWED_PRIORITIES)[number];

export async function setTicketStatus(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:status', { redirectTo: '/admin/tickets' });
  const id = String(formData.get('ticketId') ?? '');
  const status = String(formData.get('status') ?? '') as AllowedStatus;
  if (!id || !ALLOWED_STATUSES.includes(status)) return { ok: false, message: 'Invalid status.' };
  const t = await prisma.supportTicket.findUnique({ where: { id }, select: { ref: true, status: true, archivedAt: true } });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  // Auto-archive on CLOSED — keeps the active queue lean. CLOSED tickets stay
  // restorable from the archive view; nothing is deleted.
  const shouldAutoArchive = status === 'CLOSED' && !t.archivedAt;
  await prisma.supportTicket.update({
    where: { id },
    data: shouldAutoArchive
      ? { status, archivedAt: new Date(), archivedById: session.user.id }
      : { status },
  });
  await audit('ticket.status', t.ref, `${t.status} → ${status} by ${session.user.email}`);
  if (shouldAutoArchive) {
    await audit('ticket.archive', t.ref, `auto on CLOSE by ${session.user.email}`);
  }
  revalidatePath('/admin/tickets');
  revalidatePath(`/admin/tickets/${id}`);
  return {
    ok: true,
    message: shouldAutoArchive
      ? 'Closed and archived.'
      : `Status set to ${status.toLowerCase().replace(/_/g, ' ')}.`,
  };
}

export async function setTicketPriority(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:status', { redirectTo: '/admin/tickets' });
  const id = String(formData.get('ticketId') ?? '');
  const priority = String(formData.get('priority') ?? '') as AllowedPriority;
  if (!id || !ALLOWED_PRIORITIES.includes(priority)) return { ok: false, message: 'Invalid priority.' };
  const t = await prisma.supportTicket.findUnique({ where: { id }, select: { ref: true, priority: true, createdAt: true } });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  // Recompute dueAt from CURRENT time + new tier (operator-set priority means
  // we treat it as a fresh SLA window — avoids "already overdue" when an
  // admin downgrades from URGENT to LOW after the original 2h elapsed).
  const dueAt = computeDueAt(new Date(), priority);
  await prisma.supportTicket.update({
    where: { id },
    data: { priority, dueAt, slaBreachAt: null },
  });
  await audit('ticket.priority', t.ref, `${t.priority} → ${priority} by ${session.user.email}`);
  revalidatePath('/admin/tickets');
  revalidatePath(`/admin/tickets/${id}`);
  return { ok: true, message: `Priority set to ${priority}.` };
}

/** Claim a ticket for myself. The everyday assignment move. */
export async function claimTicket(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:assign', { redirectTo: '/admin/tickets' });
  const id = String(formData.get('ticketId') ?? '');
  if (!id) return { ok: false, message: 'Missing ticket id.' };
  const t = await prisma.supportTicket.findUnique({ where: { id }, select: { ref: true, assignedToId: true } });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  if (t.assignedToId === session.user.id) return { ok: false, message: 'Already yours.' };
  await prisma.supportTicket.update({ where: { id }, data: { assignedToId: session.user.id } });
  await audit('ticket.claim', t.ref, `claimer=${session.user.email}${t.assignedToId ? ` (took from ${t.assignedToId})` : ''}`);
  revalidatePath('/admin/tickets');
  revalidatePath(`/admin/tickets/${id}`);
  return { ok: true, message: 'Claimed.' };
}

/** Transfer to another admin by user id. Form must include `toUserId`. */
export async function transferTicket(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:assign', { redirectTo: '/admin/tickets' });
  const id = String(formData.get('ticketId') ?? '');
  const toUserId = String(formData.get('toUserId') ?? '');
  if (!id || !toUserId) return { ok: false, message: 'Missing fields.' };
  const [t, target] = await Promise.all([
    prisma.supportTicket.findUnique({ where: { id }, select: { ref: true, assignedToId: true } }),
    prisma.user.findUnique({ where: { id: toUserId }, select: { email: true, role: true } }),
  ]);
  if (!t) return { ok: false, message: 'Ticket not found.' };
  if (!target || target.role !== 'ADMIN') return { ok: false, message: 'Target must be an admin.' };
  await prisma.supportTicket.update({ where: { id }, data: { assignedToId: toUserId } });
  await notifyUser(toUserId, `Ticket ${t.ref} transferred to you`, `${session.user.email} transferred a ticket to you.`, `/admin/tickets/${id}`);
  await audit('ticket.transfer', t.ref, `from=${session.user.email} to=${target.email}`);
  revalidatePath('/admin/tickets');
  revalidatePath(`/admin/tickets/${id}`);
  return { ok: true, message: `Transferred to ${target.email}.` };
}

/** Release a ticket (unassign). */
export async function unassignTicket(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:assign', { redirectTo: '/admin/tickets' });
  const id = String(formData.get('ticketId') ?? '');
  if (!id) return { ok: false, message: 'Missing ticket id.' };
  const t = await prisma.supportTicket.findUnique({ where: { id }, select: { ref: true } });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  await prisma.supportTicket.update({ where: { id }, data: { assignedToId: null } });
  await audit('ticket.unassign', t.ref, session.user.email);
  revalidatePath('/admin/tickets');
  revalidatePath(`/admin/tickets/${id}`);
  return { ok: true, message: 'Released.' };
}

/** Operator-set linked commerce (when auto-detection misses or is wrong). */
export async function linkTicketToOrder(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:status', { redirectTo: '/admin/tickets' });
  const id = String(formData.get('ticketId') ?? '');
  const orderNumber = String(formData.get('orderNumber') ?? '').trim().toUpperCase();
  if (!id) return { ok: false, message: 'Missing ticket id.' };
  const t = await prisma.supportTicket.findUnique({ where: { id }, select: { ref: true } });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  if (!orderNumber) {
    await prisma.supportTicket.update({ where: { id }, data: { orderId: null } });
    await audit('ticket.unlink.order', t.ref, session.user.email);
    revalidatePath(`/admin/tickets/${id}`);
    return { ok: true, message: 'Order unlinked.' };
  }
  const o = await prisma.order.findUnique({ where: { orderNumber }, select: { id: true } });
  if (!o) return { ok: false, message: `Order ${orderNumber} not found.` };
  await prisma.supportTicket.update({ where: { id }, data: { orderId: o.id } });
  await audit('ticket.link.order', t.ref, `${orderNumber} by ${session.user.email}`);
  revalidatePath(`/admin/tickets/${id}`);
  return { ok: true, message: `Linked to ${orderNumber}.` };
}

// ────────────────────────────────────────────────────────────────────────────
//   Archive / restore / hard-delete (mirrors the Orders pattern)
// ────────────────────────────────────────────────────────────────────────────

export async function archiveTicket(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:archive', { redirectTo: '/admin/tickets' });
  const id = String(formData.get('ticketId') ?? '');
  if (!id) return { ok: false, message: 'Missing ticket id.' };
  const t = await prisma.supportTicket.findUnique({ where: { id }, select: { ref: true, archivedAt: true } });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  if (t.archivedAt) return { ok: false, message: 'Already archived.' };
  await prisma.supportTicket.update({
    where: { id },
    data: { archivedAt: new Date(), archivedById: session.user.id },
  });
  await audit('ticket.archive', t.ref, session.user.email);
  revalidatePath('/admin/tickets');
  return { ok: true, message: 'Archived.' };
}

export async function unarchiveTicket(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:archive', { redirectTo: '/admin/tickets' });
  const id = String(formData.get('ticketId') ?? '');
  if (!id) return { ok: false, message: 'Missing ticket id.' };
  const t = await prisma.supportTicket.findUnique({ where: { id }, select: { ref: true, archivedAt: true } });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  if (!t.archivedAt) return { ok: false, message: 'Not archived.' };
  await prisma.supportTicket.update({ where: { id }, data: { archivedAt: null, archivedById: null } });
  await audit('ticket.unarchive', t.ref, session.user.email);
  revalidatePath('/admin/tickets');
  return { ok: true, message: 'Restored.' };
}

export async function bulkArchiveTickets(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:archive', { redirectTo: '/admin/tickets' });
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No tickets selected.' };
  const targets = await prisma.supportTicket.findMany({
    where: { id: { in: ids }, archivedAt: null },
    select: { id: true, ref: true },
  });
  if (targets.length === 0) return { ok: false, count: 0, message: 'None of the selected tickets are unarchived.' };
  await prisma.supportTicket.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { archivedAt: new Date(), archivedById: session.user.id },
  });
  await audit('ticket.bulkarchive', undefined, `${targets.length} tickets by ${session.user.email}`);
  revalidatePath('/admin/tickets');
  return { ok: true, count: targets.length, message: `Archived ${targets.length} ticket${targets.length === 1 ? '' : 's'}.` };
}

export async function bulkUnarchiveTickets(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:archive', { redirectTo: '/admin/tickets' });
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No tickets selected.' };
  const targets = await prisma.supportTicket.findMany({
    where: { id: { in: ids }, archivedAt: { not: null } },
    select: { id: true, ref: true },
  });
  if (targets.length === 0) return { ok: false, count: 0, message: 'None of the selected tickets are archived.' };
  await prisma.supportTicket.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { archivedAt: null, archivedById: null },
  });
  await audit('ticket.bulkunarchive', undefined, `${targets.length} tickets by ${session.user.email}`);
  revalidatePath('/admin/tickets');
  return { ok: true, count: targets.length, message: `Restored ${targets.length} ticket${targets.length === 1 ? '' : 's'}.` };
}

/** Archive-first guard, like deleteOrderPermanently. Audit snapshot is the
 *  forensic trail when the row is gone. */
export async function deleteTicketPermanently(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:delete', { redirectTo: '/admin/tickets' });
  const id = String(formData.get('ticketId') ?? '');
  if (!id) return { ok: false, message: 'Missing ticket id.' };
  const t = await prisma.supportTicket.findUnique({
    where: { id },
    select: {
      ref: true, subject: true, name: true, email: true,
      status: true, priority: true, archivedAt: true,
      _count: { select: { messages: true } },
    },
  });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  if (!t.archivedAt) return { ok: false, message: 'Archive the ticket first, then delete.' };
  const snap = { ref: t.ref, subject: t.subject, name: t.name, email: t.email, status: t.status, priority: t.priority, msgs: t._count.messages };
  await audit('ticket.delete.permanent', t.ref, JSON.stringify(snap).slice(0, 480));
  await prisma.supportTicket.delete({ where: { id } }); // messages cascade
  revalidatePath('/admin/tickets');
  return { ok: true, message: `Ticket ${t.ref} permanently deleted.` };
}

export async function bulkDeleteTickets(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:delete', { redirectTo: '/admin/tickets' });
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No tickets selected.' };
  const targets = await prisma.supportTicket.findMany({
    where: { id: { in: ids }, archivedAt: { not: null } },
    select: { id: true, ref: true, name: true, email: true, status: true, priority: true },
  });
  if (targets.length === 0) {
    return { ok: false, count: 0, message: 'None of the selected tickets are archived. Archive them first.' };
  }
  for (const t of targets) {
    await audit('ticket.delete.permanent', t.ref, `bulk · ${t.email} · ${t.status} · ${t.priority}`);
  }
  await prisma.supportTicket.deleteMany({ where: { id: { in: targets.map((t) => t.id) } } });
  revalidatePath('/admin/tickets');
  return { ok: true, count: targets.length, message: `Deleted ${targets.length} ticket${targets.length === 1 ? '' : 's'}.` };
}

/** Legacy hard-delete kept for back-compat (any callers still using
 *  deleteTicket get the new safer flow). */
export async function deleteTicket(formData: FormData) {
  return archiveTicket(formData);
}

// ────────────────────────────────────────────────────────────────────────────
//   Magic-link reissue (admin-only, GUEST tickets)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Rotate the magic-link accessToken for a GUEST ticket. Use cases:
 *   - Customer says "I lost the link / it expired"
 *   - Operator suspects the link was forwarded and wants to invalidate it
 *
 * Sends the new link by email. Old token becomes immediately unusable (the
 * unique-by-accessToken lookup will miss it).
 */
export async function reissueGuestMagicLink(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:reply', { redirectTo: '/admin/tickets' });
  await ensureSettingsLoaded();
  const id = String(formData.get('ticketId') ?? '');
  if (!id) return { ok: false, message: 'Missing ticket id.' };
  const t = await prisma.supportTicket.findUnique({
    where: { id },
    select: { id: true, ref: true, name: true, email: true, subject: true, customerType: true },
  });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  if (t.customerType !== 'GUEST') {
    return { ok: false, message: 'Only GUEST tickets have magic links.' };
  }

  const now = new Date();
  const newToken = makeAccessToken();
  await prisma.supportTicket.update({
    where: { id },
    data: {
      accessToken: newToken,
      accessTokenIssuedAt: now,
      accessTokenExpiresAt: tokenExpiry(now),
    },
  });

  const site = process.env.SITE_NAME || 'lab2date';
  const href = `${process.env.BETTER_AUTH_URL ?? ''}/support/t/${newToken}`;
  await sendEmail({
    to: t.email,
    subject: `[${t.ref}] New link to view your ticket`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:560px;">
        <h2 style="color:#0E4F40;">Here&rsquo;s a fresh link, ${t.name}</h2>
        <p>Your support team rotated the access link on ticket <strong>${t.ref}</strong>. Any previous link no longer works.</p>
        <p style="margin:18px 0;">
          <a href="${href}" style="background:#0E4F40;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
            View ticket ${t.ref}
          </a>
        </p>
        <p style="color:#888;font-size:11px;">This link is valid for 14 days. Keep it private.</p>
        <p style="color:#888;font-size:12px;">${site}</p>
      </div>`,
  });

  await audit('ticket.magiclink.reissue', t.ref, `by ${session.user.email}`);
  revalidatePath(`/admin/tickets/${id}`);
  return { ok: true, message: `New link emailed to ${t.email}.` };
}
