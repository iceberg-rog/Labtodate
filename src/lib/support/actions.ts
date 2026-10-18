'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession, requireSession, requireCapability } from '@/lib/auth-server';
import { sendInternalEmail, trySendEmail } from '@/lib/email';
import { escapeHtml, escapeHtmlLines, headerText } from '@/lib/email-html';
import { ensureSettingsLoaded } from '@/lib/settings';
import { clientIp } from '@/lib/ratelimit';
import { notifyAdmins, notifyUser, audit } from '@/lib/observability';
import { siteName } from '@/lib/brand/identity';
import { guardPublicForm, PublicFormError } from '@/lib/security/captcha';
import { initialPriority, isAwaitingSupport, linkRotationData, parseAttachmentList } from '@/lib/support/rules';
import {
  computeTicketDueAt,
  highKeywords,
  magicLinkExpiry,
  matchTopic,
  reopenDays,
  replyRateLimit,
  supportDate,
  supportLimit,
  SupportLimitError,
  ticketRateLimit,
  unpaidOrderHighAfterHours,
  urgentKeywords,
  vipLifetimeCents,
} from '@/lib/support/policy';
import {
  customerReplyRefusal,
  detectOwnedCommerce,
  findCustomerOrder,
  makeAccessToken,
  orderBelongsTo,
  recordCustomerReply,
  renewGuestLink,
  ticketAppPath,
  ticketLink,
} from '@/lib/support/tickets';
import { freshLinkMail, staffReplyMail, ticketReceivedMail, ticketStatusMail } from '@/lib/support/mail';

// ────────────────────────────────────────────────────────────────────────────
//   Slice A helpers — priority + SLA + linked-commerce auto-detection
// ────────────────────────────────────────────────────────────────────────────

// SLA hours, business hours, VIP threshold, keywords and periods: Settings →
// Support (src/lib/support/settings-defs.ts, read through ./policy.ts).

/**
 * Initial priority of a brand-new ticket (rules: initialPriority in ./rules):
 * VIP customer (paid lifetime value ≥ the threshold), urgent words, high
 * words, a linked order unpaid for longer than the threshold, else NORMAL.
 */
async function computeInitialPriority(opts: {
  text: string;
  submittedById: string | null;
  linkedOrderId: string | null;
}): Promise<string> {
  const vip = vipLifetimeCents();
  let lifetimeCents = 0;
  if (opts.submittedById && vip > 0) {
    const agg = await prisma.order.aggregate({
      where: {
        buyerId: opts.submittedById,
        status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
      },
      _sum: { totalCents: true },
    });
    lifetimeCents = agg._sum.totalCents ?? 0;
  }
  let unpaidOrderAgeHours: number | null = null;
  if (opts.linkedOrderId) {
    const o = await prisma.order.findUnique({
      where: { id: opts.linkedOrderId },
      select: { status: true, createdAt: true },
    });
    if (o?.status === 'PENDING_PAYMENT') unpaidOrderAgeHours = (Date.now() - o.createdAt.getTime()) / 3600e3;
  }
  return initialPriority({
    text: opts.text,
    lifetimeCents,
    vipThresholdCents: vip,
    urgentWords: urgentKeywords(),
    highWords: highKeywords(),
    unpaidOrderAgeHours,
    unpaidHighAfterHours: unpaidOrderHighAfterHours(),
  });
}

const TicketInput = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  subject: z.string().min(3).max(160),
  category: z.string().max(60).optional().nullable(),
  body: z.string().min(10).max(5000),
  /** Order the ticket is about — signed-in customers pick one of their own. */
  orderNumber: z.string().max(40).optional().nullable(),
  /** Proxied upload URLs (/api/attachment-upload) and their original names. */
  attachments: z.array(z.string().max(400)).max(5).optional(),
  attachmentNames: z.array(z.string().max(400)).max(5).optional(),
  hp: z.string().optional(),
  /** Solved bot check (Settings → Security; guests by default). */
  captcha: z.string().max(8000).optional(),
});

/** A form problem the customer can fix; the message is shown as is. */
class TicketFormError extends Error {}

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

const TICKET_FIELD_LIMITS: Record<string, string> = {
  name: 'Your name must be 2–120 characters.',
  email: 'Please enter a valid email address.',
  subject: 'The subject must be 3–160 characters.',
  category: 'Please pick a topic from the list.',
  body: 'Your message must be 10–5,000 characters.',
  orderNumber: 'Please pick an order from the list.',
  attachments: 'You can attach up to 5 files.',
  attachmentNames: 'You can attach up to 5 files.',
};

export async function submitTicket(input: z.infer<typeof TicketInput>) {
  const session = await getServerSession();
  // Signed in: the ticket belongs to the account — its own name and verified
  // e-mail, whatever the browser sent (staff replies go to that address).
  const accountName = (session?.user.name ?? '').trim();
  const p = TicketInput.parse(
    session
      ? { ...input, name: (accountName.length >= 2 ? accountName : session.user.email).slice(0, 120), email: session.user.email }
      : input,
  );
  if (p.hp && p.hp.trim()) return { ref: 'TKT-OK', accessToken: null, mailed: true }; // honeypot: silently drop bots
  // Bot check (guests) and blocked / throw-away domains: the form echoes a
  // confirmation to whatever address is typed here.
  await guardPublicForm('support', { captcha: p.captcha, email: p.email }, !!session);
  await ensureSettingsLoaded();
  // Per account when signed in (a lab behind one address must not lock out
  // its colleagues), else per network address. Settings → Support.
  await supportLimit(session ? `ticket:u:${session.user.id}` : `ticket:${await clientIp()}`, ticketRateLimit());

  // Topics are the configured list only (Settings → Support).
  const category = p.category ? matchTopic(p.category) : null;
  if (p.category && !category) throw new TicketFormError(TICKET_FIELD_LIMITS.category);
  const customer = { userId: session?.user.id ?? null, email: p.email };
  // An order picked on the form must be the customer's own; numbers typed in
  // the text are linked only when they are (never another customer's order).
  let linked: { orderId: string | null; sourcingRequestId: string | null };
  if (p.orderNumber?.trim() && session) {
    const own = await findCustomerOrder(p.orderNumber, customer);
    if (!own) throw new TicketFormError('That order is not in your account — pick one from the list or leave it empty.');
    linked = { orderId: own.id, sourcingRequestId: null };
  } else {
    linked = await detectOwnedCommerce(`${p.subject} ${p.body}`, customer);
  }
  const { urls: attachments, names: attachmentNames } = parseAttachmentList(p.attachments ?? [], p.attachmentNames ?? []);

  // Priority runs BEFORE the insert so dueAt is right on disk.
  const priority = await computeInitialPriority({
    text: `${p.subject} ${p.body}`,
    submittedById: customer.userId,
    linkedOrderId: linked.orderId,
  });
  const now = new Date();
  const dueAt = computeTicketDueAt(now, priority);
  const customerType = session?.user.id ? 'REGISTERED' : 'GUEST';
  const accessToken = customerType === 'GUEST' ? makeAccessToken() : null;
  const accessTokenIssuedAt = accessToken ? now : null;
  const accessTokenExpiresAt = accessToken ? magicLinkExpiry(now) : null;

  const ticket = await withUniqueTicketRef((r) =>
    prisma.supportTicket.create({
      data: {
        ref: r,
        name: p.name,
        email: p.email,
        subject: p.subject,
        category,
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
        messages: {
          create: { fromStaff: false, authorId: session?.user.id ?? null, body: p.body, attachments, attachmentNames },
        },
      },
    }),
  );

  // GUEST tickets get their private link so the customer can follow up
  // without creating an account; REGISTERED tickets open in the account.
  const followUpHref = ticketLink({ ref: ticket.ref, customerType, accessToken });
  // The acknowledgement goes to whatever address was typed into the form. Echo
  // the ticket's name/subject/body only when that is the signed-in user's own
  // (verified) address — otherwise anyone could use this form to make
  // us send their own text to any inbox. The team copy below has it all.
  const echo = !!session && p.email.trim().toLowerCase() === session.user.email.trim().toLowerCase();
  // The ticket is saved: emails below are reported/logged, never thrown (a
  // thrown error here made customers resubmit and create duplicate tickets).
  const ack = await trySendEmail({
    to: p.email,
    // Anyone can type any address here: limited like the other e-mails a
    // visitor can trigger, unless it is the signed-in account's own address.
    trigger: echo ? 'transactional' : 'form.support',
    subject: `[${ticket.ref}] We received your request`,
    html: ticketReceivedMail({
      ref: ticket.ref, name: p.name, subject: p.subject, body: p.body, echo,
      guest: !!accessToken, href: followUpHref, attachments: attachments.length,
    }),
  }, 'support:ack');

  const ops =
    process.env.SUPPORT_INTAKE_EMAIL ||
    process.env.SUPPORT_EMAIL ||
    process.env.COMPANY_EMAIL ||
    '';
  await sendInternalEmail({
    to: ops,
    subject: `New support ticket ${ticket.ref}: ${headerText(p.subject, 160)}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:600px;">
        <h2 style="color:#0E4F40;">New support ticket</h2>
        <p>From <strong>${escapeHtml(p.name)}</strong> &lt;${escapeHtml(p.email)}&gt;${category ? ` · ${escapeHtml(category)}` : ''}</p>
        <p><strong>${escapeHtml(p.subject)}</strong></p>
        <blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${escapeHtmlLines(p.body)}</blockquote>
        ${attachments.length ? `<p style="color:#888;">+ ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}</p>` : ''}
        <p style="color:#888;font-size:12px;">Ref ${ticket.ref}${ack.ok ? '' : ' · the confirmation e-mail to the customer could not be sent'}</p>
      </div>`,
  }, 'support:intake');

  if (session?.user.id) {
    await notifyUser(
      session.user.id,
      `Ticket ${ticket.ref} received`,
      `We logged your request: "${p.subject}". Track it and reply under Support.`,
      ticketAppPath(ticket.ref),
    );
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

  await audit('ticket.create', ticket.ref, `priority=${priority} type=${customerType}${linked.orderId ? ` orderId=${linked.orderId}` : ''}${linked.sourcingRequestId ? ` rfqId=${linked.sourcingRequestId}` : ''}${attachments.length ? ` +${attachments.length}attach` : ''}${ack.ok ? '' : ' ack-not-sent'}`);

  revalidatePath('/admin/tickets');
  revalidatePath('/app/notifications');
  return { ref: ticket.ref, accessToken, mailed: ack.ok };
}

/**
 * Form entry point. Validation and rate-limit failures come back as a readable
 * `error`: production builds replace thrown messages with a generic "Server
 * Components render" error, so the customer could not tell what to fix. The
 * form keeps what was typed. When the confirmation e-mail could not be sent
 * the thanks page says so (mail=0) instead of promising a link.
 */
export async function submitTicketAndRedirect(input: z.infer<typeof TicketInput>): Promise<{ error: string; captcha?: boolean }> {
  let r: string;
  let mailed: boolean;
  try {
    ({ ref: r, mailed } = await submitTicket(input));
  } catch (e) {
    if (e instanceof PublicFormError) return { error: e.message, captcha: e.captcha };
    if (e instanceof SupportLimitError || e instanceof TicketFormError) return { error: e.message };
    if (e instanceof z.ZodError) {
      const field = String(e.issues[0]?.path[0] ?? '');
      return { error: TICKET_FIELD_LIMITS[field] ?? 'Some details are invalid. Please check the form and try again.' };
    }
    console.error('[support] submit failed', e);
    return { error: 'Something went wrong and your ticket was not sent. Please try again in a minute.' };
  }
  redirect(`/support/thanks?ref=${encodeURIComponent(r)}${mailed ? '' : '&mail=0'}`);
}

export async function replyTicket(formData: FormData): Promise<{ warning?: string; notice?: string } | undefined> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:reply', { redirectTo: '/admin/tickets' });
  await ensureSettingsLoaded();
  const ticketId = String(formData.get('ticketId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const { urls: attachments, names: attachmentNames } = parseAttachmentList(formData.get('attachments'), formData.get('attachmentNames'));
  // Internal notes are admin-only — they're stored on the same SupportMessage
  // table with isInternalNote=true and NEVER emailed to the customer.
  const isInternalNote = String(formData.get('internal') ?? '') === '1';
  if (!ticketId || (body.length < 1 && attachments.length === 0)) return { warning: 'Write a message or attach a file.' };

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
      attachmentNames,
      isInternalNote,
    },
  });

  // Internal notes don't shift state — they're commentary the customer never
  // sees. A reply to the customer hands the ball over: WAITING_ON_CUSTOMER,
  // the SLA clock stops (it restarts on the customer's answer), and a reply
  // on a resolved / closed / archived ticket reopens the conversation so the
  // customer can actually answer the question.
  const wasClosed = t.status === 'RESOLVED' || t.status === 'CLOSED' || t.status === 'SPAM' || !!t.archivedAt;
  if (!isInternalNote) {
    await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: 'WAITING_ON_CUSTOMER',
        lastReplyAt: now,
        lastReplyByStaff: true,
        dueAt: null,
        slaBreachAt: null,
        archivedAt: null,
        archivedById: null,
      },
    });
  }

  // Email — only on customer-facing replies. Internal notes stay in the
  // admin UI. Replies to the e-mail are not threaded into the ticket yet, so
  // the mail sends the customer to the ticket page; a guest's private link is
  // renewed with every reply so an active case never locks them out.
  let warning: string | undefined;
  if (!isInternalNote) {
    const link = await renewGuestLink(t);
    const sent = await trySendEmail({
      to: t.email,
      subject: `[${t.ref}] Reply from ${siteName()} support`,
      html: staffReplyMail({
        ref: t.ref,
        subject: t.subject,
        body,
        attachments: attachments.length,
        href: ticketLink({ ref: t.ref, customerType: t.customerType, accessToken: link.token }),
        linkValidUntil: t.customerType === 'GUEST' ? link.expiresAt : null,
      }),
    }, 'support:reply');
    if (!sent.ok) warning = `Reply saved and visible in the customer's ticket, but the email to ${t.email} could not be delivered (${sent.error}).`;

    await notifyUser(
      t.submittedById,
      `Support replied · ${t.ref}`,
      `New reply on "${t.subject}". Open the ticket to read and respond.`,
      ticketAppPath(t.ref),
    );
    if (wasClosed) await audit('ticket.reopen', t.ref, `by staff reply (was ${t.status}${t.archivedAt ? ', archived' : ''}) ${session.user.email}`);
  }

  await audit(isInternalNote ? 'ticket.note.add' : 'ticket.reply', t.ref, `${session.user.email}${attachments.length ? ` +${attachments.length}attach` : ''}`);

  revalidatePath('/admin/tickets');
  revalidatePath(`/admin/tickets/${ticketId}`);
  revalidatePath('/app/notifications');
  revalidatePath('/app/support');
  if (warning) return { warning };
  return !isInternalNote && wasClosed ? { notice: 'Sent. The ticket was reopened and now waits on the customer.' } : undefined;
}

/** A signed-in customer's reply on their own ticket (/app/support). */
export async function customerReplyTicket(formData: FormData): Promise<{ error?: string; notice?: string }> {
  const session = await requireSession({ redirectTo: '/app/support' });
  await ensureSettingsLoaded();
  const ticketId = String(formData.get('ticketId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const { urls, names } = parseAttachmentList(formData.get('attachments'), formData.get('attachmentNames'));
  if (!ticketId || (body.length < 1 && urls.length === 0)) return { error: 'Write a message or attach a file.' };

  const t = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  const own = !!t && (t.submittedById === session.user.id || t.email.trim().toLowerCase() === session.user.email.trim().toLowerCase());
  if (!t || !own) return { error: 'Ticket not found.' };
  // Spam never takes replies; resolved / closed reopen only within the
  // reopen period (Settings → Support).
  const refusal = customerReplyRefusal(t);
  if (refusal) return { error: refusal };
  try {
    await supportLimit(`ticket-reply:u:${session.user.id}`, replyRateLimit());
  } catch (e) {
    if (e instanceof SupportLimitError) return { error: e.message };
    throw e;
  }

  const { reopened } = await recordCustomerReply(t, {
    authorId: session.user.id,
    authorLabel: session.user.name || session.user.email,
    actor: session.user.email,
    body,
    urls,
    names,
    via: 'account',
  });
  return { notice: reopened ? 'Sent — the ticket is open again and our team has been notified.' : 'Sent.' };
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
  await ensureSettingsLoaded();
  const id = String(formData.get('ticketId') ?? '');
  const status = String(formData.get('status') ?? '') as AllowedStatus;
  if (!id || !ALLOWED_STATUSES.includes(status)) return { ok: false, message: 'Invalid status.' };
  const t = await prisma.supportTicket.findUnique({ where: { id } });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  const now = new Date();
  // Auto-archive on CLOSED — keeps the active queue lean. CLOSED tickets stay
  // restorable from the archive view; nothing is deleted.
  const shouldAutoArchive = status === 'CLOSED' && !t.archivedAt;
  // Reopening (any status but CLOSED / SPAM) brings an archived ticket back to
  // the working queue — a reopened case must not stay hidden in Archived.
  const shouldUnarchive = !!t.archivedAt && status !== 'CLOSED' && status !== 'SPAM';
  // SLA: entering "waiting on support" starts a fresh deadline (unless it was
  // already running); every other status stops the clock.
  const sla = isAwaitingSupport(status)
    ? (isAwaitingSupport(t.status) ? {} : { dueAt: computeTicketDueAt(now, t.priority), slaBreachAt: null })
    : { dueAt: null, slaBreachAt: null };
  const statusChanged = t.status !== status;
  // BUG-041: atomic compare-and-set; gate audit on the winning request so a
  // double-click / duplicate submit can't re-stamp archivedAt or double-audit.
  const claim = await prisma.supportTicket.updateMany({
    where: shouldAutoArchive
      ? { id, OR: [{ status: { not: status } }, { archivedAt: null }] }
      : { id, status: { not: status } },
    data: {
      status,
      ...sla,
      ...(shouldAutoArchive ? { archivedAt: now, archivedById: session.user.id } : {}),
      ...(shouldUnarchive ? { archivedAt: null, archivedById: null } : {}),
    },
  });
  const changed = claim.count === 1;
  if (changed && statusChanged) {
    await audit('ticket.status', t.ref, `${t.status} → ${status} by ${session.user.email}`);
  }
  if (changed && shouldAutoArchive) {
    await audit('ticket.archive', t.ref, `auto on CLOSE by ${session.user.email}`);
  }
  if (changed && shouldUnarchive) {
    await audit('ticket.unarchive', t.ref, `reopened (${t.status} → ${status}) by ${session.user.email}`);
  }

  // Tell the customer a ticket was resolved / closed and how to reopen it (not
  // again when a resolved ticket is closed later — they were told already).
  let told = '';
  const finished = (status === 'RESOLVED' || status === 'CLOSED') && statusChanged && changed;
  if (finished) {
    const reopenUntil = new Date(now.getTime() + reopenDays() * 86400e3);
    // A guest reopens through the private link: keep it valid that long.
    const link = await renewGuestLink(t, reopenUntil);
    if (!(status === 'CLOSED' && t.status === 'RESOLVED')) {
      const word = status === 'RESOLVED' ? 'resolved' : 'closed';
      const sent = await trySendEmail({
        to: t.email,
        subject: `[${t.ref}] Your request is ${word}`,
        html: ticketStatusMail({
          ref: t.ref,
          subject: t.subject,
          status,
          href: ticketLink({ ref: t.ref, customerType: t.customerType, accessToken: link.token }),
          reopenUntil,
        }),
      }, 'support:status');
      await notifyUser(
        t.submittedById,
        `Ticket ${t.ref} ${word}`,
        `"${t.subject}" — reply on the ticket by ${supportDate(reopenUntil)} to reopen it.`,
        ticketAppPath(t.ref),
      );
      told = sent.ok
        ? ` The customer was e-mailed and can reopen it until ${supportDate(reopenUntil)}.`
        : ` The e-mail to ${t.email} could not be delivered (${sent.error}).`;
    }
  }

  revalidatePath('/admin/tickets');
  revalidatePath(`/admin/tickets/${id}`);
  revalidatePath('/app/support');
  if (!changed) {
    return { ok: true, message: `Already ${status.toLowerCase().replace(/_/g, ' ')}.` };
  }
  return {
    ok: true,
    message: (shouldAutoArchive
      ? 'Closed and archived.'
      : `Status set to ${status.toLowerCase().replace(/_/g, ' ')}${shouldUnarchive ? ' and back in the queue' : ''}.`) + told,
  };
}

export async function setTicketPriority(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:status', { redirectTo: '/admin/tickets' });
  await ensureSettingsLoaded();
  const id = String(formData.get('ticketId') ?? '');
  const priority = String(formData.get('priority') ?? '') as AllowedPriority;
  if (!id || !ALLOWED_PRIORITIES.includes(priority)) return { ok: false, message: 'Invalid priority.' };
  const t = await prisma.supportTicket.findUnique({ where: { id }, select: { ref: true, priority: true, status: true } });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  // While the ticket waits on support, recompute dueAt from NOW + the new tier
  // (operator-set priority = a fresh SLA window — avoids "already overdue"
  // when an admin downgrades from URGENT to LOW after the original 2h
  // elapsed). Waiting on the customer or finished: no clock to move.
  const sla = isAwaitingSupport(t.status) ? { dueAt: computeTicketDueAt(new Date(), priority), slaBreachAt: null } : {};
  await prisma.supportTicket.update({
    where: { id },
    data: { priority, ...sla },
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

/**
 * Operator-set linked commerce (when auto-detection misses or is wrong). A
 * staff decision, so another customer's order can be linked on purpose (a
 * colleague writing about a company order) — but the reply says so.
 */
export async function linkTicketToOrder(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/tickets' });
  await requireCapability('tickets:status', { redirectTo: '/admin/tickets' });
  const id = String(formData.get('ticketId') ?? '');
  const orderNumber = String(formData.get('orderNumber') ?? '').trim().toUpperCase();
  if (!id) return { ok: false, message: 'Missing ticket id.' };
  const t = await prisma.supportTicket.findUnique({ where: { id }, select: { ref: true, email: true, submittedById: true } });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  if (!orderNumber) {
    await prisma.supportTicket.update({ where: { id }, data: { orderId: null } });
    await audit('ticket.unlink.order', t.ref, session.user.email);
    revalidatePath(`/admin/tickets/${id}`);
    return { ok: true, message: 'Order unlinked.' };
  }
  const o = await prisma.order.findUnique({
    where: { orderNumber },
    select: { id: true, buyerId: true, invoiceEmail: true, buyer: { select: { email: true } } },
  });
  if (!o) return { ok: false, message: `Order ${orderNumber} not found.` };
  const own = orderBelongsTo(o, { userId: t.submittedById, email: t.email });
  await prisma.supportTicket.update({ where: { id }, data: { orderId: o.id } });
  await audit('ticket.link.order', t.ref, `${orderNumber}${own ? '' : ' (another customer’s order)'} by ${session.user.email}`);
  revalidatePath(`/admin/tickets/${id}`);
  return {
    ok: true,
    message: own
      ? `Linked to ${orderNumber}.`
      : `Linked to ${orderNumber} — note: this order belongs to another customer, not to ${t.email}.`,
  };
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
 *   - Customer says "I lost the link / it expired" (they can also request one
 *     themselves on the expired-link page)
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
    select: { id: true, ref: true, name: true, email: true, subject: true, customerType: true, updatedAt: true },
  });
  if (!t) return { ok: false, message: 'Ticket not found.' };
  if (t.customerType !== 'GUEST') {
    return { ok: false, message: 'Only GUEST tickets have magic links.' };
  }

  const now = new Date();
  const newToken = makeAccessToken();
  const expiresAt = magicLinkExpiry(now);
  // A new link is not a ticket change: the reopen window stays where it was
  // (to reopen a closed ticket, change its status).
  await prisma.supportTicket.update({
    where: { id },
    data: linkRotationData(t, { token: newToken, issuedAt: now, expiresAt }),
  });

  const sent = await trySendEmail({
    to: t.email,
    subject: `[${t.ref}] New link to view your ticket`,
    html: freshLinkMail({
      ref: t.ref,
      name: t.name,
      href: ticketLink({ ref: t.ref, customerType: 'GUEST', accessToken: newToken }),
      byStaff: true,
      validUntil: expiresAt,
    }),
  }, 'support:magiclink');

  await audit('ticket.magiclink.reissue', t.ref, `by ${session.user.email}`);
  revalidatePath(`/admin/tickets/${id}`);
  return sent.ok
    ? { ok: true, message: `New link emailed to ${t.email}.` }
    : { ok: true, message: `New link created (the old one no longer works), but the email to ${t.email} could not be delivered (${sent.error}).` };
}
