'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getServerSession, requireSession, requireCapability } from '@/lib/auth-server';
import { headerText } from '@/lib/email-html';
import type { Vars } from '@/lib/cms/text';
import { sendTemplatedEmail } from '@/lib/email-templates/send';
import { siteLink } from '@/lib/email-templates/links';
import { ensureSettingsLoaded } from '@/lib/settings';
import { rateLimit } from '@/lib/ratelimit';
import { audit, notifyAdmins, notifyUser } from '@/lib/observability';
import { notifyAndMaybeEmail } from '@/lib/notify-throttled';
import { intakeEmail } from '@/lib/intake';

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
  // http(s) only: z.url() also accepts javascript:/data: links, and this value
  // is rendered as a clickable link for the acquisitions team.
  photosUrl: z
    .string()
    .url()
    .max(500)
    .refine((u) => /^https?:\/\//i.test(u), 'must be a web link starting with http:// or https://')
    .optional()
    .nullable()
    .or(z.literal('')),
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

  // The offer summary, as e-mail fields ("—" for what was left empty).
  const summary = {
    'submission.item': headerText(parsed.itemTitle, 120),
    'submission.brand_model': [parsed.brand, parsed.model].filter(Boolean).join(' ') || '—',
    'submission.category': parsed.category || '—',
    'submission.condition': parsed.condition,
    'submission.year': parsed.yearMade ? String(parsed.yearMade) : '—',
    'submission.quantity': String(parsed.quantity),
    'submission.location': parsed.location || '—',
  };

  // Emails are best-effort: a transport hiccup must not lose the submission.
  try {
  // Confirmation to the seller. This form needs no account and mails the
  // address that was typed, so the submission (name, item, summary) is echoed
  // only to the signed-in user's own address. Anyone else gets a generic
  // receipt (whose e-mail has no fields for the offer, so an admin editing it
  // cannot add them) — otherwise the form relays arbitrary text from
  // Labtodate to any inbox. The ops copy below carries the full details.
  const echo = !!session && parsed.email.trim().toLowerCase() === session.user.email.trim().toLowerCase();
  await sendTemplatedEmail(
    echo
      ? {
          key: 'sell_submission_received',
          to: parsed.email,
          vars: {
            ...summary,
            'customer.name': parsed.contactName,
            'submission.number': created.id,
            'submission.asking_price': parsed.askingPrice || '—',
          },
        }
      : { key: 'sell_submission_received_generic', to: parsed.email, vars: { 'submission.number': created.id } },
  );

  // Notify acquisitions / ops — only a configured inbox (skipped and logged otherwise).
  const opsEmail = await intakeEmail('sell', 'staff_sell_submission');
  if (opsEmail) await sendTemplatedEmail({
    key: 'staff_sell_submission',
    to: opsEmail,
    lang: 'en',
    vars: {
      ...summary,
      'submission.number': created.id,
      'submission.seller_type': parsed.sellerType,
      'submission.asking_price': parsed.askingPrice || 'Open to offers',
      'seller.name': parsed.contactName,
      'seller.email': parsed.email,
      'seller.phone': parsed.phone || '—',
      'seller.company': parsed.companyName || '—',
      'seller.country': parsed.country || '—',
      'submission.description': parsed.description,
      'submission.accessories': parsed.accessories || '—',
      'submission.reason': parsed.reason || '—',
      'submission.availability': parsed.availability || '—',
      'submission.photos_url': parsed.photosUrl && /^https?:\/\//i.test(parsed.photosUrl) ? parsed.photosUrl : '—',
      'link.admin': siteLink(`/admin/sell/${created.id}`),
    },
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
      // The reply box uploads through /api/attachment-upload, which returns the
      // auth-gated proxy URL. Only those are kept — the old /media/ + http(s)
      // allow-list silently dropped every real attachment.
      .filter((u) => u.startsWith('/api/support-attachment/'))
      .slice(0, 5);
  } catch {
    return [];
  }
}

/** Amount as people write it: cents only when there are some (never rounded). */
function fmtAmount(cents: number, currency: string): string {
  const digits = cents % 100 === 0 ? 0 : 2;
  return `${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}

/**
 * Lifecycle milestones (offer, accepted, declined, received, paid) are
 * transactional: the seller always gets the in-app note AND the email. They
 * used to go through notifyAndMaybeEmail, whose chat throttle matches the
 * SS-ref in the subject, so any chat reply in the previous couple of hours
 * swallowed the offer or even the "payment wired" email. Guest sellers have
 * no account, so for them the email is the only channel.
 */
async function notifySellerMilestone(opts: {
  userId: string | null;
  toEmail: string;
  notifTitle: string;
  notifBody: string;
  notifHref: string;
  /** The milestone's e-mail (Admin → Documents → E-mails) and its fields. */
  emailKey: string;
  emailVars: Vars;
}): Promise<void> {
  await notifyUser(opts.userId, opts.notifTitle, opts.notifBody, opts.notifHref);
  await sendTemplatedEmail({ key: opts.emailKey, to: opts.toEmail, vars: opts.emailVars }).catch((e) =>
    console.error('[sell] milestone email failed', opts.emailKey, e),
  );
}

/** Fields every e-mail about an offer has: seller, reference, item, link. */
function offerVars(id: string, sub: { contactName: string | null; itemTitle: string }): Vars {
  return {
    'customer.name': sub.contactName ?? '',
    'submission.number': `SS-${id.slice(-6).toUpperCase()}`,
    'submission.item': headerText(sub.itemTitle, 120),
    'link.submission': siteLink(`/app/sell-submissions/${id}`),
  };
}

const ACQUISITION_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'];
const MAX_ACQUISITION_CENTS = 10_000_000_00; // €10M — far above any lab instrument

export async function replySellSubmission(formData: FormData) {
  const session = await requireCapability('sell:reply', { redirectTo: '/admin/sell' });
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
  await notifyAndMaybeEmail({
    userId: sub.submittedById,
    toEmail: sub.email,
    notifTitle: `New reply · ${ref}`,
    notifBody: `Our acquisitions team replied about "${sub.itemTitle}". Open it to respond.`,
    notifHref: `/app/sell-submissions/${id}`,
    emailKey: 'sell_reply',
    emailVars: offerVars(id, sub),
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
 *   - Chat replies use the throttled helper so rapid-fire chat won't spam the
 *     seller's inbox; lifecycle milestones always email (notifySellerMilestone).
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
  const session = await requireCapability('sell:status', { redirectTo: '/admin/sell' });
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
      body: note || `We can offer ${fmtAmount(cents, currency)} for this item.`,
      kind: 'PRICE_PROPOSAL',
      priceCents: cents,
      currency,
    },
  });
  if (sub.status === 'PENDING') {
    await prisma.sellSubmission.update({ where: { id }, data: { status: 'RESPONDED' } });
  }
  const ref = `SS-${id.slice(-6).toUpperCase()}`;
  await notifySellerMilestone({
    userId: sub.submittedById,
    toEmail: sub.email,
    notifTitle: `New price offer · ${ref}`,
    notifBody: `We proposed ${fmtAmount(cents, currency)} for "${sub.itemTitle}".`,
    notifHref: `/app/sell-submissions/${id}`,
    emailKey: 'sell_price_offer',
    emailVars: { ...offerVars(id, sub), 'offer.amount': fmtAmount(cents, currency), 'offer.note': note },
  });
  await audit('sell.price.propose', ref, `${cents}c ${currency} by=${session.user.email}`);
  revalidatePath('/admin/sell');
  revalidatePath(`/admin/sell/${id}`);
  revalidatePath(`/app/sell-submissions/${id}`);
}

/**
 * Admin accepts a submission without a counter-offer ("skip negotiation").
 * The agreed payout price is required: the lifecycle (bank details → ship →
 * receive → pay) runs on agreedPriceCents, so accepting without one left the
 * deal with no next step for either side. Also repairs offers that were
 * accepted before the price was required (status ACCEPTED, no stage).
 */
export async function acceptSellSubmissionAtPrice(formData: FormData): Promise<void> {
  const session = await requireCapability('sell:status', { redirectTo: '/admin/sell' });
  await ensureSettingsLoaded();
  const id = String(formData.get('submissionId') ?? '');
  if (!id) return;
  const cents = Math.round(parseFloat(String(formData.get('amount') ?? '')) * 100);
  const currency = String(formData.get('currency') ?? 'EUR').toUpperCase();
  if (!Number.isFinite(cents) || cents <= 0 || cents > MAX_ACQUISITION_CENTS || !ACQUISITION_CURRENCIES.includes(currency)) {
    redirect(`/admin/sell/${id}?err=price`);
  }
  const sub = await prisma.sellSubmission.findUnique({
    where: { id },
    select: { submittedById: true, email: true, contactName: true, itemTitle: true },
  });
  if (!sub) redirect('/admin/sell');
  const claim = await prisma.sellSubmission.updateMany({
    where: { id, acquisitionStage: null, status: { in: ['PENDING', 'RESPONDED', 'ACCEPTED'] } },
    data: { status: 'ACCEPTED', acquisitionStage: 'AWAITING_BANK', agreedPriceCents: cents, agreedCurrency: currency },
  });
  if (claim.count !== 1) redirect(`/admin/sell/${id}?err=state`);

  const ref = `SS-${id.slice(-6).toUpperCase()}`;
  await emitSystemMessage(id, `Acquisitions accepted the offer at ${fmtAmount(cents, currency)}. Next: bank details.`);
  await notifySellerMilestone({
    userId: sub.submittedById,
    toEmail: sub.email,
    notifTitle: `Offer accepted · ${ref}`,
    notifBody: `We'll buy "${sub.itemTitle}" for ${fmtAmount(cents, currency)}. Next: add your bank details for the payout.`,
    notifHref: `/app/sell-submissions/${id}`,
    emailKey: 'sell_offer_accepted',
    emailVars: { ...offerVars(id, sub), 'offer.amount': fmtAmount(cents, currency), 'submission.email': sub.email },
  });
  await audit('sell.accept', ref, `${cents}c ${currency} by=${session.user.email}`);
  revalidatePath('/admin/sell');
  revalidatePath(`/admin/sell/${id}`);
  revalidatePath(`/app/sell-submissions/${id}`);
  redirect(`/admin/sell/${id}`); // drop a stale ?err= from an earlier attempt
}

/** Admin declines a submission. The seller is told by email (guests have no
 *  account, so an in-app note alone reached nobody). */
export async function declineSellSubmission(formData: FormData): Promise<void> {
  const session = await requireCapability('sell:status', { redirectTo: '/admin/sell' });
  await ensureSettingsLoaded();
  const id = String(formData.get('submissionId') ?? '');
  if (!id) return;
  const sub = await prisma.sellSubmission.findUnique({
    where: { id },
    select: { submittedById: true, email: true, contactName: true, itemTitle: true },
  });
  if (!sub) redirect('/admin/sell');
  // Compare-and-set: a double click emails once; never after the payout started.
  const claim = await prisma.sellSubmission.updateMany({
    where: { id, acquisitionStage: null, status: { notIn: ['DECLINED', 'CLOSED'] } },
    data: { status: 'DECLINED' },
  });
  if (claim.count === 1) {
    const ref = `SS-${id.slice(-6).toUpperCase()}`;
    await emitSystemMessage(id, 'Acquisitions declined this offer.');
    await notifySellerMilestone({
      userId: sub.submittedById,
      toEmail: sub.email,
      notifTitle: 'Your equipment submission was declined',
      notifBody: `"${sub.itemTitle}" was declined. Thank you for the offer.`,
      notifHref: `/app/sell-submissions/${id}`,
      emailKey: 'sell_offer_declined',
      emailVars: offerVars(id, sub),
    });
    await audit('sell.decline', ref, `by=${session.user.email}`);
  }
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
    select: { submittedById: true, email: true, itemTitle: true, status: true, acquisitionStage: true },
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
  // Only an open negotiation can be accepted (an ACCEPTED offer that never got
  // a price included). Once the payout lifecycle runs, a stale/double click
  // must not rewind it to AWAITING_BANK.
  const claim = await prisma.sellSubmission.updateMany({
    where: { id, acquisitionStage: null, status: { in: ['PENDING', 'RESPONDED', 'ACCEPTED'] } },
    data: {
      status: 'ACCEPTED',
      acquisitionStage: 'AWAITING_BANK',
      agreedPriceCents: latest.priceCents,
      agreedCurrency: latest.currency ?? 'EUR',
    },
  });
  if (claim.count !== 1) return;
  await emitSystemMessage(id, `Seller accepted ${fmtAmount(latest.priceCents, latest.currency ?? 'EUR')}. Next: bank details.`);
  await notifyAdmins(
    `Price accepted · ${`SS-${id.slice(-6).toUpperCase()}`}`,
    `Seller accepted ${fmtAmount(latest.priceCents, latest.currency ?? 'EUR')} for "${sub.itemTitle}".`,
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
  const session = await requireCapability('sell:status', { redirectTo: '/admin/sell' });
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
  await notifySellerMilestone({
    userId: sub.submittedById,
    toEmail: sub.email,
    notifTitle: `Package received · ${ref}`,
    notifBody: `We received "${sub.itemTitle}". Inspection in progress — we'll wire payment as soon as QC clears.`,
    notifHref: `/app/sell-submissions/${id}`,
    emailKey: 'sell_item_received',
    emailVars: offerVars(id, sub),
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
  const session = await requireCapability('sell:status', { redirectTo: '/admin/sell' });
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
  const paid = fmtAmount(sub.agreedPriceCents ?? 0, sub.agreedCurrency ?? 'EUR');
  await emitSystemMessage(id, `Acquisition completed. Payment of ${paid} wired; receipt attached.`);
  const ref = `SS-${id.slice(-6).toUpperCase()}`;
  await notifySellerMilestone({
    userId: sub.submittedById,
    toEmail: sub.email,
    notifTitle: `Acquisition completed · ${ref}`,
    notifBody: `Payment of ${paid} has been wired. Receipt available in your dashboard.`,
    notifHref: `/app/sell-submissions/${id}`,
    emailKey: 'sell_payment_sent',
    emailVars: { ...offerVars(id, sub), 'payout.amount': paid },
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
  const session = await requireCapability('sell:status', { redirectTo: '/admin/sell' });
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
