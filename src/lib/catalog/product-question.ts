'use server';

/**
 * A buyer's question about a listing that lab2date sells as the seller of
 * record (imported supplier items: the supplier is hidden and its importer
 * account has no real inbox). It becomes a SUPPORT TICKET linked to the
 * product — a question to lab2date, not a quote request: no RFQ stages, no
 * "supplier" wording. "Request photos" is the same with its own subject.
 * The buyer follows it under Account → Support and gets replies by email.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth-server';
import { sendInternalEmail, trySendEmail } from '@/lib/email';
import { escapeHtml, escapeHtmlLines, headerText } from '@/lib/email-html';
import { rateLimit } from '@/lib/ratelimit';
import { notifyAdmins, audit } from '@/lib/observability';
import { withUniqueTicketRef } from '@/lib/support/actions';
import { computeDueAt } from '@/lib/support/statuses';
import { getCatalogPolicy } from '@/lib/catalog/policy';

export type ProductQuestionKind = 'QUESTION' | 'PHOTOS';

export async function askAboutProduct(input: { productSlug: string; message: string; kind: ProductQuestionKind }): Promise<{ error: string }> {
  const slug = String(input?.productSlug ?? '').slice(0, 200);
  const kind: ProductQuestionKind = input?.kind === 'PHOTOS' ? 'PHOTOS' : 'QUESTION';
  const session = await requireSession({ redirectTo: `/marketplace/${encodeURIComponent(slug)}` });
  const policy = await getCatalogPolicy();
  const message = String(input?.message ?? '').replace(/\r\n/g, '\n').trim();
  const min = policy.productQuestionMinChars;
  if (message.length < min || message.length > 4000) {
    return { error: `Write ${min}–4,000 characters.` };
  }
  const product = await prisma.product.findUnique({ where: { slug }, select: { id: true, slug: true, title: true, status: true } });
  if (!product || product.status !== 'PUBLISHED') return { error: 'This listing is no longer available.' };
  try {
    await rateLimit('product-question', 10, 10 * 60_000);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Too many questions — please wait a few minutes.' };
  }

  const seller = policy.sellerLegalName;
  const subject = headerText(`${kind === 'PHOTOS' ? 'Photo request' : 'Question'}: ${product.title}`, 160);
  const category = kind === 'PHOTOS' ? 'Photo request' : 'Product question';
  const now = new Date();
  const name = (session.user.name || session.user.email.split('@')[0] || 'Buyer').slice(0, 120);
  let ref: string;
  let ticketId: string;
  try {
    const t = await withUniqueTicketRef((r) =>
      prisma.supportTicket.create({
        data: {
          ref: r,
          name,
          email: session.user.email,
          subject,
          category,
          submittedById: session.user.id,
          priority: 'NORMAL',
          dueAt: computeDueAt(now, 'NORMAL'),
          customerType: 'REGISTERED',
          productId: product.id,
          lastReplyAt: now,
          lastReplyByStaff: false,
          status: 'WAITING_ON_SUPPORT',
          messages: { create: { fromStaff: false, authorId: session.user.id, body: message } },
        },
        select: { id: true, ref: true },
      }),
    );
    ref = t.ref;
    ticketId = t.id;
  } catch (e) {
    console.error('[product-question] create failed', e);
    return { error: 'Your message was not sent. Please try again in a minute.' };
  }

  const site = (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
  const productUrl = `${site}/marketplace/${product.slug}`;
  // Saved: emails are reported / logged, never thrown (no duplicate tickets).
  await trySendEmail({
    to: session.user.email,
    subject: `[${ref}] We received your ${kind === 'PHOTOS' ? 'photo request' : 'question'}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px;">
<h2 style="color:#0E4F40;">Thank you, ${escapeHtml(name)}</h2>
<p>Your ${kind === 'PHOTOS' ? 'request for photos of' : 'question about'} <a href="${productUrl}">${escapeHtml(product.title)}</a> is with the ${escapeHtml(seller)} team. We reply by email; you can also follow it under Support in your account.</p>
<p><strong>Reference:</strong> ${ref}</p>
<blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${escapeHtmlLines(message)}</blockquote>
<p style="margin:18px 0;"><a href="${site}/app/support" style="background:#0E4F40;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Open Support</a></p>
<p style="color:#888;font-size:12px;">${escapeHtml(seller)}</p>
</div>`,
  }, 'product-question:ack');
  const ops = process.env.SUPPORT_INTAKE_EMAIL || process.env.SUPPORT_EMAIL || process.env.COMPANY_EMAIL || '';
  await sendInternalEmail({
    to: ops,
    subject: `${category} ${ref}: ${headerText(product.title, 140)}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:600px;">
<h2 style="color:#0E4F40;">${escapeHtml(category)}</h2>
<p>From <strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(session.user.email)}&gt; about <a href="${productUrl}">${escapeHtml(product.title)}</a></p>
<blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${escapeHtmlLines(message)}</blockquote>
<p><a href="${site}/admin/tickets/${ticketId}">Answer it in Admin → Tickets</a> · Ref ${ref}</p>
</div>`,
  }, 'product-question:intake');
  await prisma.notification.create({
    data: {
      userId: session.user.id,
      title: `${kind === 'PHOTOS' ? 'Photo request' : 'Question'} ${ref} sent`,
      body: `About “${product.title.slice(0, 120)}”. We reply by email and under Support.`,
      href: `/app/support?sent=${ref}`,
      kind: 'SYSTEM',
    },
  }).catch(() => null);
  await notifyAdmins(`${category} ${ref}`, `${name}: ${product.title.slice(0, 120)}`, `/admin/tickets/${ticketId}`, 'TICKET_NEW');
  await audit('product.question', product.slug, `ticket=${ref} kind=${kind}`);
  revalidatePath('/admin/tickets');
  revalidatePath('/app/support');
  redirect(`/app/support?sent=${encodeURIComponent(ref)}`);
}
