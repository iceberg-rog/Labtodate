'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getServerSession, requireSession } from '@/lib/auth-server';
import { sendEmail } from '@/lib/email';
import { ensureSettingsLoaded } from '@/lib/settings';
import { rateLimit } from '@/lib/ratelimit';
import { audit, notifyAdmins, notifyUser } from '@/lib/observability';
import { notifyAndMaybeEmail } from '@/lib/notify-throttled';

const OPS_EMAIL_FALLBACK = 'acquisitions@lab2date.com';

const SellInput = z.object({
  sellerType: z.enum(['INDIVIDUAL', 'COMPANY']),
  contactName: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().max(40).optional().nullable(),
  companyName: z.string().max(180).optional().nullable(),
  country: z.string().max(80).optional().nullable(),

  itemTitle: z.string().min(3).max(200),
  brand: z.string().max(120).optional().nullable(),
  model: z.string().max(120).optional().nullable(),
  category: z.string().max(120).optional().nullable(),
  condition: z.enum(['NEW', 'REFURBISHED', 'USED']).default('USED'),
  yearMade: z.number().int().min(1900).max(2100).nullable().optional(),
  quantity: z.number().int().min(1).max(9999).default(1),
  askingPrice: z.string().max(120).optional().nullable(),
  location: z.string().max(160).optional().nullable(),
  description: z.string().min(20).max(5000),
  accessories: z.string().max(2000).optional().nullable(),
  reason: z.string().max(500).optional().nullable(),
  availability: z.string().max(160).optional().nullable(),
  photosUrl: z.string().url().max(500).optional().nullable().or(z.literal('')),
  images: z.array(z.string().url().max(500)).max(8).optional(),
});

export type SellInputType = z.input<typeof SellInput>;

const FIELD_LABELS: Record<string, string> = {
  contactName: 'Full name',
  email: 'Email',
  itemTitle: 'Item title',
  description: 'Description',
  yearMade: 'Year made',
  quantity: 'Quantity',
  photosUrl: 'Link to photos',
};

export type SellResult = { ok: true; id: string } | { ok: false; error: string };

export async function submitSellSubmission(input: SellInputType): Promise<SellResult> {
  await rateLimit('sell');
  await ensureSettingsLoaded();
  const OPS_EMAIL = process.env.SELL_INTAKE_EMAIL || OPS_EMAIL_FALLBACK;

  // Validate gracefully — a bad value (e.g. an invalid year) must show a
  // clear message, not crash the page with an opaque server error.
  const result = SellInput.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const key = String(issue?.path?.[0] ?? '');
    const field = FIELD_LABELS[key] ?? (key || 'A field');
    return { ok: false, error: `${field}: ${issue?.message ?? 'invalid value'}.` };
  }
  const parsed = result.data;
  const session = await getServerSession();

  const created = await prisma.sellSubmission.create({
    data: {
      sellerType: parsed.sellerType,
      contactName: parsed.contactName,
      email: parsed.email,
      phone: parsed.phone || null,
      companyName: parsed.companyName || null,
      country: parsed.country || null,
      itemTitle: parsed.itemTitle,
      brand: parsed.brand || null,
      model: parsed.model || null,
      category: parsed.category || null,
      condition: parsed.condition,
      yearMade: parsed.yearMade ?? null,
      quantity: parsed.quantity,
      askingPrice: parsed.askingPrice || null,
      location: parsed.location || null,
      description: parsed.description,
      accessories: parsed.accessories || null,
      reason: parsed.reason || null,
      availability: parsed.availability || null,
      photosUrl: parsed.photosUrl ? parsed.photosUrl : null,
      images: parsed.images ?? [],
      submittedById: session?.user.id ?? null,
    },
  });

  const summaryRows = [
    ['Item', parsed.itemTitle],
    ['Brand / model', [parsed.brand, parsed.model].filter(Boolean).join(' ') || '—'],
    ['Category', parsed.category || '—'],
    ['Condition', parsed.condition],
    ['Year', parsed.yearMade ? String(parsed.yearMade) : '—'],
    ['Quantity', String(parsed.quantity)],
    ['Asking price', parsed.askingPrice || 'Open to offers'],
    ['Location', parsed.location || '—'],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#888;">${k}</td><td style="padding:4px 0;"><strong>${v}</strong></td></tr>`,
    )
    .join('');

  // Emails are best-effort: a transport hiccup must not lose the submission.
  try {
  // Confirmation to the seller
  await sendEmail({
    to: parsed.email,
    subject: `We received your equipment submission: ${parsed.itemTitle}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:560px;">
        <h2 style="color:#0E4F40;">Thanks, ${parsed.contactName} — we&rsquo;ve got it</h2>
        <p>Our acquisitions team will review your submission and reply within <strong>2 business days</strong> with a valuation and next steps.</p>
        <table style="border-collapse:collapse;font-size:14px;margin:16px 0;">${summaryRows}</table>
        <p style="color:#888;font-size:12px;">Reference: ${created.id}</p>
      </div>
    `,
  });

  // Notify acquisitions / ops
  await sendEmail({
    to: OPS_EMAIL,
    subject: `New sell submission: ${parsed.itemTitle} (${parsed.sellerType})`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:600px;">
        <h2 style="color:#0E4F40;">New equipment submission</h2>
        <p>From <strong>${parsed.contactName}</strong> &lt;${parsed.email}&gt;${
          parsed.phone ? ` · ${parsed.phone}` : ''
        }${parsed.companyName ? ` · ${parsed.companyName}` : ''}${
          parsed.country ? ` · ${parsed.country}` : ''
        }</p>
        <table style="border-collapse:collapse;font-size:14px;margin:12px 0;">${summaryRows}</table>
        <p><strong>Description</strong></p>
        <blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${parsed.description.replace(
          /\n/g,
          '<br>',
        )}</blockquote>
        ${parsed.accessories ? `<p><strong>Accessories / extras:</strong> ${parsed.accessories}</p>` : ''}
        ${parsed.reason ? `<p><strong>Reason for selling:</strong> ${parsed.reason}</p>` : ''}
        ${parsed.availability ? `<p><strong>Availability:</strong> ${parsed.availability}</p>` : ''}
        ${parsed.photosUrl ? `<p><strong>Photos:</strong> <a href="${parsed.photosUrl}">${parsed.photosUrl}</a></p>` : ''}
        <p style="color:#888;font-size:12px;">Reference: ${created.id}</p>
      </div>
    `,
  });
  } catch (e) {
    console.error('sell submission emails failed (non-fatal)', e);
  }

  await notifyAdmins(
    'New sell submission',
    `${parsed.contactName}: ${parsed.itemTitle}`,
    '/admin/sell',
    'SELL_NEW',
  );

  revalidatePath('/admin/sell');
  return { ok: true, id: created.id };
}

export async function submitSellAndRedirect(
  input: SellInputType,
): Promise<{ ok: false; error: string } | never> {
  const result = await submitSellSubmission(input);
  if (!result.ok) return result; // show the validation message, don't redirect
  redirect(`/sell/thanks?id=${result.id}`);
}

function ownsSubmission(
  s: { submittedById: string | null; email: string },
  user: { id: string; email: string },
) {
  return s.submittedById === user.id || s.email.toLowerCase() === user.email.toLowerCase();
}

/** Acquisitions/admin replies to a sell submission. */
function parseAttachments(v: FormDataEntryValue | null): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const arr = JSON.parse(v);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((u): u is string => typeof u === 'string')
      .filter((u) => u.startsWith('/media/') || u.startsWith('http://') || u.startsWith('https://'))
      .slice(0, 5);
  } catch {
    return [];
  }
}

export async function replySellSubmission(formData: FormData) {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/sell' });
  await ensureSettingsLoaded();
  const id = String(formData.get('submissionId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const attachments = parseAttachments(formData.get('attachments'));
  if (!id || (body.length < 1 && attachments.length === 0)) return;
  const sub = await prisma.sellSubmission.findUnique({
    where: { id },
    select: { submittedById: true, status: true, itemTitle: true, email: true, contactName: true },
  });
  if (!sub) throw new Error('Submission not found');
  await prisma.sellMessage.create({
    data: { submissionId: id, fromStaff: true, authorId: session.user.id, body, attachments },
  });
  if (sub.status === 'PENDING') {
    await prisma.sellSubmission.update({ where: { id }, data: { status: 'RESPONDED' } });
  }
  const ref = `SS-${id.slice(-6).toUpperCase()}`;
  const base = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
  await notifyAndMaybeEmail({
    userId: sub.submittedById,
    toEmail: sub.email,
    notifTitle: `New reply · ${ref}`,
    notifBody: `Our acquisitions team replied about "${sub.itemTitle}". Open it to respond.`,
    notifHref: `/app/sell-submissions/${id}`,
    emailSubject: `[${ref}] New reply on your equipment offer "${sub.itemTitle}"`,
    emailHtml: `<p>Hi ${sub.contactName ?? 'there'},</p>
                <p>Our acquisitions team replied on your equipment offer <strong>${sub.itemTitle}</strong>.</p>
                <p><a href="${base}/app/sell-submissions/${id}">Open conversation in your dashboard</a></p>
                <p style="color:#888;font-size:12px;">We send at most one of these emails every couple of hours while we're actively chatting — check your dashboard for newer replies.</p>`,
    dedupeKey: ref,
  });
  await audit('sell.reply', ref, `by=${session.user.email}`);
  revalidatePath('/admin/sell');
  revalidatePath(`/admin/sell/${id}`);
  revalidatePath(`/app/sell-submissions/${id}`);
}

/** The person who submitted the equipment replies back. */
export async function replyToSellSubmission(formData: FormData) {
  const session = await requireSession({ redirectTo: '/app/sell-submissions' });
  const id = String(formData.get('submissionId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const attachments = parseAttachments(formData.get('attachments'));
  if (!id || (body.length < 1 && attachments.length === 0)) return;
  const sub = await prisma.sellSubmission.findUnique({
    where: { id },
    select: { submittedById: true, email: true, itemTitle: true },
  });
  if (!sub) throw new Error('Submission not found');
  if (!ownsSubmission(sub, { id: session.user.id, email: session.user.email })) {
    throw new Error('Forbidden');
  }
  await prisma.sellMessage.create({
    data: { submissionId: id, fromStaff: false, authorId: session.user.id, body, attachments },
  });
  await notifyAdmins(
    'Reply on an equipment offer',
    `${session.user.name}: "${sub.itemTitle}"`,
    `/admin/sell/${id}`,
  );
  revalidatePath(`/app/sell-submissions/${id}`);
  revalidatePath('/admin/sell');
  revalidatePath(`/admin/sell/${id}`);
}

/* ───────────────────────────── ACQUISITION LIFECYCLE ─────────────────────
 * Helpers below drive the post-accept journey: price negotiation, bank
 * details, shipping, receive, complete. They share a couple of patterns:
 *   - All mutations re-fetch ownership before write (defense in depth — the
 *     URL never carries the ownership claim).
 *   - Every state change emits a SellMessage of kind='SYSTEM' so the
 *     conversation thread doubles as an audit trail.
 *   - Seller-bound notifications use the throttled helper; chat-rapid-fire
 *     won't spam their inbox.
 */

function ownsSellerSide(sub: { submittedById: string | null; email: string }, sess: { id: string; email: string }) {
  return sub.submittedById === sess.id || sub.email.toLowerCase() === sess.email.toLowerCase();
}

async function emitSystemMessage(submissionId: string, body: string) {
  return prisma.sellMessage.create({
    data: { submissionId, fromStaff: true, body, kind: 'SYSTEM' },
  });
}

/**
 * Admin proposes a counter-price (different from sellers asking price).
 * Materialised as a typed message so the conversation timeline shows the
 * negotiation, plus stamped on the submission as the "current proposed
 * price" — buyer side reads agreedPriceCents only if status moved past
 * the negotiation. priceCents on the message is the offer itself.
 */
export async function proposeAcquisitionPrice(formData: FormData): Promise<void> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/sell' });
  await ensureSettingsLoaded();
  const id = String(formData.get('submissionId') ?? '');
  const cents = Math.round(parseFloat(String(formData.get('amount') ?? '0')) * 100);
  const currency = (String(formData.get('currency') ?? 'EUR') || 'EUR').toUpperCase();
  const note = String(formData.get('note') ?? '').trim().slice(0, 500);
  if (!id || !Number.isFinite(cents) || cents <= 0) return;
  const sub = await prisma.sellSubmission.findUnique({
    where: { id },
    select: { submittedById: true, email: true, contactName: true, itemTitle: true, status: true },
  });
  if (!sub) throw new Error('Submission not found');

  await prisma.sellMessage.create({
    data: {
      submissionId: id,
      fromStaff: true,
      authorId: session.user.id,
      body: note || `We can offer ${(cents / 100).toLocaleString()} ${currency} for this item.`,
      kind: 'PRICE_PROPOSAL',
      priceCents: cents,
      currency,
    },
  });
  if (sub.status === 'PENDING') {
    await prisma.sellSubmission.update({ where: { id }, data: { status: 'RESPONDED' } });
  }
  const ref = `SS-${id.slice(-6).toUpperCase()}`;
  const base = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
  await notifyAndMaybeEmail({
    userId: sub.submittedById,
    toEmail: sub.email,
    notifTitle: `New price offer · ${ref}`,
    notifBody: `We proposed ${(cents / 100).toLocaleString()} ${currency} for "${sub.itemTitle}".`,
    notifHref: `/app/sell-submissions/${id}`,
    emailSubject: `[${ref}] We proposed ${(cents / 100).toLocaleString()} ${currency} for "${sub.itemTitle}"`,
    emailHtml: `<p>Hi ${sub.contactName ?? 'there'},</p>
                <p>We've put a price on your equipment offer:<br><strong style="font-size:18px;">${(cents / 100).toLocaleString()} ${currency}</strong></p>
                ${note ? `<blockquote style="border-left:3px solid #ddd;padding-left:12px;color:#555;">${note}</blockquote>` : ''}
                <p><a href="${base}/app/sell-submissions/${id}">Open offer in your dashboard</a> to accept or counter.</p>`,
    dedupeKey: ref,
  });
  await audit('sell.price.propose', ref, `${cents}c ${currency} by=${session.user.email}`);
  revalidatePath('/admin/sell');
  revalidatePath(`/admin/sell/${id}`);
  revalidatePath(`/app/sell-submissions/${id}`);
}

/**
 * Seller accepts the latest price proposal. Stamps agreedPriceCents and
 * fast-forwards the submission into ACCEPTED + acquisitionStage=AWAITING_BANK
 * so the post-accept flow can start.
 */
export async function acceptAcquisitionPrice(formData: FormData): Promise<void> {
  const session = await requireSession({ redirectTo: '/app/sell-submissions' });
  await ensureSettingsLoaded();
  const id = String(formData.get('submissionId') ?? '');
  if (!id) return;
  const sub = await prisma.sellSubmission.findUnique({
    where: { id },
    select: { submittedById: true, email: true, itemTitle: true, status: true },
  });
  if (!sub) throw new Error('Submission not found');
  if (!ownsSellerSide({ submittedById: sub.submittedById, email: sub.email }, { id: session.user.id, email: session.user.email })) {
    throw new Error('Forbidden');
  }
  // Latest proposal wins — pull from the messages table.
  const latest = await prisma.sellMessage.findFirst({
    where: { submissionId: id, kind: 'PRICE_PROPOSAL' },
    orderBy: { createdAt: 'desc' },
    select: { priceCents: true, currency: true },
  });
  if (!latest?.priceCents) return; // nothing to accept
  await prisma.sellSubmission.update({
    where: { id },
    data: {
      status: 'ACCEPTED',
      acquisitionStage: 'AWAITING_BANK',
      agreedPriceCents: latest.priceCents,
      agreedCurrency: latest.currency ?? 'EUR',
    },
  });
  await emitSystemMessage(id, `Seller accepted ${(latest.priceCents / 100).toLocaleString()} ${latest.currency ?? 'EUR'}. Next: bank details.`);
  await notifyAdmins(
    `Price accepted · ${`SS-${id.slice(-6).toUpperCase()}`}`,
    `Seller accepted ${(latest.priceCents / 100).toLocaleString()} ${latest.currency ?? 'EUR'} for "${sub.itemTitle}".`,
    `/admin/sell/${id}`,
    'SYSTEM',
  ).catch(() => null);
  await audit('sell.price.accept', `SS-${id.slice(-6).toUpperCase()}`, `${latest.priceCents}c by=${session.user.email}`);
  revalidatePath(`/app/sell-submissions/${id}`);
  revalidatePath(`/admin/sell/${id}`);
  revalidatePath('/admin/sell');
}

/**
 * Seller submits/updates bank-payout details. Stored on the submission AND
 * cached on User.sellerBankDetails so repeat sellers don't re-enter every
 * time. Advances the stage to AWAITING_SHIPPING.
 */
export async function saveAcquisitionBankDetails(formData: FormData): Promise<void> {
  const session = await requireSession({ redirectTo: '/app/sell-submissions' });
  await ensureSettingsLoaded();
  const id = String(formData.get('submissionId') ?? '');
  const details = {
    holder: String(formData.get('holder') ?? '').trim().slice(0, 120),
    iban:   String(formData.get('iban')   ?? '').trim().slice(0, 60),
    swift:  String(formData.get('swift')  ?? '').trim().slice(0, 24),
    bankName: String(formData.get('bankName') ?? '').trim().slice(0, 120),
    country:  String(formData.get('country') ?? '').trim().slice(0, 60),
    notes:    String(formData.get('notes') ?? '').trim().slice(0, 500),
  };
  if (!id || !details.holder || !details.iban) return;
  const sub = await prisma.sellSubmission.findUnique({
    where: { id },
    select: { submittedById: true, email: true, itemTitle: true, acquisitionStage: true },
  });
  if (!sub) throw new Error('Submission not found');
  if (!ownsSellerSide({ submittedById: sub.submittedById, email: sub.email }, { id: session.user.id, email: session.user.email })) {
    throw new Error('Forbidden');
  }

  await prisma.$transaction(async (tx) => {
    await tx.sellSubmission.update({
      where: { id },
      data: {
        sellerBankDetails: details,
        acquisitionStage: sub.acquisitionStage === 'AWAITING_BANK' ? 'AWAITING_SHIPPING' : sub.acquisitionStage,
      },
    });
    // Cache on user profile for next time
    await tx.user.update({
      where: { id: session.user.id },
      data: { sellerBankDetails: details },
    });
  });
  await emitSystemMessage(id, `Seller provided bank details. Next: ship the item to us.`);
  await notifyAdmins(
    `Bank details received · ${`SS-${id.slice(-6).toUpperCase()}`}`,
    `Seller submitted payout bank details for "${sub.itemTitle}".`,
    `/admin/sell/${id}`,
    'SYSTEM',
  ).catch(() => null);
  await audit('sell.bank.save', `SS-${id.slice(-6).toUpperCase()}`, `by=${session.user.email}`);
  revalidatePath(`/app/sell-submissions/${id}`);
  revalidatePath(`/admin/sell/${id}`);
}

/**
 * Seller posts the device and enters the carrier/tracking. Moves the stage
 * to IN_TRANSIT and surfaces the tracking on both sides.
 */
export async function saveAcquisitionShipping(formData: FormData): Promise<void> {
  const session = await requireSession({ redirectTo: '/app/sell-submissions' });
  await ensureSettingsLoaded();
  const id = String(formData.get('submissionId') ?? '');
  const carrier = String(formData.get('carrier') ?? '').trim().slice(0, 40);
  const tracking = String(formData.get('tracking') ?? '').trim().slice(0, 120);
  if (!id || !carrier || !tracking) return;
  const sub = await prisma.sellSubmission.findUnique({
    where: { id },
    select: { submittedById: true, email: true, itemTitle: true },
  });
  if (!sub) throw new Error('Submission not found');
  if (!ownsSellerSide({ submittedById: sub.submittedById, email: sub.email }, { id: session.user.id, email: session.user.email })) {
    throw new Error('Forbidden');
  }
  await prisma.sellSubmission.update({
    where: { id },
    data: {
      sellerShippingCarrier: carrier,
      sellerShippingTracking: tracking,
      sellerShippedAt: new Date(),
      acquisitionStage: 'IN_TRANSIT',
    },
  });
  await emitSystemMessage(id, `Seller shipped via ${carrier} (${tracking}). Awaiting receipt.`);
  await notifyAdmins(
    `Shipment in transit · ${`SS-${id.slice(-6).toUpperCase()}`}`,
    `${carrier} · ${tracking} — "${sub.itemTitle}"`,
    `/admin/sell/${id}`,
    'SYSTEM',
  ).catch(() => null);
  await audit('sell.shipping.save', `SS-${id.slice(-6).toUpperCase()}`, `${carrier} ${tracking} by=${session.user.email}`);
  revalidatePath(`/app/sell-submissions/${id}`);
  revalidatePath(`/admin/sell/${id}`);
}

/** Admin stamps that the package has physically arrived at the warehouse. */
export async function markAcquisitionReceived(formData: FormData): Promise<void> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/sell' });
  await ensureSettingsLoaded();
  const id = String(formData.get('submissionId') ?? '');
  if (!id) return;
  const sub = await prisma.sellSubmission.findUnique({
    where: { id },
    select: { submittedById: true, email: true, contactName: true, itemTitle: true },
  });
  if (!sub) throw new Error('Submission not found');
  await prisma.sellSubmission.update({
    where: { id },
    data: {
      acquisitionStage: 'RECEIVED',
      receivedAt: new Date(),
      receivedById: session.user.id,
    },
  });
  await emitSystemMessage(id, `Package received at warehouse. Inspection in progress.`);
  const ref = `SS-${id.slice(-6).toUpperCase()}`;
  const base = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
  await notifyAndMaybeEmail({
    userId: sub.submittedById,
    toEmail: sub.email,
    notifTitle: `Package received · ${ref}`,
    notifBody: `We received "${sub.itemTitle}". Inspection in progress — we'll wire payment as soon as QC clears.`,
    notifHref: `/app/sell-submissions/${id}`,
    emailSubject: `[${ref}] We received "${sub.itemTitle}" — inspection started`,
    emailHtml: `<p>Hi ${sub.contactName ?? 'there'},</p>
                <p>Your equipment for offer <strong>${ref}</strong> arrived at our warehouse and is now being inspected.</p>
                <p>Once QC clears we wire payment to the bank details on file and email you the transfer receipt.</p>
                <p><a href="${base}/app/sell-submissions/${id}">Track status in your dashboard</a></p>`,
    dedupeKey: ref,
  });
  await audit('sell.received', ref, `by=${session.user.email}`);
  revalidatePath(`/admin/sell/${id}`);
  revalidatePath(`/app/sell-submissions/${id}`);
}

/**
 * Admin completes the acquisition: payment wired + receipt uploaded. The
 * paymentReceiptUrl is set on the submission; seller sees it on their
 * dashboard. Status moves to COMPLETED (terminal).
 *
 * paymentReceiptUrl arrives as a pre-uploaded URL string (the file goes
 * through the existing attachment-upload route first).
 */
export async function completeAcquisition(formData: FormData): Promise<void> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/sell' });
  await ensureSettingsLoaded();
  const id = String(formData.get('submissionId') ?? '');
  const receiptUrl = String(formData.get('paymentReceiptUrl') ?? '').trim();
  if (!id || !receiptUrl) return;
  const sub = await prisma.sellSubmission.findUnique({
    where: { id },
    select: { submittedById: true, email: true, contactName: true, itemTitle: true, agreedPriceCents: true, agreedCurrency: true },
  });
  if (!sub) throw new Error('Submission not found');
  await prisma.sellSubmission.update({
    where: { id },
    data: {
      acquisitionStage: 'COMPLETED',
      completedAt: new Date(),
      paymentReceiptUrl: receiptUrl,
    },
  });
  await emitSystemMessage(id, `Acquisition completed. Payment of ${(sub.agreedPriceCents ?? 0) / 100} ${sub.agreedCurrency ?? 'EUR'} wired; receipt attached.`);
  const ref = `SS-${id.slice(-6).toUpperCase()}`;
  const base = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
  await notifyAndMaybeEmail({
    userId: sub.submittedById,
    toEmail: sub.email,
    notifTitle: `Acquisition completed · ${ref}`,
    notifBody: `Payment of ${(sub.agreedPriceCents ?? 0) / 100} ${sub.agreedCurrency ?? 'EUR'} has been wired. Receipt available in your dashboard.`,
    notifHref: `/app/sell-submissions/${id}`,
    emailSubject: `[${ref}] Payment wired — acquisition complete`,
    emailHtml: `<p>Hi ${sub.contactName ?? 'there'},</p>
                <p>We've wired <strong>${(sub.agreedPriceCents ?? 0) / 100} ${sub.agreedCurrency ?? 'EUR'}</strong> to your bank for offer <strong>${ref}</strong>.</p>
                <p><a href="${base}/app/sell-submissions/${id}">Open dashboard</a> to download the transfer receipt.</p>
                <p>Thanks for selling through lab2date — the instrument is going to a new home.</p>`,
    dedupeKey: ref,
  });
  await audit('sell.completed', ref, `by=${session.user.email}`);
  revalidatePath(`/admin/sell/${id}`);
  revalidatePath(`/app/sell-submissions/${id}`);
}

/**
 * Convenience wrapper for the admin "Complete + upload receipt" form. Takes
 * a file via the multipart request, uploads it to S3 (private prefix), then
 * calls completeAcquisition with the resulting URL. Keeps the admin
 * page's UX as a single form-submit click instead of two-step (upload then
 * paste URL).
 */
export async function uploadReceiptAndComplete(formData: FormData): Promise<void> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/sell' });
  const id = String(formData.get('submissionId') ?? '');
  const file = formData.get('receipt');
  if (!id || !file || typeof file === 'string') return;
  const f = file as File;
  if (f.size === 0) return;
  if (f.size > 8_000_000) throw new Error('Receipt must be under 8 MB');
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  if (!allowed.includes(f.type)) throw new Error('Receipt must be JPG / PNG / WEBP / PDF');

  const { uploadObject } = await import('@/lib/storage/s3');
  const ext = (f.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const buf = Buffer.from(await f.arrayBuffer());
  const key = `order-proofs/sell-receipt-${id}-${Date.now()}.${ext}`;
  const up = await uploadObject(key, buf, f.type);

  // Build the inner FormData the actual completer expects.
  const fd = new FormData();
  fd.append('submissionId', id);
  fd.append('paymentReceiptUrl', up.url);
  await completeAcquisition(fd);
  void session;
}
