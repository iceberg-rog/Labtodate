'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { audit, notifyAdmins } from '@/lib/observability';
import { sendEmail } from '@/lib/email';

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
 * Guest reply via magic-link token on a SourcingRequest. Mirrors
 * SupportTicket's guestReplyByToken: no session needed, but token must be
 * present + unexpired.
 */
export async function guestReplyByQuoteToken(formData: FormData): Promise<void> {
  await ensureSettingsLoaded();
  const token = String(formData.get('token') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const attachments = parseAttachments(formData.get('attachments'));
  if (!token || (body.length < 1 && attachments.length === 0)) return;

  const sr = await prisma.sourcingRequest.findUnique({ where: { accessToken: token } });
  if (!sr) redirect('/let-us-find-it');
  // Expired → redirect to the page (which renders the expired UI).
  if (sr.accessTokenExpiresAt && sr.accessTokenExpiresAt.getTime() <= Date.now()) {
    redirect(`/quotes/t/${token}`);
  }
  if (sr.status === 'CLOSED' || sr.status === 'DECLINED') {
    redirect(`/quotes/t/${token}?err=closed`);
  }

  const now = new Date();
  const ref = sr.proformaNumber ?? `RFQ-${sr.id.slice(-6).toUpperCase()}`;

  await prisma.quoteMessage.create({
    data: {
      sourcingRequestId: sr.id,
      authorId: null,
      body: body.slice(0, 5000),
      attachments,
      fromStaff: false,
      isInternalNote: false,
    },
  });
  await prisma.sourcingRequest.update({
    where: { id: sr.id },
    data: {
      // Buyer replied → we owe them; mirror SupportTicket WAITING_ON_SUPPORT
      // semantics by flipping PENDING/RESPONDED to PENDING when the buyer
      // adds new context (status remains otherwise).
      lastReplyAt: now,
      lastReplyByStaff: false,
    },
  });

  const ops = process.env.SUPPORT_INTAKE_EMAIL || process.env.SUPPORT_EMAIL || process.env.COMPANY_EMAIL || 'support@lab2date.com';
  await sendEmail({
    to: ops,
    subject: `[${ref}] Guest reply on a quote`,
    html: `<p>${sr.buyerName} (${sr.buyerEmail}) replied to quote ${ref}:</p><blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${body.replace(/\n/g, '<br>')}</blockquote>`,
  });
  await notifyAdmins(
    `Guest replied on quote · ${ref}`,
    `${sr.buyerName} replied via magic link.`,
    `/admin/quotes/${sr.id}`,
  );
  await audit('quote.guest.reply', ref, `${sr.buyerEmail}${attachments.length ? ` +${attachments.length}attach` : ''}`);

  revalidatePath(`/admin/quotes/${sr.id}`);
  revalidatePath(`/quotes/t/${token}`);
  redirect(`/quotes/t/${token}?ok=1`);
}
