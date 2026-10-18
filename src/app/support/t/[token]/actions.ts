'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { audit } from '@/lib/observability';
import { trySendEmail } from '@/lib/email';
import { linkRotationData, parseAttachmentList, maskEmail } from '@/lib/support/rules';
import { magicLinkExpiry, replyRateLimit, supportLimit, SupportLimitError, ticketRateLimit } from '@/lib/support/policy';
import { customerReplyRefusal, makeAccessToken, recordCustomerReply, ticketLink } from '@/lib/support/tickets';
import { freshLinkMail } from '@/lib/support/mail';

/**
 * Guest reply via magic-link token. Mirrors customerReplyTicket but uses the
 * URL token instead of a session for auth. No account creation needed.
 * Problems come back as a readable `error` so the reply box keeps the text.
 */
export async function guestReplyByToken(formData: FormData): Promise<{ error?: string; notice?: string }> {
  await ensureSettingsLoaded();
  const token = String(formData.get('token') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const { urls, names } = parseAttachmentList(formData.get('attachments'), formData.get('attachmentNames'));
  if (!token || (body.length < 1 && urls.length === 0)) return { error: 'Write a message or attach a file.' };

  const t = await prisma.supportTicket.findUnique({
    where: { accessToken: token },
  });
  if (!t) return { error: 'This link no longer works — use the newest link from our e-mails.' };
  // Token expiry — refuse the reply rather than silently dropping the input.
  if (t.accessTokenExpiresAt && t.accessTokenExpiresAt.getTime() <= Date.now()) {
    return { error: 'This link has expired. Copy your text, then reload the page to get a new link by e-mail.' };
  }
  // Spam never takes replies; resolved / closed reopen only within the
  // reopen period (Settings → Support).
  const refusal = customerReplyRefusal(t);
  if (refusal) return { error: refusal };
  try {
    await supportLimit(`ticket-reply:t:${t.id}`, replyRateLimit());
  } catch (e) {
    if (e instanceof SupportLimitError) return { error: e.message };
    throw e;
  }

  const { reopened } = await recordCustomerReply(t, {
    authorId: null,
    authorLabel: `${t.name} (${t.email})`,
    actor: t.email,
    body,
    urls,
    names,
    via: 'guest',
  });
  revalidatePath(`/support/t/${token}`);
  return { notice: reopened ? 'Reply sent — the ticket is open again and our team has been notified.' : 'Reply sent — we’ll respond shortly.' };
}

/**
 * "Send me a new link" on the expired-link page. The new private link goes
 * only to the ticket's own e-mail address, so holding an old link gives
 * nothing but a fresh e-mail to the owner. Limited per ticket like new
 * tickets (Settings → Support).
 */
export async function requestFreshTicketLink(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await ensureSettingsLoaded();
  const token = String(formData.get('token') ?? '');
  if (token.length < 16) return { ok: false, message: 'This link is not valid.' };
  const t = await prisma.supportTicket.findUnique({
    where: { accessToken: token },
    select: { id: true, ref: true, name: true, email: true, customerType: true, accessTokenExpiresAt: true, updatedAt: true },
  });
  if (!t || t.customerType !== 'GUEST') return { ok: false, message: 'This link is not valid.' };
  if (!t.accessTokenExpiresAt || t.accessTokenExpiresAt.getTime() > Date.now()) {
    return { ok: true, message: 'This link still works — reload the page.' };
  }
  try {
    await supportLimit(`ticket-link:${t.id}`, ticketRateLimit());
  } catch (e) {
    if (e instanceof SupportLimitError) return { ok: false, message: e.message };
    throw e;
  }

  // Send first, then switch the ticket to the new token: a failed send leaves
  // the old (expired) link in place so the guest can simply try again.
  const now = new Date();
  const newToken = makeAccessToken();
  const expiresAt = magicLinkExpiry(now);
  const sent = await trySendEmail({
    to: t.email,
    // Visitor-triggered: limited like the other e-mails a visitor can cause.
    trigger: 'form.support',
    subject: `[${t.ref}] New link to view your ticket`,
    html: freshLinkMail({
      ref: t.ref,
      name: t.name,
      href: ticketLink({ ref: t.ref, customerType: 'GUEST', accessToken: newToken }),
      byStaff: false,
      validUntil: expiresAt,
    }),
  }, 'support:magiclink-self');
  if (!sent.ok) {
    return { ok: false, message: 'We could not send the e-mail just now. Please try again in a few minutes.' };
  }
  // The new link must not move the reopen window (linkRotationData). Guarded
  // on updatedAt: if staff changed the ticket while the mail went out, the
  // window already counts from that moment, so a plain update is right.
  const link = { token: newToken, issuedAt: now, expiresAt };
  const kept = await prisma.supportTicket.updateMany({
    where: { id: t.id, updatedAt: t.updatedAt },
    data: linkRotationData(t, link),
  });
  if (kept.count === 0) {
    await prisma.supportTicket.update({
      where: { id: t.id },
      data: { accessToken: link.token, accessTokenIssuedAt: link.issuedAt, accessTokenExpiresAt: link.expiresAt },
    });
  }
  await audit('ticket.magiclink.self', t.ref, 'requested on the expired-link page');
  return { ok: true, message: `We e-mailed a new link to ${maskEmail(t.email)}. It may take a minute to arrive.` };
}
