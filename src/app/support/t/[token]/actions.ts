'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { audit, notifyAdmins } from '@/lib/observability';
import { sendTemplatedEmail } from '@/lib/email-templates/send';
import { siteLink } from '@/lib/email-templates/links';
import { intakeEmail } from '@/lib/intake';

function parseAttachments(v: FormDataEntryValue | null): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const arr = JSON.parse(v);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((u): u is string => typeof u === 'string')
      .filter((u) => u.startsWith('/api/support-attachment/'))
      .slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Guest reply via magic-link token. Mirrors customerReplyTicket but uses the
 * URL token instead of a session for auth. No account creation needed.
 */
export async function guestReplyByToken(formData: FormData): Promise<void> {
  await ensureSettingsLoaded();
  const token = String(formData.get('token') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const attachments = parseAttachments(formData.get('attachments'));
  if (!token || (body.length < 1 && attachments.length === 0)) return;

  const t = await prisma.supportTicket.findUnique({
    where: { accessToken: token },
  });
  if (!t) redirect('/support');
  // Token expiry — refuse the reply rather than silently dropping the input.
  if (t.accessTokenExpiresAt && t.accessTokenExpiresAt.getTime() <= Date.now()) {
    redirect(`/support/t/${token}`);
  }
  if (t.status === 'CLOSED' || t.status === 'SPAM') {
    redirect(`/support/t/${token}?err=closed`);
  }

  const now = new Date();
  await prisma.supportMessage.create({
    data: {
      ticketId: t.id,
      fromStaff: false,
      authorId: null,
      body: body.slice(0, 5000),
      attachments,
    },
  });
  await prisma.supportTicket.update({
    where: { id: t.id },
    data: {
      status: 'WAITING_ON_SUPPORT',
      lastReplyAt: now,
      lastReplyByStaff: false,
      // BUG-018 parity with customerReplyTicket: a customer reply must bring an
      // archived ticket back to the working queue, or the message is lost.
      archivedAt: null,
      archivedById: null,
    },
  });

  // Staff copy: only a configured inbox (skipped and logged otherwise).
  const ops = await intakeEmail('support', 'staff_ticket_guest_reply');
  if (ops) await sendTemplatedEmail({
    key: 'staff_ticket_guest_reply',
    to: ops,
    lang: 'en',
    vars: {
      'ticket.number': t.ref,
      'ticket.subject': t.subject,
      'reply.author': t.name,
      'reply.author_email': t.email,
      'reply.body': body,
      'link.admin': siteLink(`/admin/tickets/${t.id}`),
    },
  });
  await notifyAdmins(
    `Guest replied · ${t.ref}`,
    `${t.name} replied via magic link on "${t.subject}"`,
    `/admin/tickets/${t.id}`,
    'TICKET_NEW',
  );
  await audit('ticket.guest.reply', t.ref, `${t.email}${attachments.length ? ` +${attachments.length}attach` : ''}`);

  revalidatePath(`/admin/tickets/${t.id}`);
  revalidatePath(`/support/t/${token}`);
  redirect(`/support/t/${token}?ok=1`);
}
