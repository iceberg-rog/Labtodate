'use server';

import { orderLineTruthFor } from '@/lib/catalog/order-snapshot';
import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getServerSession, requireSession, requireCapability } from '@/lib/auth-server';
import {
  companyCopyAddress, isDeliverableEmail, sendInternalEmail, trySendEmail,
} from '@/lib/email';
import { escapeHtml, escapeHtmlLines, headerText } from '@/lib/email-html';
import { ensureSettingsLoaded } from '@/lib/settings';
import { formatPrice } from '@/lib/utils';
import { rateLimit } from '@/lib/ratelimit';
import { notifyAdmins, notifyUser, audit, logError } from '@/lib/observability';
import { guardPublicForm, PublicFormError } from '@/lib/security/captcha';
import { createOrderWithUniqueNumber } from '@/lib/orders/internal';
import { absoluteDocumentHref } from '@/lib/documents';
import { documentAttachment, issueProforma, markDocumentSent, voidProformas } from '@/lib/documents/issue';
import { quoteDeletionBlockers } from '@/lib/documents/retention';
import {
  CONTACT_REMOVED, HELD_SUPPLIER_MESSAGE_PREFIX, QUOTE_REF, contactKindsLabel, destinationFromPlace, offerMaxCents, endOfDayUtc, fmtDay, isoDay, mediateSupplierMessage,
  offerPhase, quoteRef, sentence, statusClaimFilter, PAID_ORDER_STATES,
} from '@/lib/quotes/offer';
import { vatTreatmentLabel, type VatDecision, type VatTreatmentCode } from '@/lib/tax/determine';
import { billingAddressJson, parseDetailsInput, shippingAddressJson, type DetailsFieldErrors, type OrderDetails } from '@/lib/orders/details';
import {
  autoArchiveOnClose, closeReasons, declineReasons, mediationMode, offerCurrencies, offerDefaults, offerIncoterms, openOfferHoldDays, quoteSlaHours,
  requireTermsAcceptance, sellerMarkupBp, sellerOffersRequireApproval, sellerPriceRounding, sellerSeesSellPrice, stockReserveOn, termsOfSaleHref,
  termsOfSaleUrl, termsTextVersion, vatIdRule, vatReviewBuyerText,
} from '@/lib/quotes/policy';
import {
  applyMarkup, daysFrom, fillPaymentTermsText, incotermLabel, offerAmounts, parseOfferTerms, pctLabel, type OfferTerms,
} from '@/lib/quotes/pricing';
import { decideVatForDetails, offerVatAtSend, offerVatLines } from '@/lib/quotes/engine';
import { holdUnitForQuote, releaseQuoteHold, unitAvailability } from '@/lib/quotes/stock';
import { mailLayout, mailTable } from '@/lib/quotes/mail';
import { buyerVatExplanation, offerItemTitle, parseOfferItem, type OfferItem } from '@/lib/quotes/offer-view';
import { siteName } from '@/lib/brand/identity';
import { documentRecipients } from '@/lib/orders/recipients';
import { quotationAttachment } from '@/lib/documents/quotation';
import { primaryHold, type HoldCode } from '@/lib/checkout/engine';
import { checkCountry, countryOptions } from '@/lib/compliance/country';
import { getConditionGrades } from '@/lib/catalog/policy';
import { decodeEntities } from '@/lib/marketplace/import-clean';

// ────────────────────────────────────────────────────────────────────────────
//   Mirror of Support-ticket production-hardening helpers
// ────────────────────────────────────────────────────────────────────────────

/** Reply deadline for a request waiting on our team (QUOTE_SLA_HOURS per priority). */
function computeQuoteDueAt(now: Date, priority: string): Date {
  return new Date(now.getTime() + quoteSlaHours(priority) * 3600 * 1000);
}

function makeQuoteAccessToken(): string {
  return randomBytes(24).toString('base64url');
}
const QUOTE_MAGIC_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
function quoteTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + QUOTE_MAGIC_LINK_TTL_MS);
}

function quoteRefOrProforma(sr: { id: string; proformaNumber: string | null }): string {
  return quoteRef(sr);
}

function siteBase(): string {
  return (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
}

/** A mail paragraph whose HTML starts with a tag (mailLayout wraps only lines that start with text). */
const mailP = (html: string) => `<p style="margin:0 0 12px;">${html}</p>`;

/** Turnaround promise for buyer copy. Comes from the admin QUOTE_TURNAROUND
 *  setting (the same value /let-us-find-it shows); no setting, no time promise. */
function quoteTurnaroundPhrase(): string {
  const t = process.env.QUOTE_TURNAROUND?.trim();
  return t ? `within ${t}` : 'as soon as we have something solid';
}

/** Where staff work a quote: the seller inbox for a real seller, else admin. */
function staffQuoteHref(sr: { id: string; assignedTo?: { role: string } | null }): string {
  return sr.assignedTo?.role === 'SELLER' ? `/app/seller/inbox/${sr.id}` : `/admin/quotes/${sr.id}`;
}

/** The staff inbox for quote notifications: the assigned seller's own address
 *  when it is real, otherwise the intake inbox (imported sellers carry
 *  placeholder addresses). Sent through sendInternalEmail — never fatal. */
function staffQuoteInbox(sr: { assignedTo?: { email: string; role: string } | null }): { to: string; toSeller: boolean } {
  const sellerEmail = sr.assignedTo?.email;
  const toSeller = sr.assignedTo?.role === 'SELLER' && isDeliverableEmail(sellerEmail);
  return {
    to: isDeliverableEmail(sellerEmail) ? sellerEmail : process.env.QUOTE_INTAKE_EMAIL ?? '',
    toSeller,
  };
}

/** Where the buyer follows a quote: the dashboard, or the magic link of a guest request. */
function buyerQuoteLink(sr: { id: string; submittedById: string | null; accessToken: string | null }): string {
  return sr.submittedById || !sr.accessToken ? `${siteBase()}/app/quotes/${sr.id}` : `${siteBase()}/quotes/t/${sr.accessToken}`;
}

/**
 * One admin alert per quote and kind per 24 h (a buyer clicking "accept" three
 * times while VIES is down is one problem, not three). The claim is a
 * ReminderLog row (QUOTE, id, kind): created, or moved forward when the last
 * alert is older than a day. Never fatal.
 */
async function alertAdminsOncePerDay(quoteId: string, kind: string, title: string, body: string): Promise<boolean> {
  const now = new Date();
  try {
    try {
      await prisma.reminderLog.create({ data: { subjectType: 'QUOTE', subjectId: quoteId, kind, step: 0, sentAt: now, detail: title.slice(0, 200) } });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const moved = await prisma.reminderLog.updateMany({
        where: { subjectType: 'QUOTE', subjectId: quoteId, kind, step: 0, sentAt: { lt: new Date(now.getTime() - 86_400_000) } },
        data: { sentAt: now, detail: title.slice(0, 200) },
      });
      if (moved.count !== 1) return false;
    }
    await notifyAdmins(title, body, `/admin/quotes/${quoteId}`, 'SYSTEM');
    return true;
  } catch (e) {
    await logError('quotes:admin-alert', e);
    return false;
  }
}

/** Readable result for quote actions. Production builds hide thrown messages
 *  behind a generic "Server Components render" error, so known failures are
 *  returned instead of thrown.
 *   - `error`   nothing was done (the action refused / failed).
 *   - `notice`  done; what happened besides the obvious.
 *   - `warning` done and SAVED, but something secondary failed (e.g. the
 *               email to the buyer bounced) — said truthfully, never as "not sent". */
export type QuoteActionResult = { error?: string; notice?: string; warning?: string };

const SourcingInput = z.object({
  buyerEmail: z.string().email(),
  buyerName: z.string().min(2).max(120),
  companyName: z.string().max(180).optional().nullable(),
  productCategory: z.string().max(120).optional().nullable(),
  budget: z.string().max(120).optional().nullable(),
  timeframe: z.string().max(120).optional().nullable(),
  description: z.string().min(20).max(4000),
  productSlug: z.string().optional().nullable(),
  // Lab-rental "Request access" — a LabFacility slug, not a product.
  facilitySlug: z.string().max(200).optional().nullable(),
  // Honeypot — hidden in the UI; only bots fill it. Presence => silent drop.
  company_url: z.string().optional().nullable(),
  /** Solved bot check (only when Settings → Security asks signed-in customers too). */
  captcha: z.string().max(8000).optional(),
  // What the buyer needs, for the offer: accepted by the form already, not
  // stored on the request yet.
  /** ISO country the goods go to ('' = not given). */
  deliveryCountry: z.string().regex(/^([A-Za-z]{2})?$/).optional().nullable(),
  quantity: z.number().int().min(1).max(999).optional().nullable(),
  /** Wanted Incoterm, e.g. DAP. */
  incoterm: z.string().max(3).optional().nullable(),
  vatId: z.string().max(32).optional().nullable(),
  /** "Source a similar unit" from a sold / reserved listing (not that unit itself). */
  similar: z.boolean().optional().nullable(),
});

export type SourcingInputType = z.infer<typeof SourcingInput>;

export async function submitSourcingRequest(input: SourcingInputType) {
  await ensureSettingsLoaded();
  // Quote requests belong to an account: guests must sign in first, and the
  // buyer's name and email always come from the account. A typed address could
  // be anyone's, and the buyer would never see the quote in their dashboard.
  const session = await getServerSession();
  if (!session) throw new Error('Please sign in to request a quote.');
  const parsed = SourcingInput.parse({
    ...input,
    buyerEmail: session.user.email,
    buyerName: session.user.name?.trim() || input.buyerName,
  });
  // Honeypot: real users never fill the hidden `company_url` field. If it's
  // set, silently drop (no DB row, no emails) but return a normal-looking
  // shape so the bot gets the same thank-you as a human — no abuse signal.
  if (parsed.company_url && parsed.company_url.trim()) {
    await audit('quote.honeypot', 'blocked', parsed.buyerEmail || 'unknown').catch(() => {});
    return { id: '', accessToken: null };
  }
  await guardPublicForm('quote', { captcha: parsed.captcha }, true);
  // Counted only after validation: a buyer fixing a too-long field must not
  // burn through the limit and get locked out of the corrected submit.
  await rateLimit('quote');
  const submittedById = session.user.id;

  // Anchored to a product only when THAT unit can be offered: a published
  // listing in stock, and the buyer did not ask for a similar one (routed to
  // the product's seller). A sold or reserved listing ("Source a similar unit")
  // becomes a "similar to" request the team sources — no unit is promised, so
  // any matching unit can be offered. Unpublished listings are ignored.
  let productId: string | null = null;
  let similarToProductId: string | null = null;
  let assignedToId: string | null = null;
  if (parsed.productSlug) {
    const product = await prisma.product.findUnique({
      where: { slug: parsed.productSlug },
      select: { id: true, sellerId: true, title: true, status: true, quantity: true },
    });
    if (product?.status === 'PUBLISHED') {
      if (!parsed.similar && product.quantity > 0) {
        productId = product.id;
        assignedToId = product.sellerId;
      } else {
        similarToProductId = product.id;
        parsed.productCategory = `Similar to: ${decodeEntities(product.title).replace(/\s+/g, ' ').trim()}`.slice(0, 120);
      }
    }
  }
  // What the buyer needs for the offer (destination, quantity, Incoterm): kept
  // with the request text, so whoever quotes sees it. The VAT ID identifies the
  // buyer's company, so it is an internal note (suppliers never see it).
  const needs = [
    parsed.deliveryCountry ? `Delivery country: ${parsed.deliveryCountry.toUpperCase()}` : '',
    parsed.quantity && parsed.quantity > 1 ? `Quantity: ${parsed.quantity}` : '',
    parsed.incoterm?.trim() ? `Incoterm: ${parsed.incoterm.trim().toUpperCase()}` : '',
  ].filter(Boolean);
  if (needs.length) parsed.description = `${parsed.description.trim()}\n\n${needs.join(' · ')}`.slice(0, 4000);
  const buyerVatId = parsed.vatId?.trim().toUpperCase().replace(/[\s.\-_/]+/g, '') || null;
  // A lab-rental access request has no product: record the facility as the
  // category so the admin queue, title and emails say which lab is wanted.
  let facilityLabel: string | null = null;
  if (!productId && parsed.facilitySlug) {
    const facility = await prisma.labFacility.findUnique({
      where: { slug: parsed.facilitySlug },
      select: { name: true, city: true, country: true, isPublished: true },
    });
    if (facility?.isPublished) {
      facilityLabel = `Lab rental: ${facility.name} (${facility.city}, ${facility.country})`.slice(0, 120);
      parsed.productCategory = facilityLabel;
    }
  }

  // Customer-type + magic-link token mirror SupportTicket. A REGISTERED
  // submitter follows up via the dashboard; a GUEST uses the magic link.
  const customerType = submittedById ? 'REGISTERED' : 'GUEST';
  const now = new Date();
  const accessToken = customerType === 'GUEST' ? makeQuoteAccessToken() : null;
  const accessTokenIssuedAt = accessToken ? now : null;
  const accessTokenExpiresAt = accessToken ? quoteTokenExpiry(now) : null;
  // Initial priority is NORMAL — operators upgrade via setQuotePriority.
  const priority = 'NORMAL';
  const dueAt = computeQuoteDueAt(now, priority);

  const created = await prisma.sourcingRequest.create({
    data: {
      buyerEmail: parsed.buyerEmail,
      buyerName: parsed.buyerName,
      companyName: parsed.companyName ?? null,
      productCategory: parsed.productCategory ?? null,
      budget: parsed.budget ?? null,
      timeframe: parsed.timeframe ?? null,
      description: parsed.description,
      productId,
      similarToProductId,
      submittedById,
      assignedToId,
      customerType,
      accessToken,
      accessTokenIssuedAt,
      accessTokenExpiresAt,
      priority,
      dueAt,
      lastReplyAt: now,
      lastReplyByStaff: false,
    },
    include: {
      product: { select: { title: true, slug: true } },
      assignedTo: { select: { email: true, name: true, role: true } },
    },
  });
  if (buyerVatId) {
    await prisma.quoteMessage.create({
      data: { sourcingRequestId: created.id, authorId: null, isInternalNote: true, fromStaff: true, body: `VAT ID given with the request: ${buyerVatId} (checked with VIES when the buyer accepts an offer).` },
    });
  }

  // Confirmation to buyer — REGISTERED gets dashboard CTA, GUEST gets magic-link.
  // The request is already saved: a failed confirmation is logged, not thrown,
  // or the buyer is told "not sent" and resubmits duplicates.
  const buyerCta = accessToken
    ? `${siteBase()}/quotes/t/${accessToken}`
    : `${siteBase()}/app/quotes/${created.id}`;
  const productTitle = created.product ? decodeEntities(created.product.title) : null;
  const quoteBlock = `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;color:#374151;">${escapeHtmlLines(parsed.description)}</blockquote>`;
  await trySendEmail({
    to: parsed.buyerEmail,
    subject: productTitle
      ? `Quote request received: ${headerText(productTitle, 120)}`
      : `Your ${headerText(siteName(), 60)} sourcing request was received`,
    html: mailLayout({
      heading: 'We’ve got your request',
      body: [
        `Hi <span dir="auto">${escapeHtml(parsed.buyerName)}</span>, our team will review your request and send you an <strong>offer</strong> (price, terms and how long it is valid) ${escapeHtml(quoteTurnaroundPhrase())}.`,
        'Nothing is ordered until you accept that offer. You can accept or decline it from your dashboard.',
        productTitle ? mailP(`<strong>Product:</strong> <span dir="auto">${escapeHtml(productTitle)}</span>`) : parsed.productCategory ? mailP(`<strong>Request:</strong> <span dir="auto">${escapeHtml(parsed.productCategory)}</span>`) : '',
        mailP('<strong>What you wrote:</strong>'),
        quoteBlock,
      ].filter(Boolean),
      cta: { href: buyerCta, label: accessToken ? 'View / reply to your quote' : 'Open in dashboard' },
      footer: [
        ...(accessToken ? ['This is a private link tied to your request — keep it to yourself. Valid for 14 days.'] : []),
        `Reference: ${QUOTE_REF(created.id)}`,
      ],
    }),
  }, 'quotes:confirmation');

  // Notify assignee (seller or platform inbox). Imported sellers carry
  // placeholder addresses, so those go to the intake inbox. The request is
  // already saved: a failed staff notification must not fail the buyer's submit
  // (they'd see an error and resubmit, creating duplicates).
  // Sellers never learn who the buyer is (the platform mediates), so a seller copy
  // carries no buyer identity and links to the seller inbox; staff and intake
  // copies link to the admin workspace, which labels internal notes.
  const inbox = staffQuoteInbox(created);
  const assigneeLink = inbox.toSeller
    ? `${siteBase()}/app/seller/inbox/${created.id}`
    : `${siteBase()}/admin/quotes/${created.id}`;
  await sendInternalEmail({
    to: inbox.to,
    subject: productTitle
      ? `New quote request: ${headerText(productTitle, 120)}`
      : facilityLabel ? `New access request — ${headerText(facilityLabel, 120)}`
      : inbox.toSeller ? 'New sourcing request' : `New sourcing request from ${headerText(parsed.buyerName)}`,
    html: mailLayout({
      heading: created.product ? 'Quote request' : 'Sourcing request',
      body: [
        inbox.toSeller ? '' : `From <strong dir="auto">${escapeHtml(parsed.buyerName)}</strong> &lt;${escapeHtml(parsed.buyerEmail)}&gt;${parsed.companyName ? ` · <span dir="auto">${escapeHtml(parsed.companyName)}</span>` : ''}`,
        productTitle ? mailP(`<strong>Product:</strong> <span dir="auto">${escapeHtml(productTitle)}</span>`) : '',
        similarToProductId && parsed.productCategory ? mailP(`<strong>${escapeHtml(parsed.productCategory)}</strong> — the listed unit is sold or reserved; offer any matching unit.`) : '',
        facilityLabel ? mailP(`<strong>Facility:</strong> ${escapeHtml(facilityLabel)}`) : '',
        parsed.budget ? mailP(`<strong>Budget:</strong> <span dir="auto">${escapeHtml(parsed.budget)}</span>`) : '',
        parsed.timeframe ? mailP(`<strong>Timeframe:</strong> <span dir="auto">${escapeHtml(parsed.timeframe)}</span>`) : '',
        mailP('<strong>Description:</strong>'),
        quoteBlock,
      ].filter(Boolean),
      cta: { href: assigneeLink, label: inbox.toSeller ? 'Open in seller inbox' : 'Open in admin' },
    }),
  }, 'quotes:intake');

  await notifyAdmins(
    'New quote request',
    `${parsed.buyerName}: ${productTitle ?? parsed.productCategory ?? 'sourcing request'}`,
    `/admin/quotes/${created.id}`,
    'QUOTE_NEW',
  );

  await audit(
    'quote.submit',
    QUOTE_REF(created.id),
    `type=${customerType} buyer=${parsed.buyerEmail}${productId ? ` productId=${productId}` : ''}${similarToProductId ? ` similarTo=${similarToProductId}` : ''}${assignedToId ? ` assignee=${assignedToId}` : ''}`,
  );

  revalidatePath('/app/quotes');
  revalidatePath('/admin/quotes');
  return { id: created.id, accessToken };
}

const ReplyInput = z.object({
  sourcingRequestId: z.string().min(1),
  body: z.string().min(2).max(4000),
  // Only auth-gated proxy URLs are allowed. Plain S3 / external URLs are
  // refused so we never store a publicly-fetchable attachment reference.
  attachments: z
    .array(z.string().regex(/^\/api\/support-attachment\//, 'attachment must be auth-gated proxy URL'))
    .max(8)
    .optional(),
  /** Original file names, index-aligned with `attachments` (the stored keys are hashes). */
  attachmentNames: z.array(z.string().max(255)).max(8).optional(),
  // Admin/seller-only flag. Buyer cannot post internal notes — even if they
  // tried to inject `internal: '1'` the action would refuse (see check below).
  internal: z.boolean().optional(),
});

/** File names stored next to the attachment keys: one per attachment, '' when unknown. */
function attachmentNamesFor(attachments: string[], names: string[] | undefined): string[] {
  return attachments.map((_, i) => (names?.[i] ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[/\\]/g, '_').trim().slice(0, 200));
}

export async function replyToQuote(input: z.infer<typeof ReplyInput>): Promise<QuoteActionResult> {
  const result = ReplyInput.safeParse(input);
  if (!result.success) {
    const field = String(result.error.issues[0]?.path[0] ?? '');
    if (field === 'body') return { error: 'Write a reply of 2–4,000 characters.' };
    if (field === 'attachments') return { error: 'Some attachments could not be added. Remove them and attach the files again.' };
    return { error: 'This reply could not be sent. Reload the page and try again.' };
  }
  const parsed = result.data;
  const session = await requireSession({ redirectTo: '/app' });
  await ensureSettingsLoaded();

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: parsed.sourcingRequestId },
    select: {
      id: true, proformaNumber: true, priority: true,
      assignedToId: true, submittedById: true, buyerEmail: true, status: true,
      accessToken: true, accessTokenExpiresAt: true,
      assignedTo: { select: { email: true, role: true } },
    },
  });
  if (!sr) return { error: 'This quote no longer exists.' };

  const role = (session.user as { role?: string }).role;
  const isAdmin = role === 'ADMIN';
  const isAssignee = !!sr.assignedToId && sr.assignedToId === session.user.id;
  const isBuyer = !!sr.submittedById && sr.submittedById === session.user.id;
  const allowed = isAdmin || isAssignee || isBuyer;
  if (!allowed) return { error: 'You can no longer reply on this quote.' };

  // Capability gate — admins MUST hold quotes:reply. Buyers and assigned
  // sellers are gated by ownership instead (no cap needed).
  if (isAdmin && !isAssignee && !isBuyer) {
    await requireCapability('quotes:reply', { redirectTo: '/admin/quotes' });
  }

  // Internal notes: admin/seller only. Buyer flag is ignored.
  const wantsNote = !!parsed.internal && (isAdmin || isAssignee);
  const fromStaff = isAdmin || isAssignee;
  const now = new Date();
  const site = siteName();
  const attachments = parsed.attachments ?? [];
  const attachmentNames = attachmentNamesFor(attachments, parsed.attachmentNames);

  // Mediation (MESSAGE_MEDIATION_MODE): what a supplier writes to the buyer
  // never carries a way around the platform. MASK_CONTACTS removes e-mail
  // addresses, phone numbers, links and IBANs (the original stays as an
  // internal note for staff); STAFF_REVIEW holds the message as an internal
  // note until staff release it (releaseQuoteMessage). Staff are told in both.
  const bySupplier = isAssignee && !isAdmin && sr.assignedTo?.role === 'SELLER' && !wantsNote;
  const mediated = mediateSupplierMessage(bySupplier ? mediationMode() : 'OFF', parsed.body);
  const held = mediated.held;
  const masked = mediated.removed.length ? { kinds: mediated.removed } : null;
  const isInternalNote = wantsNote || held;
  const body = mediated.body;

  await prisma.quoteMessage.create({
    data: {
      sourcingRequestId: parsed.sourcingRequestId,
      body,
      authorId: session.user.id,
      attachments,
      attachmentNames,
      isInternalNote,
      fromStaff,
    },
  });
  if (masked) {
    await prisma.quoteMessage.create({
      data: {
        sourcingRequestId: parsed.sourcingRequestId,
        body: `Supplier message as written (only staff see this; the buyer got it with ${CONTACT_REMOVED} in place of ${contactKindsLabel(masked.kinds)}):\n\n${parsed.body}`.slice(0, 5000),
        authorId: session.user.id,
        isInternalNote: true,
        fromStaff: true,
      },
    });
  }
  if (masked || held) {
    const ref = quoteRefOrProforma(sr);
    await notifyAdmins(
      held ? `Supplier message to review — ${ref}` : `Contact details removed from a supplier message — ${ref}`,
      held
        ? 'The supplier wrote to the buyer. The message waits for your review (internal note) — release it to send it to the buyer.'
        : `The supplier's message reached the buyer without its ${contactKindsLabel(masked!.kinds)}. The original is kept as an internal note.`,
      `/admin/quotes/${sr.id}`,
      'SYSTEM',
    );
    if (held) {
      await sendInternalEmail({
        to: process.env.QUOTE_INTAKE_EMAIL ?? '',
        subject: `[${ref}] Supplier message to review`,
        html: mailLayout({
          heading: 'Supplier message to review',
          body: [
            `The supplier wrote to the buyer on quote <strong>${ref}</strong>. The buyer sees nothing until you release it:`,
            `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;">${escapeHtmlLines(parsed.body)}</blockquote>`,
          ],
          cta: { href: `${siteBase()}/admin/quotes/${sr.id}`, label: 'Review the message' },
        }),
      }, 'quotes:supplier-message-held');
    }
  }

  // Status + lastReplyAt updates — skip if internal note (the customer-visible
  // state shouldn't budge from a note).
  if (!isInternalNote) {
    const statusUpdate: { status?: 'RESPONDED' | 'PENDING' } = {};
    if (fromStaff && sr.status === 'PENDING') statusUpdate.status = 'RESPONDED';
    // SLA (QUOTE_SLA_HOURS): a staff reply stops the clock (the ball is with
    // the buyer); a buyer message on a live request restarts it.
    const live = sr.status === 'PENDING' || sr.status === 'RESPONDED';
    const sla = fromStaff
      ? { dueAt: null, slaBreachAt: null }
      : live ? { dueAt: computeQuoteDueAt(now, sr.priority), slaBreachAt: null } : {};
    await prisma.sourcingRequest.update({
      where: { id: parsed.sourcingRequestId },
      data: {
        lastReplyAt: now,
        lastReplyByStaff: fromStaff,
        ...sla,
        ...statusUpdate,
        // BUG-018: a buyer reply must resurface an archived quote to the admin
        // queue, otherwise the customer's message is hidden in Archived.
        ...(!fromStaff ? { archivedAt: null, archivedById: null } : {}),
      },
    });
  }

  // Email + in-app notify — never on internal notes. The reply is saved at this
  // point: an email failure is reported as a warning, never as "not sent".
  let warning: string | undefined;
  if (!isInternalNote) {
    if (fromStaff) {
      const sent = await emailBuyerNewReply(sr, site);
      if (!sent.ok) {
        warning = `Reply saved and visible to the buyer in their dashboard, but the email to ${isAdmin ? sr.buyerEmail : 'the buyer'} could not be delivered (${sent.error}).`;
      }
    } else {
      if (sr.assignedToId) {
        await notifyUser(
          sr.assignedToId,
          'Buyer replied on a quote',
          'The buyer responded. Open the quote to continue.',
          staffQuoteHref(sr),
        );
      }
      await notifyAdmins('Buyer replied on a quote', 'A buyer responded on a sourcing request.', `/admin/quotes/${sr.id}`);
      // Email whoever handles the quote, as the thread promises: a seller with a
      // real address, otherwise the intake inbox (imported sellers carry
      // placeholder addresses). Best-effort — the reply is already saved.
      const inbox = staffQuoteInbox(sr);
      await sendInternalEmail({
        to: inbox.to,
        subject: `[${quoteRefOrProforma(sr)}] The buyer replied on a quote`,
        html: mailLayout({
          heading: 'The buyer replied',
          body: [`The buyer replied on quote <strong>${quoteRefOrProforma(sr)}</strong>. Open the thread to read it and respond.`],
          cta: { href: inbox.toSeller ? `${siteBase()}/app/seller/inbox/${sr.id}` : `${siteBase()}/admin/quotes/${sr.id}`, label: 'Open the thread' },
        }),
      }, 'quotes:buyer-reply');
    }
  }

  await audit(
    held ? 'quote.reply.held' : isInternalNote ? 'quote.note.add' : 'quote.reply',
    quoteRefOrProforma(sr),
    `${session.user.email}${attachments.length ? ` +${attachments.length}attach` : ''}${masked ? ` · contact details removed (${masked.kinds.join(', ')})` : ''}`,
  );

  revalidatePath(`/app/quotes/${parsed.sourcingRequestId}`);
  revalidatePath(`/app/seller/inbox/${parsed.sourcingRequestId}`);
  revalidatePath(`/admin/quotes/${parsed.sourcingRequestId}`);
  revalidatePath('/admin/quotes');
  if (held) return { notice: `Sent to the ${site} team for review — the buyer sees your message once our team releases it.` };
  if (masked) {
    const note = `Reply sent. The ${contactKindsLabel(masked.kinds)} in it were removed — buyers deal with ${site} only.`;
    return warning ? { warning: `${note} ${warning}` } : { notice: note };
  }
  return warning ? { warning } : {};
}

/** "New reply on your quote" to the buyer (mail + in-app). The reply is saved already. */
async function emailBuyerNewReply(
  sr: { id: string; proformaNumber: string | null; buyerEmail: string; submittedById: string | null; accessToken: string | null },
  site: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sent = await trySendEmail({
    to: sr.buyerEmail,
    subject: `[${quoteRefOrProforma(sr)}] New reply on your ${headerText(site, 60)} quote`,
    html: mailLayout({
      heading: 'New reply on your quote',
      body: [`We replied to your quote request <strong>${quoteRefOrProforma(sr)}</strong>.`],
      cta: { href: buyerQuoteLink(sr), label: 'Read the reply' },
    }),
  }, 'quotes:reply');
  if (sr.submittedById) {
    await notifyUser(sr.submittedById, 'New reply on your quote', 'We replied to your quote request.', `/app/quotes/${sr.id}`);
  }
  return sent.ok ? { ok: true } : { ok: false, error: sent.error };
}

/**
 * Staff release a supplier message held for review (MESSAGE_MEDIATION_MODE =
 * STAFF_REVIEW): it becomes a normal reply in the thread and the buyer is
 * told. Guarded on the message still being held (no double release).
 */
export async function releaseQuoteMessage(messageId: string): Promise<QuoteActionResult> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:reply', { redirectTo: '/admin/quotes' });
  await ensureSettingsLoaded();
  const m = await prisma.quoteMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true, body: true, isInternalNote: true, sourcingRequestId: true,
      sourcingRequest: { select: { id: true, proformaNumber: true, status: true, buyerEmail: true, submittedById: true, accessToken: true } },
    },
  });
  if (!m) return { error: 'This message no longer exists.' };
  if (!m.isInternalNote || !m.body.startsWith(HELD_SUPPLIER_MESSAGE_PREFIX)) return { error: 'This message is not waiting for review (already released?). Reload the page.' };
  const claim = await prisma.quoteMessage.updateMany({
    where: { id: m.id, isInternalNote: true, body: { startsWith: HELD_SUPPLIER_MESSAGE_PREFIX } },
    data: { isInternalNote: false, body: m.body.slice(HELD_SUPPLIER_MESSAGE_PREFIX.length) },
  });
  if (claim.count !== 1) return { error: 'This message was released a moment ago. Reload the page.' };
  const sr = m.sourcingRequest;
  const now = new Date();
  await prisma.sourcingRequest.update({
    where: { id: sr.id },
    data: { lastReplyAt: now, lastReplyByStaff: true, dueAt: null, slaBreachAt: null, ...(sr.status === 'PENDING' ? { status: 'RESPONDED' } : {}) },
  });
  const sent = await emailBuyerNewReply(sr, siteName());
  await audit('quote.reply.release', quoteRefOrProforma(sr), `${messageId} by ${session.user.email}`);
  revalidatePath(`/app/quotes/${sr.id}`);
  revalidatePath(`/app/seller/inbox/${sr.id}`);
  revalidatePath(`/admin/quotes/${sr.id}`);
  return sent.ok
    ? { notice: 'Message released — the buyer was emailed.' }
    : { warning: `Message released and visible to the buyer, but the email to ${sr.buyerEmail} could not be delivered (${sent.error}).` };
}

// ────────────────────────────────────────────────────────────────────────────
//   Offer → acceptance
// ────────────────────────────────────────────────────────────────────────────

const OfferInput = z.object({
  sourcingRequestId: z.string().min(1),
  /** Unit price (excl. VAT). For a supplier: their price to us. */
  priceCents: z.number().int().positive().max(2_000_000_000),
  qty: z.number().int().min(1).max(999).default(1),
  currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
  /** Freight / crating / insurance for this deal (excl. VAT). */
  shippingCents: z.number().int().min(0).max(2_000_000_000).default(0),
  note: z.string().max(2000).optional().nullable(),
  /** Last day the buyer can accept (YYYY-MM-DD, UTC). Default: today + OFFER_VALID_DAYS. */
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  incoterm: z.string().max(3).optional().nullable(),
  incotermPlace: z.string().max(120).optional().nullable(),
  leadTime: z.string().max(200).optional().nullable(),
  warranty: z.string().max(200).optional().nullable(),
  /** Payment term after acceptance (days). Default: PAYMENT_TERM_DAYS. */
  paymentDays: z.number().int().min(1).max(120).optional().nullable(),
  // The offered item (offerTerms; printed on the order line, proforma and invoice).
  itemTitle: z.string().max(200).optional().nullable(),
  itemDescription: z.string().max(4000).optional().nullable(),
  itemCondition: z.enum(['NEW', 'REFURBISHED', 'USED']).optional().nullable(),
  itemSerial: z.string().max(120).optional().nullable(),
  /** ISO country the offer is priced for (freight, VAT). Default: the Incoterm place of a C/D-term; required with freight. */
  destinationCountry: z.string().regex(/^([A-Za-z]{2})?$/).optional().nullable(),
  /** Staff only: offer a listing that is not published (draft / under review / archived) — audited. */
  allowUnpublished: z.boolean().optional(),
});

class OfferRaceError extends Error {}
class OfferBlockedError extends Error {}

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

function offerMailRows(o: {
  qty: number; unitCents: number; goodsCents: number; shippingCents: number; vatDecided: boolean; vatRateBp: number | null;
  vatCents: number | null; vatLabel: string | null; totalCents: number; currency: string;
}): string {
  const m = (c: number) => escapeHtml(formatPrice(c, o.currency));
  const rows: Array<[string, string, boolean?]> = [];
  rows.push([o.qty > 1 ? `Price (${o.qty} × ${m(o.unitCents)})` : 'Price', m(o.goodsCents)]);
  if (o.shippingCents > 0) rows.push(['Freight / shipping', m(o.shippingCents)]);
  if (o.vatDecided) rows.push([`VAT ${pctLabel(o.vatRateBp)}${o.vatLabel ? ` <span style="color:#6b7280;font-size:12px;">(${escapeHtml(o.vatLabel)})</span>` : ''}`, m(o.vatCents ?? 0)]);
  else rows.push(['VAT', '<span style="color:#6b7280;">determined from your billing details when you accept</span>']);
  rows.push([o.vatDecided ? 'Total' : 'Total excl. VAT', m(o.totalCents), true]);
  return mailTable(rows);
}

function termsMailRows(t: OfferTerms, validUntil: Date): string {
  const rows: Array<[string, string]> = [];
  const inc = incotermLabel(t);
  if (inc) rows.push(['Delivery terms', escapeHtml(inc)]);
  if (t.leadTime) rows.push(['Lead time', `<span dir="auto">${escapeHtml(t.leadTime)}</span>`]);
  if (t.warranty) rows.push(['Warranty', `<span dir="auto">${escapeHtml(t.warranty)}</span>`]);
  rows.push(['Payment', escapeHtml(t.paymentTerms.text)]);
  rows.push(['Valid until', `<strong>${escapeHtml(fmtDay(validUntil))}</strong>`]);
  return mailTable(rows);
}

type OfferCtx = {
  sr: NonNullable<Awaited<ReturnType<typeof loadQuoteForOffer>>>;
  actorId: string;
  actorEmail: string;
  isAdmin: boolean;
  unitCents: number;
  qty: number;
  currency: string;
  shippingCents: number;
  note: string | null;
  validUntil: Date;
  incoterm: string | null;
  incotermPlace: string | null;
  leadTime: string | null;
  warranty: string | null;
  paymentDays: number;
  /** Supplier cost behind this offer (from a proposal / a direct supplier offer). */
  supplierCostCents: number | null;
  /** The supplier proposal this offer approves. */
  approvesProposal: boolean;
  /** Sent by the supplier with review off (their price + margin). */
  bySupplierDirect: boolean;
  /** What is offered and where to (offerTerms). */
  item: OfferItem;
};

async function loadQuoteForOffer(id: string) {
  return prisma.sourcingRequest.findUnique({
    where: { id },
    include: {
      product: { select: { id: true, title: true, vatScheme: true, status: true } },
      assignedTo: { select: { id: true, email: true, role: true } },
    },
  });
}

/**
 * Publish (or update) the offer the buyer sees: snapshot the amounts and terms,
 * decide the VAT from the buyer's saved billing details (or defer it to
 * acceptance), hold the unit when STOCK_RESERVE_ON = OFFER_SENT, notify.
 */
async function publishOffer(c: OfferCtx): Promise<QuoteActionResult> {
  const { sr } = c;
  const now = new Date();
  const site = siteName();
  const goodsCents = c.unitCents * c.qty;
  const itemTitle = offerItemTitle({ offerTerms: { itemTitle: c.item.itemTitle }, product: sr.product, productCategory: sr.productCategory });
  const money = (x: number) => formatPrice(x, c.currency);

  // A listing that is not published (draft, under review, archived) is not on
  // sale: staff offer it only with the explicit override (kept on the offer, so
  // the buyer can accept it, and audited).
  if (sr.product && sr.product.status !== 'PUBLISHED' && !c.item.allowUnpublished) {
    return {
      error: c.isAdmin
        ? `This listing is not published (${sr.product.status.toLowerCase().replace(/_/g, ' ')}), so the buyer could not accept the offer. Publish it first, or tick “Offer although the listing is not published”.`
        : `This listing is not published, so no offer can be sent on it. Ask the ${site} team.`,
    };
  }

  // The listed unit must be available (not sold, not held for someone else).
  const mode = stockReserveOn();
  if (sr.productId && mode !== 'PAYMENT_VERIFIED') {
    const av = await unitAvailability(sr.productId, sr.id);
    if (av && !av.heldByThisQuote && av.quantity < c.qty) {
      const other = av.otherHolds[0];
      return {
        error: `The listed unit is not available right now (${av.quantity} in stock${other ? ` — reserved for ${other.orderNumber ? `order ${other.orderNumber}` : other.quoteRef ?? 'another deal'}` : ' — sold'}). The buyer could not accept this offer. Wait until the hold ends, or restock the listing first.`,
      };
    }
  }

  // VAT at send time (buyer's saved billing details) — never inside the transaction.
  const vat = await offerVatAtSend(sr.submittedById, { goodsCents, shippingCents: c.shippingCents, scheme: sr.product?.vatScheme ?? null });
  const d = vat.decision;
  const vatCents = d ? d.taxCents : null;
  const totalCents = goodsCents + c.shippingCents + (vatCents ?? 0);
  // A re-quote after a decline is an updated offer too (revision + 1, "Updated offer").
  const reopening = sr.status === 'DECLINED';
  const previousAmounts = (sr.status === 'RESPONDED' || reopening) && sr.quotedPriceCents != null ? offerAmounts(sr) : null;
  const isUpdate = !!previousAmounts;
  const terms: OfferTerms & OfferItem = {
    v: 1,
    qty: c.qty,
    unitCents: c.unitCents,
    incoterm: c.incoterm,
    incotermPlace: c.incoterm ? c.incotermPlace : null,
    leadTime: c.leadTime,
    warranty: c.warranty,
    paymentTerms: { kind: 'PREPAY', days: c.paymentDays, text: fillPaymentTermsText(offerDefaults().paymentTermsText, c.paymentDays) },
    vatBasis: vat.basis,
    previous: previousAmounts
      ? { totalCents: previousAmounts.vatDecided ? previousAmounts.totalCents : null, netCents: previousAmounts.netCents, currency: sr.quotedCurrency || 'EUR' }
      : null,
    ...c.item,
  };
  const linked = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: { id: true, orderNumber: true, status: true, paymentSubmittedAt: true, adminNotes: true },
  });
  const holdDays = openOfferHoldDays();
  const holdUntil = holdDays ? new Date(Math.min(c.validUntil.getTime(), now.getTime() + holdDays * 86_400_000)) : c.validUntil;

  let detachedOrder: string | null = null;
  let detachedWasPayable = false;
  const nextRevision = (sr.offerRevision ?? 0) + 1;
  try {
    await prisma.$transaction(async (tx) => {
      // Guarded write: a buyer who accepted / declined in the meantime wins
      // (a declined quote is re-opened only when it was declined when we read it).
      const claim = await tx.sourcingRequest.updateMany({
        where: { id: sr.id, status: { in: reopening ? ['DECLINED'] : ['PENDING', 'RESPONDED'] }, offerRevision: sr.offerRevision },
        data: {
          ...(reopening ? { lostReason: null, lostNote: null, archivedAt: null, archivedById: null } : {}),
          quotedPriceCents: goodsCents,
          quotedCurrency: c.currency,
          quotedNote: c.note,
          quotedAt: now,
          validUntilAt: c.validUntil,
          status: 'RESPONDED',
          offerRevision: nextRevision,
          offerSubtotalCents: goodsCents,
          offerShippingCents: c.shippingCents,
          offerVatTreatment: d ? d.treatment : null,
          offerVatRateBp: d ? d.rateBp : null,
          offerVatCents: vatCents,
          offerTotalCents: d ? totalCents : null,
          offerTerms: terms as unknown as Prisma.InputJsonValue,
          offerSupplierCostCents: c.supplierCostCents,
          ...(c.approvesProposal ? { sellerProposalStatus: 'APPROVED' } : {}),
          // No proforma exists before acceptance (clears legacy auto-issued ones).
          proformaNumber: null,
          proformaIssuedAt: null,
          paymentInstructionsSnapshot: null,
          lastReplyAt: now,
          lastReplyByStaff: true,
          // The ball is with the buyer now: the reply SLA stops.
          dueAt: null,
          slaBreachAt: null,
        },
      });
      if (claim.count !== 1) throw new OfferRaceError();
      // Each revision gets its own expiry reminders and staff alert (and a new
      // "unit sold" notice): the sweep's claims are per quote, so the ones of
      // the previous revision are cleared with the new offer.
      await tx.reminderLog.deleteMany({ where: { subjectType: 'QUOTE', subjectId: sr.id, kind: { in: ['OFFER_EXPIRING', 'OFFER_EXPIRED_STAFF', 'UNIT_SOLD'] } } });
      if (linked) {
        // Legacy auto-created order (unpaid, no proof) or a canceled one: it
        // must not stay payable at the old price — cancel it and unlink it so
        // acceptance creates the order for THIS offer.
        if (linked.status === 'PENDING_PAYMENT') {
          const cancel = await tx.order.updateMany({
            where: { id: linked.id, status: 'PENDING_PAYMENT', paymentSubmittedAt: null },
            data: { status: 'CANCELED' },
          });
          if (cancel.count !== 1) throw new OfferBlockedError(`A payment proof was just submitted for order ${linked.orderNumber}. Verify or reject it before sending a new offer.`);
        }
        await tx.order.update({
          where: { id: linked.id },
          data: {
            sourcingRequestId: null,
            adminNotes: `${linked.adminNotes ? `${linked.adminNotes}\n` : ''}[${isoDay(now)}] Unlinked from quote ${QUOTE_REF(sr.id)}: a new offer was sent (${linked.status === 'CANCELED' ? 'this order was canceled' : 'the order was created by the old auto-accept flow and never paid'}).`.slice(0, 4000),
          },
        });
        detachedOrder = linked.orderNumber;
        detachedWasPayable = linked.status === 'PENDING_PAYMENT';
      }
      if (sr.productId && mode === 'OFFER_SENT') {
        const hold = await holdUnitForQuote(tx, { quoteId: sr.id, productId: sr.productId, qty: c.qty, expiresAt: holdUntil });
        if (!hold.ok) throw new OfferBlockedError(`The listed unit could not be reserved for this offer: ${hold.message}`);
      }
      await tx.quoteMessage.create({
        data: {
          sourcingRequestId: sr.id,
          // The offer is the platform's (a supplier sending directly priced it,
          // but the buyer price incl. margin is ours): no supplier as author.
          authorId: c.bySupplierDirect ? null : c.actorId,
          fromStaff: true,
          body: [
            `${isUpdate ? 'Updated offer' : 'Offer'} (revision ${nextRevision}) for "${itemTitle}": ${c.qty > 1 ? `${c.qty} × ${money(c.unitCents)} = ` : ''}${money(goodsCents)}${c.shippingCents ? ` + freight ${money(c.shippingCents)}` : ''} excl. VAT${d ? `; VAT ${pctLabel(d.rateBp)}: ${money(vatCents ?? 0)}; total ${money(totalCents)}` : '; VAT is determined from your billing details when you accept'}. Valid until ${fmtDay(c.validUntil)}.`,
            [c.item.itemCondition ? `Condition: ${c.item.itemCondition.toLowerCase()}` : '', c.item.itemSerial ? `Serial number: ${c.item.itemSerial}` : '', c.item.destinationCountry ? `Priced for delivery to ${c.item.destinationCountry}` : ''].filter(Boolean).join(' · '),
            c.item.itemDescription ?? '',
            isUpdate && previousAmounts ? `Previous offer: ${formatPrice(previousAmounts.vatDecided ? previousAmounts.totalCents : previousAmounts.netCents, sr.quotedCurrency || 'EUR')}${previousAmounts.vatDecided ? '' : ' excl. VAT'}.` : '',
            [incotermLabel(terms), terms.leadTime ? `Lead time: ${terms.leadTime}` : '', terms.warranty ? `Warranty: ${terms.warranty}` : '', terms.paymentTerms.text].filter(Boolean).join(' · '),
            'Accept or decline it at the top of this page. Nothing is ordered until you accept.',
            c.note ? `\nNote: ${c.note}` : '',
          ].filter(Boolean).join('\n'),
        },
      });
    });
  } catch (e) {
    if (e instanceof OfferBlockedError) return { error: e.message };
    if (e instanceof OfferRaceError) {
      const fresh = await prisma.sourcingRequest.findUnique({ where: { id: sr.id }, select: { status: true } });
      return {
        error: fresh?.status === 'ACCEPTED'
          ? 'The buyer accepted the current offer a moment ago, so its price can no longer be changed. Reload the page to see the order.'
          : 'This quote changed while you were sending the offer. Reload the page and try again.',
      };
    }
    throw e;
  }

  // ─── After commit: notify (never fatal) ───
  const buyerLink = buyerQuoteLink(sr);
  const itemRows: Array<[string, string]> = [];
  if (c.item.itemCondition) itemRows.push(['Condition', escapeHtml(c.item.itemCondition.charAt(0) + c.item.itemCondition.slice(1).toLowerCase())]);
  if (c.item.itemSerial) itemRows.push(['Serial number', `<span dir="auto">${escapeHtml(c.item.itemSerial)}</span>`]);
  if (c.item.destinationCountry) itemRows.push(['Priced for delivery to', escapeHtml((await checkCountry(c.item.destinationCountry)).name ?? c.item.destinationCountry)]);
  // The quotation PDF of this revision (a document a purchasing office can raise a PO on), when one exists.
  const quotation = await quotationAttachment(sr.id).catch(async (e) => { await logError('quotes:quotation-pdf', e); return null; });
  const amounts = {
    qty: c.qty, unitCents: c.unitCents, goodsCents, shippingCents: c.shippingCents, vatDecided: !!d, vatRateBp: d?.rateBp ?? null,
    vatCents, vatLabel: d ? vatTreatmentLabel(d.treatment) : null, totalCents, currency: c.currency,
  };
  const prevLine = isUpdate && previousAmounts
    ? `<p style="margin:0 0 12px;color:#4b5563;">Previous offer: <s>${escapeHtml(formatPrice(previousAmounts.vatDecided ? previousAmounts.totalCents : previousAmounts.netCents, sr.quotedCurrency || 'EUR'))}${previousAmounts.vatDecided ? '' : ' excl. VAT'}</s></p>`
    : '';
  const sent = await trySendEmail({
    to: sr.buyerEmail,
    subject: `[${QUOTE_REF(sr.id)}] ${isUpdate ? 'Updated offer' : 'Your offer'} for ${headerText(itemTitle, 90)}: ${money(totalCents)}${d ? '' : ' excl. VAT'}`,
    html: mailLayout({
      heading: isUpdate ? 'Your offer was updated' : 'Your offer is ready',
      body: [
        `Hi <span dir="auto">${escapeHtml(sr.buyerName)}</span>,`,
        `${isUpdate ? 'We updated our offer' : 'Here is our offer'} for <strong dir="auto">${escapeHtml(itemTitle)}</strong>:`,
        c.item.itemDescription ? `<p dir="auto" style="margin:0 0 12px;color:#374151;">${escapeHtmlLines(c.item.itemDescription)}</p>` : '',
        itemRows.length ? mailTable(itemRows) : '',
        offerMailRows(amounts),
        prevLine,
        termsMailRows(terms, c.validUntil),
        c.note ? `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;color:#374151;">${escapeHtmlLines(c.note)}</blockquote>` : '',
        quotation ? 'The quotation is attached as a PDF (for your purchase order).' : '',
      ].filter(Boolean),
      cta: { href: buyerLink, label: 'Review and accept the offer' },
      footer: [
        'Nothing is ordered yet. When you accept, you confirm your billing and delivery details; we then create your order and email you the proforma invoice (PDF) with the bank details.',
        `This offer is subject to our <a href="${escapeHtml(termsOfSaleHref(siteBase()))}">General Terms of Sale</a> · Reference ${QUOTE_REF(sr.id)}`,
      ],
    }),
    attachments: quotation ? [quotation] : [],
  }, 'quotes:offer');

  await notifyUser(
    sr.submittedById,
    `${isUpdate ? 'Updated offer' : 'New offer'} — ${money(totalCents)}${d ? '' : ' excl. VAT'}`,
    `For "${itemTitle}", valid until ${fmtDay(c.validUntil)}. Review it and accept or decline.`,
    `/app/quotes/${sr.id}`,
  );
  await notifyAdmins(
    `${isUpdate ? 'Offer updated' : 'Offer sent'} — ${QUOTE_REF(sr.id)}`,
    `${itemTitle} · ${money(totalCents)}${d ? '' : ' excl. VAT'} · valid until ${isoDay(c.validUntil)}${c.supplierCostCents != null ? ` · supplier price ${formatPrice(c.supplierCostCents, c.currency)}` : ''}${sent.ok ? '' : ' · email to the buyer FAILED'}`,
    `/admin/quotes/${sr.id}`,
    'QUOTE_APPROVED',
  );
  if ((c.approvesProposal || c.bySupplierDirect) && sr.assignedToId && sr.assignedTo?.role === 'SELLER') {
    await notifyUser(
      sr.assignedToId,
      `Offer sent to the buyer — ${QUOTE_REF(sr.id)}`,
      `${site} sent the buyer an offer based on your price for "${itemTitle}". You will be notified when the buyer decides.`,
      `/app/seller/inbox/${sr.id}`,
    );
  }
  await audit(
    isUpdate ? 'quote.offer.update' : 'quote.offer.send',
    QUOTE_REF(sr.id),
    `r${nextRevision}${reopening ? ' (re-quote after decline)' : ''} · ${itemTitle} · ${c.qty}×${money(c.unitCents)} + freight ${money(c.shippingCents)}${c.item.destinationCountry ? ` to ${c.item.destinationCountry}` : ''} · vat=${d ? `${d.treatment} ${pctLabel(d.rateBp)}` : 'at acceptance'} · total ${money(totalCents)} · validUntil=${isoDay(c.validUntil)}${previousAmounts ? ` · was ${formatPrice(previousAmounts.totalCents, sr.quotedCurrency || 'EUR')}` : ''}${c.supplierCostCents != null ? ` · supplier ${formatPrice(c.supplierCostCents, c.currency)}` : ''}${c.item.allowUnpublished && sr.product?.status !== 'PUBLISHED' ? ` · OVERRIDE: listing not published (${sr.product?.status ?? '?'})` : ''}${detachedOrder ? ` · unlinked order ${detachedOrder}` : ''}${quotation ? ' · quotation PDF attached' : ''}${sent.ok ? '' : ` · buyer email failed: ${sent.error}`} · by ${c.actorEmail}`,
  );

  revalidatePath(`/app/quotes/${sr.id}`);
  revalidatePath(`/app/seller/inbox/${sr.id}`);
  revalidatePath(`/admin/quotes/${sr.id}`);
  revalidatePath('/admin/quotes');
  revalidatePath('/app/quotes');

  // Sellers never see the buyer's address — nor, unless SELLER_SEES_SELL_PRICE,
  // the buyer price (their price plus our margin).
  const who = c.isAdmin ? sr.buyerEmail : 'the buyer';
  const what = c.bySupplierDirect && !sellerSeesSellPrice()
    ? `Offer sent to the buyer based on your price ${money(c.supplierCostCents ?? goodsCents)} (excl. VAT), valid until ${fmtDay(c.validUntil)}.`
    : `${isUpdate ? 'Offer updated' : 'Offer sent'}: ${money(totalCents)}${d ? '' : ' excl. VAT (VAT at acceptance)'}, valid until ${fmtDay(c.validUntil)}.`;
  if (!sent.ok) {
    return { warning: `${what} It is saved and the buyer sees it in their dashboard, but the email to ${who} could not be delivered (${sent.error}).` };
  }
  return { notice: `${what} Emailed to ${who}${detachedOrder ? `; ${detachedWasPayable ? `old unpaid order ${detachedOrder} was canceled` : `canceled order ${detachedOrder} was unlinked`}` : ''}.` };
}

/**
 * Staff / assigned supplier "Send offer". Staff publish the offer to the buyer.
 * A supplier's price is a PROPOSAL to the team when SELLER_OFFERS_REQUIRE_APPROVAL
 * is on (staff review it and add the margin); with review off it goes to the
 * buyer at the supplier price + SELLER_OFFER_MARKUP_PCT. No order or proforma
 * exist until the buyer accepts; after acceptance the price is locked.
 */
export async function sendOffer(input: z.input<typeof OfferInput>): Promise<QuoteActionResult> {
  const result = OfferInput.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = String(issue?.path[0] ?? '');
    if (field === 'priceCents') return { error: issue?.code === 'too_big' ? `The maximum offer amount is ${formatPrice(offerMaxCents())}.` : 'Enter a price above zero.' };
    if (field === 'qty') return { error: 'Quantity must be a whole number from 1 to 999.' };
    if (field === 'shippingCents') return { error: `Freight must be zero or more (max ${formatPrice(offerMaxCents())}).` };
    if (field === 'currency') return { error: 'Choose a currency.' };
    if (field === 'note') return { error: 'The note is too long (max 2,000 characters).' };
    if (field === 'validUntil') return { error: 'Enter a valid "valid until" date.' };
    if (field === 'paymentDays') return { error: 'The payment term must be 1–120 days.' };
    if (field === 'leadTime' || field === 'warranty' || field === 'incotermPlace') return { error: 'Lead time, warranty and place can have at most 200 characters.' };
    if (field === 'itemTitle') return { error: 'The item title can have at most 200 characters.' };
    if (field === 'itemDescription') return { error: 'The item description can have at most 4,000 characters.' };
    if (field === 'itemSerial') return { error: 'The serial number can have at most 120 characters.' };
    if (field === 'itemCondition') return { error: 'Choose the condition: new, refurbished or used.' };
    if (field === 'destinationCountry') return { error: 'Choose the destination country.' };
    return { error: 'This offer could not be sent. Check the fields and try again.' };
  }
  const p = result.data;
  await ensureSettingsLoaded();
  const session = await requireSession({ redirectTo: '/app' });
  // Settings → Quotes & offers → Largest offer amount (a typing error such as an extra zero).
  const maxOffer = offerMaxCents();
  if (p.priceCents * p.qty > maxOffer) return { error: `The maximum offer amount is ${formatPrice(maxOffer, p.currency)} (goods; Settings → Quotes & offers).` };
  if (p.shippingCents > maxOffer) return { error: `Freight must be at most ${formatPrice(maxOffer, p.currency)}.` };

  const sr = await loadQuoteForOffer(p.sourcingRequestId);
  if (!sr) return { error: 'This quote no longer exists.' };

  const role = (session.user as { role?: string }).role;
  const isAdmin = role === 'ADMIN';
  const isAssignee = !!sr.assignedToId && sr.assignedToId === session.user.id;
  if (!isAdmin && !isAssignee) return { error: 'You are not allowed to send an offer on this quote.' };
  // Admin path needs the explicit cap (kept as `quotes:proforma` for existing
  // role presets). The assigned seller is gated by ownership.
  if (isAdmin && !isAssignee) {
    await requireCapability('quotes:proforma', { redirectTo: '/admin/quotes' });
  }
  const currencies = offerCurrencies();
  if (!currencies.includes(p.currency)) return { error: `Choose one of: ${currencies.join(', ')}.` };

  // ─── Price lock after acceptance ───
  // A declined offer (or an expired one) is re-quoted on the same request; a
  // closed request or an accepted one (its order is binding, Order.sourcingRequestId
  // is unique) gets a new request for the same buyer: “New quote for this buyer”.
  if (sr.status === 'ACCEPTED') {
    const o = await prisma.order.findUnique({ where: { sourcingRequestId: sr.id }, select: { orderNumber: true, status: true } });
    if (o?.status === 'CANCELED') {
      return { error: `The accepted order ${o.orderNumber} was canceled, so this quote is finished. Use “New quote for this buyer” to send the buyer a new offer.` };
    }
    return {
      error: `The buyer already accepted this offer${o ? ` (order ${o.orderNumber}` : ''}${sr.proformaNumber ? `${o ? ', ' : ' ('}proforma ${sr.proformaNumber})` : o ? ')' : ''}, so its price can no longer be changed. Cancel that order first (“Cancel order” in the Deal panel), then use “New quote for this buyer”.`,
    };
  }
  if (sr.status === 'CLOSED') {
    return { error: isAdmin ? 'This request is closed. Use “New quote for this buyer” to start a new request for the same buyer and send the offer there.' : `This request is closed. Ask the ${siteName()} team if the buyer should get a new offer.` };
  }

  // A legacy quote (old flow) may carry an order the old code auto-created. A
  // paid one or one with a payment proof is a real sale — handled on the order.
  const linked = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: { orderNumber: true, status: true, paymentSubmittedAt: true },
  });
  if (linked && (PAID_ORDER_STATES.includes(linked.status) || linked.status === 'REFUNDED' || (linked.status === 'PENDING_PAYMENT' && linked.paymentSubmittedAt))) {
    return {
      error: `Order ${linked.orderNumber} already has a payment${linked.status === 'PENDING_PAYMENT' ? ' proof waiting for verification' : ` (${linked.status.toLowerCase().replace(/_/g, ' ')})`}. Manage it on the order page instead of sending a new offer.`,
    };
  }

  const now = new Date();
  const defaults = offerDefaults();
  const validUntil = p.validUntil ? endOfDayUtc(new Date(`${p.validUntil}T00:00:00Z`)) : daysFrom(now, defaults.validDays);
  if (validUntil.getTime() < now.getTime()) return { error: 'The "valid until" date must be today or later.' };
  if (validUntil.getTime() > now.getTime() + 366 * 86_400_000) return { error: 'An offer can be valid for at most one year.' };
  const incoterms = offerIncoterms();
  const incoterm = clean(p.incoterm)?.toUpperCase() ?? null;
  if (incoterm && !incoterms.includes(incoterm)) return { error: `Choose one of the Incoterms: ${incoterms.join(', ')}.` };

  // ─── Supplier (assigned seller, not staff) ───
  const supplier = isAssignee && !isAdmin;
  if (supplier && sellerOffersRequireApproval()) {
    return submitSellerProposal(sr, session.user.id, {
      priceCents: p.priceCents * p.qty, currency: p.currency, note: clean(p.note), leadTime: clean(p.leadTime), warranty: clean(p.warranty),
    });
  }
  const finalIncoterm = supplier ? incoterm ?? defaults.incoterm : incoterm;
  const finalPlace = supplier ? clean(p.incotermPlace) ?? defaults.incotermPlace : clean(p.incotermPlace);
  const item = await offerItemFrom(sr, p, { incoterm: finalIncoterm, place: finalPlace, staff: isAdmin });
  if ('error' in item) return { error: item.error };

  if (supplier) {
    // Review off: the buyer gets the supplier price + our margin.
    const sellUnit = applyMarkup(p.priceCents, sellerMarkupBp(), sellerPriceRounding());
    return publishOffer({
      sr, actorId: session.user.id, actorEmail: session.user.email, isAdmin: false,
      unitCents: sellUnit, qty: p.qty, currency: p.currency, shippingCents: p.shippingCents, note: clean(p.note), validUntil,
      incoterm: finalIncoterm, incotermPlace: finalPlace,
      leadTime: clean(p.leadTime) ?? clean(defaults.leadTime), warranty: clean(p.warranty),
      paymentDays: p.paymentDays ?? defaults.paymentTermDays,
      supplierCostCents: p.priceCents * p.qty, approvesProposal: false, bySupplierDirect: true, item,
    });
  }

  const proposalPending = sr.sellerProposalStatus === 'PENDING' && sr.sellerProposalCents != null;
  return publishOffer({
    sr, actorId: session.user.id, actorEmail: session.user.email, isAdmin,
    unitCents: p.priceCents, qty: p.qty, currency: p.currency, shippingCents: p.shippingCents, note: clean(p.note), validUntil,
    incoterm: finalIncoterm, incotermPlace: finalPlace, leadTime: clean(p.leadTime), warranty: clean(p.warranty),
    paymentDays: p.paymentDays ?? defaults.paymentTermDays,
    // A pending supplier proposal is approved by this offer (its cost is the margin basis).
    supplierCostCents: proposalPending ? sr.sellerProposalCents : sr.offerSupplierCostCents ?? null,
    approvesProposal: proposalPending, bySupplierDirect: false, item,
  });
}

/**
 * The item part of an offer: title / description / condition / serial (the
 * title is required when the request has no listing of its own — "Let us find
 * it" or "similar to …" — since it becomes the goods line of the proforma and
 * the invoice), and the destination country it is priced for: as chosen, else
 * the Incoterm place of a C/D-term ("DAP Berlin, DE"); required with freight.
 */
async function offerItemFrom(
  sr: { productId: string | null; similarToProductId: string | null; product: { title: string } | null },
  p: { itemTitle?: string | null; itemDescription?: string | null; itemCondition?: OfferItem['itemCondition']; itemSerial?: string | null; destinationCountry?: string | null; allowUnpublished?: boolean; shippingCents: number },
  ctx: { incoterm: string | null; place: string | null; staff: boolean },
): Promise<OfferItem | { error: string }> {
  const title = clean(p.itemTitle) ? decodeEntities(clean(p.itemTitle)!).replace(/\s+/g, ' ').trim() : null;
  if (!title && (!sr.productId || sr.similarToProductId)) {
    return { error: 'Enter the item title (make, model, year) — it is printed on the proforma and the invoice.' };
  }
  let destination = clean(p.destinationCountry)?.toUpperCase() ?? null;
  if (destination === 'UK') destination = 'GB';
  if (!destination && ctx.incoterm && ctx.place) {
    const names = new Map((await countryOptions()).map((c) => [c.name.trim().toLowerCase(), c.code]));
    destination = destinationFromPlace(ctx.incoterm, ctx.place, (n) => names.get(n.trim().toLowerCase()) ?? null);
  }
  if (!destination && p.shippingCents > 0) {
    return { error: 'Choose the destination country: the freight in this offer is priced for it (the buyer can accept only with delivery there).' };
  }
  if (destination) {
    const c = await checkCountry(destination);
    if (c.mode === 'BLOCK') return { error: `We do not deliver to ${c.name ?? destination}: ${c.reason}` };
  }
  return {
    itemTitle: title,
    itemDescription: clean(p.itemDescription),
    itemCondition: p.itemCondition ?? null,
    itemSerial: clean(p.itemSerial),
    destinationCountry: destination,
    allowUnpublished: ctx.staff && p.allowUnpublished === true,
  };
}

/** A supplier's price goes to the team for review (A30) — the buyer sees nothing yet. */
async function submitSellerProposal(
  sr: NonNullable<Awaited<ReturnType<typeof loadQuoteForOffer>>>,
  sellerId: string,
  p: { priceCents: number; currency: string; note: string | null; leadTime: string | null; warranty: string | null },
): Promise<QuoteActionResult> {
  const now = new Date();
  const claim = await prisma.sourcingRequest.updateMany({
    where: { id: sr.id, status: { in: ['PENDING', 'RESPONDED', 'DECLINED'] } },
    data: {
      sellerProposalStatus: 'PENDING',
      sellerProposalCents: p.priceCents,
      sellerProposalCurrency: p.currency,
      sellerProposalNote: p.note,
      sellerProposalTerms: { leadTime: p.leadTime, warranty: p.warranty } as Prisma.InputJsonValue,
      sellerProposalAt: now,
      sellerProposalById: sellerId,
      sellerProposalReviewNote: null,
    },
  });
  if (claim.count !== 1) return { error: 'This quote changed meanwhile (accepted or closed). Reload the page.' };
  const itemTitle = offerItemTitle(sr);
  const money = formatPrice(p.priceCents, p.currency);
  await notifyAdmins(
    `Supplier proposal to review — ${QUOTE_REF(sr.id)}`,
    `${itemTitle}: supplier price ${money}. Review it, add the margin and send the offer to the buyer.`,
    `/admin/quotes/${sr.id}`,
    'QUOTE_NEW',
  );
  await sendInternalEmail({
    to: process.env.QUOTE_INTAKE_EMAIL ?? '',
    subject: `[${QUOTE_REF(sr.id)}] Supplier proposal to review: ${money}`,
    html: mailLayout({
      heading: 'Supplier proposal to review',
      body: [
        `The supplier proposed <strong>${escapeHtml(money)}</strong> (excl. VAT) for <strong dir="auto">${escapeHtml(itemTitle)}</strong>.`,
        p.leadTime ? `Lead time: <span dir="auto">${escapeHtml(p.leadTime)}</span>` : '',
        p.warranty ? `Warranty: <span dir="auto">${escapeHtml(p.warranty)}</span>` : '',
        p.note ? `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;">${escapeHtmlLines(p.note)}</blockquote>` : '',
        'The buyer has not seen anything yet.',
      ].filter(Boolean),
      cta: { href: `${siteBase()}/admin/quotes/${sr.id}`, label: 'Review and send the offer' },
    }),
  }, 'quotes:proposal');
  await audit('quote.proposal.submit', QUOTE_REF(sr.id), `${money} by seller ${sellerId}`);
  revalidatePath(`/app/seller/inbox/${sr.id}`);
  revalidatePath(`/admin/quotes/${sr.id}`);
  revalidatePath('/admin/quotes');
  return { notice: `Proposal sent to the ${siteName()} team for review: ${money} (excl. VAT). The buyer sees an offer once our team approves it — you are notified then.` };
}

/** Staff decline a supplier proposal (with a note the supplier sees). */
export async function rejectSellerProposal(input: { sourcingRequestId: string; note: string }): Promise<QuoteActionResult> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:proforma', { redirectTo: '/admin/quotes' });
  await ensureSettingsLoaded();
  const note = (input.note ?? '').trim().slice(0, 1000);
  if (note.length < 4) return { error: 'Tell the supplier why (at least 4 characters).' };
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: input.sourcingRequestId },
    select: { id: true, sellerProposalStatus: true, sellerProposalCents: true, sellerProposalCurrency: true, assignedToId: true, assignedTo: { select: { role: true, email: true } } },
  });
  if (!sr) return { error: 'This quote no longer exists.' };
  const claim = await prisma.sourcingRequest.updateMany({
    where: { id: sr.id, sellerProposalStatus: 'PENDING' },
    data: { sellerProposalStatus: 'REJECTED', sellerProposalReviewNote: note },
  });
  if (claim.count !== 1) return { error: 'There is no pending supplier proposal on this quote (already handled?). Reload the page.' };
  if (sr.assignedToId) {
    await notifyUser(sr.assignedToId, `Proposal not used — ${QUOTE_REF(sr.id)}`, `${siteName()} did not send your proposal to the buyer: ${note.slice(0, 160)}`, `/app/seller/inbox/${sr.id}`);
    if (sr.assignedTo?.role === 'SELLER') {
      await sendInternalEmail({
        to: sr.assignedTo.email,
        subject: `[${QUOTE_REF(sr.id)}] Your proposal was not sent to the buyer`,
        html: mailLayout({
          heading: 'Your proposal was not sent to the buyer',
          body: [`${escapeHtml(siteName())} reviewed your proposal of ${escapeHtml(formatPrice(sr.sellerProposalCents ?? 0, sr.sellerProposalCurrency ?? 'EUR'))} and did not send it:`, `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;">${escapeHtmlLines(note)}</blockquote>`, 'You can send a new proposal from your seller inbox.'],
          cta: { href: `${siteBase()}/app/seller/inbox/${sr.id}`, label: 'Open the request' },
        }),
      }, 'quotes:proposal-reject');
    }
  }
  await audit('quote.proposal.reject', QUOTE_REF(sr.id), `by ${session.user.email}: ${note.slice(0, 200)}`);
  revalidatePath(`/admin/quotes/${sr.id}`);
  revalidatePath(`/app/seller/inbox/${sr.id}`);
  return { notice: 'Proposal declined; the supplier was notified.' };
}

// ── Acceptance ──────────────────────────────────────────────────────────────

const AcceptInput = z.object({
  sourcingRequestId: z.string().min(1),
  /** The offer revision the buyer looked at — refused if the offer changed since. */
  offerRevision: z.number().int().nonnegative().optional(),
  /** Legacy pages (before offer revisions): the quotedAt timestamp. */
  offerVersion: z.string().max(40).optional(),
  /** The total the buyer saw in the confirm step. */
  expectedTotalCents: z.number().int().nonnegative().optional(),
  expectedCurrency: z.string().max(3).optional(),
  /** Billing + delivery form fields (b_*, d_*, d_same). */
  details: z.record(z.string(), z.unknown()).optional(),
  acceptTerms: z.boolean().optional(),
  saveProfile: z.boolean().optional(),
});

export type AcceptancePreview = {
  currency: string;
  qty: number;
  unitCents: number;
  goodsCents: number;
  shippingCents: number;
  vatCents: number;
  vatRateBp: number;
  vatTreatment: string;
  vatLabel: string;
  vatExplanation: string;
  legalText: string | null;
  totalCents: number;
  /** The total differs from the offer as emailed (VAT decided now / details changed it). */
  differsFromOffer: boolean;
  offerTotalCents: number | null;
  /** Shipping to a country staff must clear first (export compliance). */
  complianceReview: string | null;
  /** The VAT needs a staff decision (VIES down, VAT ID of another company …): the
   *  order is created on a VAT review, without a proforma — buyer text. */
  vatReview: string | null;
  dueDays: number;
};

export type AcceptResult = QuoteActionResult & { fieldErrors?: DetailsFieldErrors; preview?: AcceptancePreview };

class AcceptRaceError extends Error {}
class AcceptBlockedError extends Error {}

type Prepared = {
  sr: NonNullable<Awaited<ReturnType<typeof loadQuoteForAcceptance>>>;
  details: OrderDetails;
  preview: AcceptancePreview;
  decisionReasons: string[];
  vatTreatment: VatTreatmentCode;
  vatRateBp: number;
  /** VAT rate of the freight line (Order.shippingVatRateBp, 7a). */
  shippingRateBp: number;
  lineVat: { rateBp: number; taxCents: number };
  vatIdEvidence: Awaited<ReturnType<typeof decideVatForDetails>>['vatId'];
  terms: OfferTerms | null;
  item: OfferItem;
  complianceNote: string | null;
  /** VAT review before payment: why (staff) — the buyer text is preview.vatReview. */
  vatReviewNote: string | null;
};

async function loadQuoteForAcceptance(id: string) {
  return prisma.sourcingRequest.findUnique({
    where: { id },
    include: {
      product: { select: { id: true, title: true, vatScheme: true, status: true, brand: { select: { name: true } } } },
      assignedTo: { select: { id: true, email: true, role: true } },
      order: { select: { id: true, orderNumber: true, status: true, paymentSubmittedAt: true, buyerId: true, adminNotes: true } },
    },
  });
}

/**
 * Everything acceptance needs, checked the same way for the preview and the
 * real acceptance: ownership, an OPEN offer (the server enforces the phase the
 * UI shows — a void legacy offer can not be accepted by replay), the offer
 * revision, the billing + delivery details, the country policy and the VAT
 * engine's decision (VIES checked). Returns a readable refusal otherwise.
 */
async function prepareAcceptance(
  p: z.infer<typeof AcceptInput>,
  user: { id: string; email: string },
): Promise<{ ok: true; prep: Prepared } | { ok: false; result: AcceptResult } | { ok: 'accepted'; orderNumber: string | null }> {
  const sr = await loadQuoteForAcceptance(p.sourcingRequestId);
  if (!sr) return { ok: false, result: { error: 'This quote no longer exists.' } };
  const isOwner = sr.submittedById
    ? sr.submittedById === user.id
    : sr.buyerEmail.trim().toLowerCase() === user.email.trim().toLowerCase();
  if (!isOwner) return { ok: false, result: { error: 'Only the buyer who requested this quote can accept its offer.' } };
  if (sr.status === 'ACCEPTED') {
    return { ok: 'accepted', orderNumber: sr.order && sr.order.status !== 'CANCELED' ? sr.order.orderNumber : null };
  }
  if (sr.status === 'DECLINED' || sr.status === 'CLOSED') {
    return {
      ok: false,
      result: {
        error: sr.status === 'DECLINED'
          ? 'This offer was declined, so it can no longer be accepted. Ask us for a new offer in the conversation below.'
          : 'This request was closed, so its offer can no longer be accepted. Open a new request if you still need the item.',
      },
    };
  }
  if (sr.status !== 'RESPONDED' || sr.quotedPriceCents == null) {
    return { ok: false, result: { error: 'There is no offer to accept yet. We will email you as soon as the supplier sends one.' } };
  }
  const phase = offerPhase(sr, sr.order);
  if (phase === 'expired') {
    return { ok: false, result: { error: `This offer expired on ${sr.validUntilAt ? fmtDay(sr.validUntilAt) : 'its validity date'} — ask for a new offer in the conversation below.` } };
  }
  if (phase !== 'open') {
    return { ok: false, result: { error: 'This offer is no longer open (its order was canceled or it was already decided). Ask for a new offer in the conversation below.' } };
  }
  if (
    (p.offerRevision !== undefined && p.offerRevision !== sr.offerRevision) ||
    (p.offerVersion && sr.quotedAt && p.offerVersion !== sr.quotedAt.toISOString()) ||
    (p.expectedCurrency && p.expectedCurrency !== (sr.quotedCurrency || 'EUR'))
  ) {
    return { ok: false, result: { error: 'This offer was updated after you opened the page. Review the new offer and accept again.' } };
  }

  // The offered unit itself, before the buyer types anything: on sale, and not
  // sold to / held for someone else (a competing offer accepted first).
  const terms = parseOfferTerms(sr.offerTerms);
  const item = parseOfferItem(sr.offerTerms);
  const qty = terms?.qty ?? 1;
  if (sr.productId) {
    if (sr.product && sr.product.status !== 'PUBLISHED' && !item.allowUnpublished) {
      return { ok: false, result: { error: 'This listing is not published right now, so the offer can not be accepted. Ask us in the conversation below.' } };
    }
    const av = await unitAvailability(sr.productId, sr.id);
    if (av && !av.heldByThisQuote && av.quantity < qty) {
      await alertAdminsOncePerDay(sr.id, 'ACCEPT_UNIT_GONE', `Acceptance refused: unit no longer available — ${QUOTE_REF(sr.id)}`, `${offerItemTitle(sr)}: the buyer tried to accept, but the unit is sold or held for another deal. Offer them a similar unit or close the request.`);
      return { ok: false, result: { error: 'Sorry — this unit was just sold or reserved by another buyer, so the offer can not be accepted. We can source a similar one: ask us in the conversation below.' } };
    }
  }

  const parsed = parseDetailsInput(p.details ?? {}, { vatIdRule: vatIdRule() });
  if (!parsed.ok) return { ok: false, result: { error: parsed.message, fieldErrors: parsed.fieldErrors } };
  const details = parsed.details;

  // The offer's freight and VAT are priced for one destination.
  if (item.destinationCountry && details.delivery.country !== item.destinationCountry) {
    const name = (await checkCountry(item.destinationCountry)).name ?? item.destinationCountry;
    return {
      ok: false,
      result: {
        error: `This offer was priced for delivery to ${name}. Ask us for a new offer to deliver to another country.`,
        fieldErrors: { d_country: `this offer is for delivery to ${name}` },
      },
    };
  }

  const amounts = offerAmounts(sr);
  const unitCents = terms?.unitCents || Math.round(amounts.goodsCents / qty);
  const vat = await decideVatForDetails(details, offerVatLines({ goodsCents: amounts.goodsCents, shippingCents: amounts.shippingCents, scheme: sr.product?.vatScheme ?? null }));
  for (const c of [vat.shipTo, vat.billing]) {
    if (c?.mode === 'BLOCK') {
      return { ok: false, result: { error: `${c.reason} The offer can not be accepted with these details — contact us in the conversation below.`, fieldErrors: { [c === vat.shipTo ? 'd_country' : 'b_country']: 'not allowed' } } };
    }
  }
  const d = vat.decision;
  const viesDown = vat.vatId?.status === 'UNAVAILABLE';
  if (d.blocked) {
    await alertAdminsOncePerDay(sr.id, 'ACCEPT_VAT_BLOCKED', `Acceptance refused by the VAT rules — ${QUOTE_REF(sr.id)}`, `The buyer tried to accept: ${d.reasons.join(' ')}`.slice(0, 400));
    return {
      ok: false,
      result: {
        error: viesDown
          ? 'We could not check your VAT ID with the EU service right now, and this order can only be placed once it is confirmed. Please try again later — our team has been told.'
          : 'This offer can not be accepted with these billing details. Contact us in the conversation below and we will sort it out.',
      },
    };
  }
  // Undecidable VAT (VIES down under MANUAL_REVIEW, a VAT ID registered to
  // another company, …): the order is still placed, on a pre-payment VAT
  // review — no proforma until staff confirm the VAT (like the COMPLIANCE hold).
  const vatReviewNote = d.reviewRequired ? d.reasons.join(' ').slice(0, 900) : null;
  const vatReview = d.reviewRequired ? vatReviewBuyerText(viesDown ? 'VIES_UNAVAILABLE' : 'REVIEW') : null;
  const goodsLine = d.lines.find((l) => l.lineType === 'GOODS');
  const totalCents = amounts.goodsCents + amounts.shippingCents + d.taxCents;
  const review = [vat.shipTo, vat.billing].find((c) => c?.mode === 'REVIEW');
  return {
    ok: true,
    prep: {
      sr,
      details,
      terms,
      item,
      decisionReasons: d.reasons,
      vatTreatment: d.treatment,
      vatRateBp: d.rateBp,
      shippingRateBp: d.shippingRateBp,
      lineVat: { rateBp: goodsLine?.rateBp ?? d.rateBp, taxCents: goodsLine?.taxCents ?? 0 },
      vatIdEvidence: vat.vatId,
      complianceNote: review ? review.reason : null,
      vatReviewNote,
      preview: {
        currency: sr.quotedCurrency || 'EUR',
        qty,
        unitCents,
        goodsCents: amounts.goodsCents,
        shippingCents: amounts.shippingCents,
        vatCents: d.taxCents,
        vatRateBp: d.rateBp,
        vatTreatment: d.treatment,
        vatLabel: vatReview ? 'VAT to be confirmed' : vatTreatmentLabel(d.treatment),
        // Buyer wording only — the engine's reasons are for staff.
        vatExplanation: vatReview ?? buyerVatExplanation(d as VatDecision & { buyerExplanation?: string | null }),
        legalText: vatReview ? null : d.legalText,
        totalCents,
        differsFromOffer: amounts.vatDecided ? amounts.totalCents !== totalCents : true,
        offerTotalCents: amounts.vatDecided ? amounts.totalCents : null,
        complianceReview: review ? review.reason : null,
        vatReview,
        dueDays: terms?.paymentTerms.days ?? offerDefaults().paymentTermDays,
      },
    },
  };
}

/** Step 1 of acceptance: check the buyer's details and return the exact total. */
export async function previewOfferAcceptance(input: z.input<typeof AcceptInput>): Promise<AcceptResult> {
  const parsedInput = AcceptInput.safeParse(input);
  if (!parsedInput.success) return { error: 'This offer could not be checked. Reload the page and try again.' };
  const session = await requireSession({ redirectTo: `/app/quotes/${parsedInput.data.sourcingRequestId}` });
  await ensureSettingsLoaded();
  const r = await prepareAcceptance(parsedInput.data, session.user);
  if (r.ok === 'accepted') return { notice: 'This offer is already accepted. Reload the page to open your order.' };
  if (!r.ok) return r.result;
  return { preview: r.prep.preview };
}

/**
 * The buyer accepts an open offer with their billing + delivery details. In
 * ONE transaction: claim RESPONDED → ACCEPTED (guarded on the exact offer
 * revision), create the order priced by the VAT engine (exactly the total the
 * buyer confirmed), hold the unit (A09), issue the proforma (number, due date,
 * bank snapshot) and record the accepted Terms of Sale (link, version, time,
 * IP). Then redirect to the payment page at once — the proforma PDF and the
 * emails go out after the response, so a busy PDF queue never stalls the
 * acceptance. A double click / second tab is sent to the same order.
 *
 * Holds before payment: an export-compliance country (COMPLIANCE — the proforma
 * is issued, not mailed) and a VAT the rules can not decide (VAT_REVIEW — no
 * proforma at all until staff confirm the VAT: lib/checkout/holds.ts).
 */
export async function acceptOffer(input: z.input<typeof AcceptInput>): Promise<AcceptResult> {
  const parsedInput = AcceptInput.safeParse(input);
  if (!parsedInput.success) return { error: 'This offer could not be accepted. Reload the page and try again.' };
  const p = parsedInput.data;
  const session = await requireSession({ redirectTo: `/app/quotes/${p.sourcingRequestId}` });
  await ensureSettingsLoaded();

  const r = await prepareAcceptance(p, session.user);
  if (r.ok === 'accepted') {
    if (r.orderNumber) redirect(`/app/orders/${r.orderNumber}/payment`);
    return { error: 'This offer was already accepted, but its order is no longer open. Contact support.' };
  }
  if (!r.ok) return r.result;
  const { sr, details, preview, terms } = r.prep;
  if (requireTermsAcceptance() && !p.acceptTerms) {
    return { error: 'Tick “I accept this offer and the General Terms of Sale” to accept.' };
  }
  if (p.expectedTotalCents === undefined || p.expectedTotalCents !== preview.totalCents) {
    return { error: 'The total changed after you reviewed it (details or offer updated). Check the new total and confirm again.', preview };
  }
  // Legacy: a paid order / a proof in flight on a RESPONDED quote = already committed.
  if (sr.order && (PAID_ORDER_STATES.includes(sr.order.status) || (sr.order.status === 'PENDING_PAYMENT' && sr.order.paymentSubmittedAt))) {
    redirect(`/app/orders/${sr.order.orderNumber}/payment`);
  }

  const now = new Date();
  const site = siteName();
  const buyerId = sr.submittedById ?? session.user.id;
  const currency = preview.currency;
  const item = r.prep.item;
  const itemTitle = offerItemTitle(sr);
  const lineTruth = sr.productId ? (await orderLineTruthFor([sr.productId])).get(sr.productId) : undefined;
  const warrantySnapshot = terms?.warranty ?? lineTruth?.warrantySnapshot ?? null;
  // The offer's own condition, printed with the grade label the catalog uses.
  const conditionSnapshot = item.itemCondition ? (await getConditionGrades())[item.itemCondition]?.label ?? null : lineTruth?.conditionSnapshot ?? null;
  const vatReview = !!r.prep.vatReviewNote;
  const dueDate = daysFrom(now, preview.dueDays);
  const money = (c: number) => formatPrice(c, currency);
  const h = await headers();
  const ip = (h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0] ?? '').trim().slice(0, 60) || null;
  const ua = (h.get('user-agent') ?? '').slice(0, 200) || null;
  const mode = stockReserveOn();
  const billing = billingAddressJson(details.billing);
  const shipping = shippingAddressJson(details.delivery, session.user.email);
  const vatId = r.prep.vatIdEvidence;
  const orderVat = {
    vatTreatment: preview.vatTreatment as VatTreatmentCode,
    vatRateBp: preview.vatRateBp,
    vatDecidedAt: now,
    vatNote: r.prep.decisionReasons.join(' ').slice(0, 1000),
    buyerVatId: vatId?.vatId ?? details.billing.vatId,
    viesCheck: vatId ? (JSON.parse(JSON.stringify(vatId)) as Prisma.InputJsonValue) : Prisma.DbNull,
    // Same order fields as a checkout order (7a): freight VAT rate, who buys,
    // where the invoice goes, the buyer's PO (also printed on the documents).
    shippingVatRateBp: preview.shippingCents > 0 ? r.prep.shippingRateBp : null,
    shippingTaxed: preview.shippingCents > 0 && r.prep.shippingRateBp > 0,
    customerType: 'BUSINESS' as const,
    invoiceEmail: details.billing.invoiceEmail,
    poNumber: details.billing.poNumber,
  };
  // A REVIEW country / an undecided VAT: pre-payment holds like checkout's
  // (lib/checkout/holds.ts — openHolds + holdReason). The order is not payable
  // until staff clear them; the payment term restarts then (releaseHold).
  const holdCodes: HoldCode[] = [...(r.prep.complianceNote ? ['COMPLIANCE' as const] : []), ...(vatReview ? ['VAT_REVIEW' as const] : [])];
  const holdNotes = [
    r.prep.complianceNote ? `COMPLIANCE: Export compliance check before payment: ${r.prep.complianceNote}` : '',
    vatReview ? `VAT_REVIEW: VAT to be decided before the proforma is issued: ${r.prep.vatReviewNote}${vatId?.name ? ` (VIES name: ${vatId.name}; billing name: ${details.billing.legalName})` : ''}` : '',
  ].filter(Boolean);
  const hold = holdCodes.length
    ? { holdReason: primaryHold(holdCodes), holdNote: holdNotes.join(' | ').slice(0, 2000), holdAt: now, openHolds: holdCodes as string[], payableSince: null }
    : { openHolds: [] as string[], payableSince: now };
  // The Terms of Sale the buyer ticked: which link, which text version, when, from where.
  const termsAccepted = p.acceptTerms
    ? { termsUrl: termsOfSaleUrl(), termsVersion: termsTextVersion(), termsAcceptedAt: now, termsAcceptedIp: ip }
    : {};
  const orderTerms = { kind: 'PREPAY', days: preview.dueDays, text: terms?.paymentTerms.text ?? fillPaymentTermsText(offerDefaults().paymentTermsText, preview.dueDays), incoterm: terms?.incoterm ?? null, incotermPlace: terms?.incotermPlace ?? null, leadTime: terms?.leadTime ?? null };

  // proformaId / number are null while the order waits on a VAT review (no proforma yet).
  let order: { id: string; orderNumber: string; proformaId: string | null; number: string | null };
  try {
    order = await prisma.$transaction(async (tx) => {
      // Guarded on the exact open offer: a staff close or a decline in another
      // tab that committed first makes this claim fail (and vice versa).
      const claim = await tx.sourcingRequest.updateMany({
        where: { id: sr.id, status: 'RESPONDED', offerRevision: sr.offerRevision, quotedPriceCents: sr.quotedPriceCents, ...(sr.quotedAt ? { quotedAt: sr.quotedAt } : {}) },
        data: { status: 'ACCEPTED', submittedById: buyerId, archivedAt: null, archivedById: null, dueAt: null, slaBreachAt: null },
      });
      if (claim.count !== 1) throw new AcceptRaceError();

      const existing = await tx.order.findUnique({
        where: { sourcingRequestId: sr.id },
        select: { id: true, orderNumber: true, status: true, paymentSubmittedAt: true, buyerId: true, adminNotes: true },
      });
      const orderData = {
        subtotalCents: preview.goodsCents,
        shippingCents: preview.shippingCents,
        taxCents: preview.vatCents,
        totalCents: preview.totalCents,
        currency,
        billingAddress: billing as Prisma.InputJsonValue,
        shippingAddress: shipping as Prisma.InputJsonValue,
        paymentTerms: orderTerms as Prisma.InputJsonValue,
        dueAt: dueDate,
        ...orderVat,
        ...hold,
        ...termsAccepted,
      };
      const itemData = {
        productId: sr.productId ?? null,
        titleSnapshot: itemTitle,
        brandSnapshot: sr.product?.brand?.name ?? null,
        priceCentsSnapshot: preview.unitCents,
        quantity: preview.qty,
        lineType: 'GOODS',
        vatRateBp: r.prep.lineVat.rateBp,
        taxCents: r.prep.lineVat.taxCents,
        conditionSnapshot,
        warrantySnapshot,
        warrantyMonthsSnapshot: lineTruth?.warrantyMonthsSnapshot ?? null,
      };
      let created: { id: string; orderNumber: string } | null = null;
      if (existing) {
        if (existing.status === 'PENDING_PAYMENT' && !existing.paymentSubmittedAt && existing.buyerId === buyerId) {
          // Legacy auto-created order (old flow): adopt it at the accepted offer.
          await voidProformas(existing.id, 'Replaced by the proforma issued when the offer was accepted.', tx);
          await tx.order.update({ where: { id: existing.id }, data: orderData });
          await tx.orderItem.deleteMany({ where: { orderId: existing.id } });
          await tx.orderItem.create({ data: { ...itemData, orderId: existing.id } });
          created = { id: existing.id, orderNumber: existing.orderNumber };
        } else if (existing.status === 'CANCELED') {
          await tx.order.update({
            where: { id: existing.id },
            data: {
              sourcingRequestId: null,
              adminNotes: `${existing.adminNotes ? `${existing.adminNotes}\n` : ''}[${isoDay(now)}] Unlinked from quote ${QUOTE_REF(sr.id)} when the buyer accepted a new offer.`.slice(0, 4000),
            },
          });
        } else {
          throw new AcceptBlockedError(`Order ${existing.orderNumber} already exists for this quote. Open it from your orders.`);
        }
      }
      if (!created) {
        const o = await createOrderWithUniqueNumber({
          buyerId,
          status: 'PENDING_PAYMENT',
          paidAt: null,
          sourcingRequestId: sr.id,
          ...orderData,
          items: { create: itemData },
        }, { tx });
        created = { id: o.id, orderNumber: o.orderNumber };
      }
      // A09: the unit is held for this order (STOCK_RESERVE_ON) — or the acceptance fails.
      if (sr.productId && (mode === 'OFFER_ACCEPTED' || mode === 'OFFER_SENT')) {
        const held = await holdUnitForQuote(tx, { quoteId: sr.id, productId: sr.productId, qty: preview.qty, orderId: created.id });
        if (!held.ok) {
          throw new AcceptBlockedError('Sorry — this unit was just sold or reserved by another buyer, so the offer can not be accepted. We can source a similar one: ask us in the conversation below.');
        }
      }
      // The proforma: gap-free PF number + immutable snapshot, in THIS transaction —
      // unless the VAT is still to be decided (it is issued when the review is cleared).
      let pfDoc: { id: string; number: string } | null = null;
      if (!vatReview) {
        const pf = await issueProforma(created.id, { tx, actorId: session.user.id, dueDate });
        if (!pf.ok) throw new Error(`Proforma could not be issued: ${pf.message}`);
        pfDoc = { id: pf.document.id, number: pf.document.number };
        await tx.sourcingRequest.update({ where: { id: sr.id }, data: { proformaNumber: pfDoc.number, proformaIssuedAt: now } });
      }
      await tx.quoteMessage.create({
        data: {
          sourcingRequestId: sr.id,
          authorId: session.user.id,
          fromStaff: false,
          body: vatReview
            ? `Offer accepted (revision ${sr.offerRevision}): ${money(preview.totalCents)} excl. VAT for "${itemTitle}" — the VAT is confirmed by ${site} before payment. Order ${created.orderNumber} was created; the proforma invoice follows once the VAT is confirmed.${r.prep.complianceNote ? ` Note: ${r.prep.complianceNote}` : ''}`
            : `Offer accepted (revision ${sr.offerRevision}): ${money(preview.totalCents)} incl. ${preview.vatRateBp ? `VAT ${pctLabel(preview.vatRateBp)}` : 'VAT 0%'} for "${itemTitle}". Order ${created.orderNumber} and proforma ${pfDoc!.number} were created — payment due by ${fmtDay(dueDate)}.${r.prep.complianceNote ? ` Note: ${r.prep.complianceNote}` : ''}`,
        },
      });
      if (p.saveProfile !== false) {
        const profile = {
          customerType: 'BUSINESS' as const,
          legalName: details.billing.legalName,
          contactName: details.billing.contactName,
          vatId: details.billing.vatId,
          vatValidationId: vatId?.validationId ?? null,
          address: { line1: details.billing.line1, line2: details.billing.line2, postalCode: details.billing.postalCode, city: details.billing.city, region: details.billing.region, country: details.billing.country } as Prisma.InputJsonValue,
          country: details.billing.country,
          invoiceEmail: details.billing.invoiceEmail,
          phone: details.billing.phone,
        };
        await tx.billingProfile.upsert({ where: { userId: buyerId }, update: profile, create: { userId: buyerId, ...profile } });
      }
      return { ...created, proformaId: pfDoc?.id ?? null, number: pfDoc?.number ?? null };
    });
  } catch (e) {
    const raced = e instanceof AcceptRaceError || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002');
    if (raced) {
      // A parallel request (double click / second tab) won: send this one to the
      // same order. A close / decline that won is said as it is — no order exists.
      const fresh = await prisma.sourcingRequest.findUnique({ where: { id: sr.id }, select: { status: true, offerRevision: true, order: { select: { orderNumber: true } } } });
      if (fresh?.status === 'ACCEPTED' && fresh.order) redirect(`/app/orders/${fresh.order.orderNumber}/payment`);
      if (fresh?.status === 'CLOSED') return { error: `This request was closed by ${site} a moment ago, so no order was created. Open a new request if you still need the item.` };
      if (fresh?.status === 'DECLINED') return { error: 'This offer was declined (in another window) a moment ago, so no order was created.' };
      return { error: 'This offer changed while you were accepting it. Review the current offer and try again.' };
    }
    if (e instanceof AcceptBlockedError) {
      if (/sold or reserved/.test(e.message)) {
        await alertAdminsOncePerDay(sr.id, 'ACCEPT_UNIT_GONE', `Acceptance refused: unit no longer available — ${QUOTE_REF(sr.id)}`, `${itemTitle}: the buyer tried to accept, but the unit is sold or held for another deal. Offer them a similar unit or close the request.`);
      }
      return { error: e.message };
    }
    throw e;
  }

  await audit(
    'quote.offer.accept',
    order.number ?? order.orderNumber,
    `order=${order.orderNumber} r${sr.offerRevision} total=${money(preview.totalCents)} vat=${preview.vatTreatment} ${pctLabel(preview.vatRateBp)} by ${session.user.email} ip=${ip ?? '-'} ua="${(ua ?? '-').slice(0, 120)}" terms=${p.acceptTerms ? `${termsOfSaleUrl()} ${termsTextVersion().slice(0, 19)} accepted` : requireTermsAcceptance() ? 'MISSING' : 'not required'}${r.prep.complianceNote ? ' · compliance hold' : ''}${vatReview ? ' · VAT review (no proforma yet)' : ''}${item.allowUnpublished && sr.product?.status !== 'PUBLISHED' ? ' · unpublished listing (staff override on the offer)' : ''}`,
  );

  const sendAll = async () => {
    const paymentUrl = `${siteBase()}/app/orders/${order.orderNumber}/payment`;
    const pdfUrl = absoluteDocumentHref('proforma', order.orderNumber, 'pdf');
    // The order may have been canceled (Deal panel, the buyer) or its proforma
    // voided in the moment since the commit: a canceled order never gets an
    // "order confirmed" mail with bank details.
    const [live, pfRow] = await Promise.all([
      prisma.order.findUnique({ where: { id: order.id }, select: { status: true } }),
      order.proformaId ? prisma.fiscalDocument.findUnique({ where: { id: order.proformaId }, select: { voidedAt: true, snapshot: true } }) : Promise.resolve(null),
    ]);
    const stillOpen = live?.status === 'PENDING_PAYMENT';
    const proformaLive = !!pfRow && !pfRow.voidedAt;
    // Pre-payment holds (export check, VAT review): no payment request until staff
    // clear them — the proforma goes out then (lib/checkout/holds.ts releaseHold).
    const onHold = !!r.prep.complianceNote || vatReview;
    const mailBuyer = stillOpen && (onHold || proformaLive);
    const doc = !mailBuyer || onHold || !order.proformaId || !order.number ? { attachment: null, error: null } : await documentAttachment({ id: order.proformaId, number: order.number });
    const attachments = doc.attachment ? [doc.attachment] : [];
    const snap = pfRow?.snapshot as { bank?: { beneficiary: string; bankName: string; iban: string; bic: string } | null } | null;
    const b = snap?.bank ?? null;
    const reference = order.number ?? order.orderNumber;
    const payRows: Array<[string, string, boolean?]> = b
      ? [
          ['Beneficiary', escapeHtml(b.beneficiary)],
          ...(b.bankName ? [['Bank', escapeHtml(b.bankName)] as [string, string]] : []),
          ['IBAN', `<span style="font-family:ui-monospace,monospace;">${escapeHtml(b.iban)}</span>`],
          ...(b.bic ? [['BIC', `<span style="font-family:ui-monospace,monospace;">${escapeHtml(b.bic)}</span>`] as [string, string]] : []),
          ['Reference', `<strong>${escapeHtml(reference)}</strong>`],
          ['Amount', escapeHtml(money(preview.totalCents)), true],
          ['Pay by', `<strong>${escapeHtml(fmtDay(dueDate))}</strong>`],
        ]
      : [['Reference', escapeHtml(reference)], ['Amount', escapeHtml(money(preview.totalCents)), true], ['Pay by', escapeHtml(fmtDay(dueDate))]];
    const holdText = [r.prep.complianceNote, preview.vatReview].filter(Boolean).join(' ');
    const html = mailLayout({
      heading: onHold ? 'Order received — check before payment' : `Thank you — your order ${order.orderNumber} is confirmed`,
      body: [
        `Hi <span dir="auto">${escapeHtml(sr.buyerName)}</span>,`,
        onHold
          ? `You accepted our offer for <strong dir="auto">${escapeHtml(itemTitle)}</strong>. We created order <strong>${order.orderNumber}</strong>.`
          : `You accepted our offer for <strong dir="auto">${escapeHtml(itemTitle)}</strong>. We created order <strong>${order.orderNumber}</strong> and proforma invoice <strong>${reference}</strong>${doc.attachment ? ' (attached as PDF)' : ''}.`,
        vatReview
          ? offerMailRows({ qty: preview.qty, unitCents: preview.unitCents, goodsCents: preview.goodsCents, shippingCents: preview.shippingCents, vatDecided: false, vatRateBp: null, vatCents: null, vatLabel: null, totalCents: preview.totalCents, currency })
          : offerMailRows({ qty: preview.qty, unitCents: preview.unitCents, goodsCents: preview.goodsCents, shippingCents: preview.shippingCents, vatDecided: true, vatRateBp: preview.vatRateBp, vatCents: preview.vatCents, vatLabel: preview.vatLabel, totalCents: preview.totalCents, currency }),
        onHold
          ? `<p style="margin:0 0 12px;padding:10px;border-radius:8px;background:#fffbeb;border:1px solid #fcd34d;"><strong>Please do not pay yet.</strong> ${escapeHtml(holdText)} We email you as soon as the check is done.</p>`
          : `<h3 style="color:#0E4F40;margin:16px 0 6px;font-size:15px;">How to pay</h3>${mailTable(payRows)}${b ? '' : '<p style="margin:0 0 12px;">Our bank details are on the payment page.</p>'}`,
        onHold ? '' : 'After paying, upload your bank receipt on the payment page so we can verify it and ship.',
      ].filter(Boolean),
      cta: { href: paymentUrl, label: onHold ? 'View your order' : 'Go to the payment page' },
      footer: onHold
        ? ['We send you the proforma invoice with the final total and the bank details as soon as the check is done.']
        : [`${doc.attachment ? 'Your proforma invoice is attached.' : 'Your proforma invoice is ready on the payment page.'} You can also <a href="${pdfUrl}">download the PDF</a> at any time (sign-in required).`],
    });
    const subject = onHold
      ? `Order ${order.orderNumber} received — ${vatReview ? 'VAT check' : 'export check'} before payment (${headerText(itemTitle, 70)})`
      : `Proforma invoice ${reference} — order ${order.orderNumber} (${headerText(itemTitle, 80)})`;
    // The proforma goes to the accounts-payable address given at acceptance, the
    // account in copy (INVOICE_EMAIL_CC_ACCOUNT); the hold notice goes to the account.
    const rcpt = onHold ? { to: sr.buyerEmail, cc: [] as string[] } : documentRecipients({ invoiceEmail: details.billing.invoiceEmail, accountEmail: sr.buyerEmail });
    let buyerMail: { ok: true } | { ok: false; error: string } = { ok: false, error: stillOpen ? 'proforma no longer current' : `order ${live?.status?.toLowerCase() ?? 'gone'} meanwhile` };
    if (mailBuyer) {
      const sent = await trySendEmail({ to: rcpt.to, subject, html, attachments }, 'quotes:accept');
      buyerMail = sent.ok ? { ok: true } : { ok: false, error: sent.error };
      if (sent.ok && !onHold && order.proformaId) await markDocumentSent(order.proformaId);
      for (const cc of rcpt.cc) await trySendEmail({ to: cc, subject: `[copy] ${subject}`, html, attachments }, 'quotes:accept-account-copy');
      const copyTo = companyCopyAddress();
      if (copyTo) await sendInternalEmail({ to: copyTo, subject: `[copy] ${subject}`, html, attachments }, 'quotes:accept-copy');
    }
    // Staff / assigned seller — sellers never see who the buyer is.
    const inbox = staffQuoteInbox(sr);
    const viesName = vatId?.name && vatId.name !== '---' ? vatId.name : null;
    const status = !stillOpen
      ? ` <strong>Order ${escapeHtml(live?.status?.toLowerCase().replace(/_/g, ' ') ?? 'removed')} since</strong> — no proforma mail was sent.`
      : vatReview ? ` <strong>On VAT review</strong> (no proforma yet): ${escapeHtml(r.prep.vatReviewNote ?? '')}`
      : r.prep.complianceNote ? ` <strong>On compliance hold:</strong> ${escapeHtml(r.prep.complianceNote)}`
      : ' Awaiting the buyer’s bank transfer.';
    await sendInternalEmail({
      to: inbox.to,
      subject: `[${QUOTE_REF(sr.id)}] Offer accepted — order ${order.orderNumber}`,
      html: mailLayout({
        heading: 'Offer accepted',
        body: [
          mailP(`${inbox.toSeller ? 'The buyer' : `<span dir="auto">${escapeHtml(sr.buyerName)}</span> &lt;${escapeHtml(sr.buyerEmail)}&gt;${details.billing.legalName ? ` (<span dir="auto">${escapeHtml(details.billing.legalName)}</span>)` : ''}`} accepted the offer for <strong dir="auto">${escapeHtml(itemTitle)}</strong>${inbox.toSeller && !sellerSeesSellPrice() ? '' : `: <strong>${escapeHtml(money(preview.totalCents))}</strong> (${escapeHtml(preview.vatLabel)})`}.`),
          !inbox.toSeller && vatId?.vatId ? `VAT ID <strong>${escapeHtml(vatId.vatId)}</strong> — VIES: ${escapeHtml(vatId.status === 'UNAVAILABLE' ? 'could not check' : vatId.status.toLowerCase().replace('_', ' '))}${viesName ? `, registered to <strong dir="auto">${escapeHtml(viesName)}</strong> (billing name: <span dir="auto">${escapeHtml(details.billing.legalName)}</span>)` : ''}.` : '',
          `Order <strong>${order.orderNumber}</strong>${order.number ? ` · proforma <strong>${order.number}</strong> · payment due ${escapeHtml(fmtDay(dueDate))}` : ''}.${status}`,
          !mailBuyer || buyerMail.ok ? '' : mailP(`<strong>The order email to the buyer could not be delivered</strong> (${escapeHtml(buyerMail.error)}).`),
        ].filter(Boolean),
        cta: { href: `${siteBase()}${inbox.toSeller ? `/app/seller/inbox/${sr.id}` : `/admin/quotes/${sr.id}`}`, label: 'Open the quote' },
      }),
    }, 'quotes:accept-staff');
    if (stillOpen) {
      await notifyUser(
        buyerId,
        `Offer accepted — order ${order.orderNumber}`,
        onHold
          ? `${holdText} Please do not pay yet — we email you when the order is ready for payment.`.slice(0, 480)
          : `Proforma ${reference} is ready. Pay ${money(preview.totalCents)} by bank transfer by ${fmtDay(dueDate)} and upload the receipt.`,
        `/app/orders/${order.orderNumber}/payment`,
      );
    }
    if (sr.assignedToId && sr.assignedTo?.role === 'SELLER') {
      await notifyUser(sr.assignedToId, `Offer accepted — ${QUOTE_REF(sr.id)}`, `The buyer accepted the offer for "${itemTitle}". Awaiting payment.`, `/app/seller/inbox/${sr.id}`);
    }
    // One admin notice per acceptance; the VAT review / compliance hold is part of it.
    await notifyAdmins(
      `Offer accepted — order ${order.orderNumber}${vatReview ? ' (VAT review)' : ''}`,
      `${itemTitle} · ${money(preview.totalCents)}${vatReview ? ' excl. VAT · VAT to decide before the proforma' : ` · proforma ${reference}`}${viesName ? ` · VIES name ${viesName} / billing ${details.billing.legalName}` : ''}${mailBuyer && !buyerMail.ok ? ' · email to the buyer FAILED' : ''}${mailBuyer && !onHold && !doc.attachment ? ' · PDF not attached' : ''}${r.prep.complianceNote ? ' · COMPLIANCE HOLD' : ''}${stillOpen ? '' : ` · order ${live?.status ?? 'gone'} since — no mail sent`}`,
      `/admin/quotes/${sr.id}`,
      'ORDER_FROM_QUOTE',
    );
    if ((mailBuyer && !buyerMail.ok) || doc.error || !mailBuyer) {
      await audit('quote.offer.accept.mail', reference, `${!mailBuyer ? `not sent: ${buyerMail.ok ? '' : buyerMail.error}` : buyerMail.ok ? `email ok to ${rcpt.to}` : `email failed: ${buyerMail.error}`}${doc.error ? ` · pdf: ${doc.error}` : ''}`);
    }
    if (sr.productId && stillOpen) await tellCompetingBuyers(sr.productId, sr.id, itemTitle);
  };
  after(() => sendAll().catch((e) => logError('quotes:accept-after', e)));

  revalidatePath(`/app/quotes/${sr.id}`);
  revalidatePath('/app/quotes');
  revalidatePath('/app/orders');
  revalidatePath(`/app/seller/inbox/${sr.id}`);
  revalidatePath(`/admin/quotes/${sr.id}`);
  revalidatePath('/admin/quotes');
  revalidatePath('/admin/orders');
  redirect(`/app/orders/${order.orderNumber}/payment?accepted=1`);
}

// ── Competing offers on one unit ────────────────────────────────────────────

/**
 * An acceptance took the last unit: the other open offers on that listing can
 * no longer be accepted. Their buyers are told at once ("we can source a
 * similar one") instead of typing their billing details only to be refused,
 * and the quotes go back to the staff queue (internal note, tag UNIT_SOLD, the
 * reply SLA restarts). Once per quote until a new offer is sent (ReminderLog
 * UNIT_SOLD, cleared by publishOffer). Runs after the response; never fatal.
 */
async function tellCompetingBuyers(productId: string, winnerQuoteId: string, itemTitle: string): Promise<void> {
  const others = await prisma.sourcingRequest.findMany({
    where: { productId, id: { not: winnerQuoteId }, status: 'RESPONDED', quotedPriceCents: { not: null } },
    select: {
      id: true, proformaNumber: true, status: true, quotedPriceCents: true, validUntilAt: true, offerTerms: true, priority: true, tags: true,
      buyerName: true, buyerEmail: true, submittedById: true, accessToken: true,
      order: { select: { status: true, paymentSubmittedAt: true } },
    },
    take: 50,
  });
  const now = new Date();
  for (const q of others) {
    try {
      if (offerPhase(q, q.order) !== 'open') continue;
      const qty = parseOfferTerms(q.offerTerms)?.qty ?? 1;
      const av = await unitAvailability(productId, q.id);
      if (!av || av.heldByThisQuote || av.quantity >= qty) continue;
      try {
        await prisma.reminderLog.create({ data: { subjectType: 'QUOTE', subjectId: q.id, kind: 'UNIT_SOLD', step: 0, detail: `sold via ${QUOTE_REF(winnerQuoteId)}` } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
      const ref = quoteRefOrProforma(q);
      await prisma.quoteMessage.create({
        data: {
          sourcingRequestId: q.id, authorId: null, isInternalNote: true, fromStaff: true,
          body: `The unit of this offer was sold to another buyer (${QUOTE_REF(winnerQuoteId)}). The buyer was told it can no longer be accepted and that we can source a similar one — offer an alternative or close the request.`,
        },
      });
      await prisma.sourcingRequest.update({
        where: { id: q.id },
        data: { lastReplyByStaff: false, dueAt: computeQuoteDueAt(now, q.priority), slaBreachAt: null, tags: Array.from(new Set([...q.tags, 'UNIT_SOLD'])) },
      });
      const sent = await trySendEmail({
        to: q.buyerEmail,
        subject: `[${ref}] The unit in your offer was sold`,
        html: mailLayout({
          heading: 'This unit was just sold',
          body: [
            `Hi <span dir="auto">${escapeHtml(q.buyerName)}</span>,`,
            `The <strong dir="auto">${escapeHtml(itemTitle)}</strong> in our offer <strong>${ref}</strong> was just sold to another buyer, so this offer can no longer be accepted.`,
            'We can source a similar unit for you. Reply in the conversation (what matters most: model, condition, budget, timing) and we send you a new offer.',
          ],
          cta: { href: buyerQuoteLink(q), label: 'Ask for a similar unit' },
          footer: [`Reference ${ref}`],
        }),
      }, 'quotes:unit-sold');
      await notifyUser(q.submittedById, 'The unit in your offer was sold', `"${itemTitle}" was sold to another buyer. We can source a similar one — reply in the conversation.`, `/app/quotes/${q.id}`);
      await notifyAdmins(
        `Unit sold — open offer ${ref} can no longer be accepted`,
        `${itemTitle}: sold via ${QUOTE_REF(winnerQuoteId)}. The buyer of ${ref} was ${sent.ok ? 'emailed' : `NOT emailed (${sent.error})`}; offer an alternative or close the request.`,
        `/admin/quotes/${q.id}`,
        'SYSTEM',
      );
      await audit('quote.unit-sold.notify', ref, `sold via ${QUOTE_REF(winnerQuoteId)} · buyer email ${sent.ok ? 'ok' : `failed: ${sent.error}`}`);
      revalidatePath(`/app/quotes/${q.id}`);
      revalidatePath(`/admin/quotes/${q.id}`);
    } catch (e) {
      await logError('quotes:unit-sold', e);
    }
  }
}

// ── Decline / close ─────────────────────────────────────────────────────────

const OFFER_UPDATED_BEFORE_DECLINE = 'The offer was just updated — review the new offer before declining.';

/** The buyer declines an open offer, optionally saying why. `offerRevision` is
 *  the revision the buyer was looking at: a newer offer sent meanwhile is never
 *  declined unseen. */
export async function declineOffer(input: { sourcingRequestId: string; reason?: string | null; note?: string | null; offerRevision?: number | null }): Promise<QuoteActionResult> {
  await ensureSettingsLoaded();
  const reasons = declineReasons();
  const reason = (input.reason ?? '').trim();
  if (reason && !reasons.includes(reason)) return { error: 'Choose one of the listed reasons (or none).' };
  const note = (input.note ?? '').trim().slice(0, 1000) || null;
  return setQuoteStatusCore(input.sourcingRequestId, 'DECLINED', { reason: reason || null, note, offerRevision: input.offerRevision ?? undefined });
}

class ProofInFlightError extends Error {}
class StatusClaimLost extends Error {}

/** Decline (buyer) or close (staff “Close (no deal)”): the reason comes from
 *  QUOTE_CLOSE_REASONS (QUOTE_DECLINE_REASONS for a decline); reason and note
 *  are stored on the quote, posted in the conversation and mailed to the buyer. */
export async function setQuoteStatus(
  id: string,
  status: 'DECLINED' | 'CLOSED',
  opts?: { reason?: string | null; note?: string | null },
): Promise<QuoteActionResult> {
  await ensureSettingsLoaded();
  const reason = (opts?.reason ?? '').trim();
  const note = (opts?.note ?? '').trim().slice(0, 1000) || null;
  if (reason && !(status === 'CLOSED' ? closeReasons() : declineReasons()).includes(reason)) {
    return { error: 'Choose one of the listed reasons.' };
  }
  return setQuoteStatusCore(id, status, { reason: reason || null, note });
}

/**
 * Staff “New quote for this buyer”. A closed request, or one whose accepted
 * order was canceled, takes no new offer (its offer is part of the record and
 * an order belongs to one quote) — a new request for the same buyer and item is
 * opened, assigned to the staff member who clicked, with internal notes linking
 * both. The buyer hears nothing until the new offer is sent.
 */
export async function cloneQuoteForBuyer(id: string): Promise<QuoteActionResult & { sourcingRequestId?: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:proforma', { redirectTo: '/admin/quotes' });
  await ensureSettingsLoaded();
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id },
    select: {
      id: true, proformaNumber: true, status: true, lostReason: true, priority: true, customerType: true,
      buyerEmail: true, buyerName: true, companyName: true, productCategory: true, budget: true, timeframe: true, description: true,
      productId: true, similarToProductId: true, submittedById: true,
      product: { select: { id: true, title: true, status: true, quantity: true } },
      similarTo: { select: { id: true, title: true, status: true, quantity: true } },
      order: { select: { orderNumber: true, status: true } },
    },
  });
  if (!sr) return { error: 'This quote no longer exists.' };
  const canceledOrder = sr.order?.status === 'CANCELED' ? sr.order.orderNumber : null;
  if (sr.status !== 'CLOSED' && !(sr.status === 'ACCEPTED' && canceledOrder)) {
    return {
      error: sr.status === 'ACCEPTED'
        ? `The buyer accepted this offer${sr.order ? ` (order ${sr.order.orderNumber})` : ''}. Cancel that order first (“Cancel order” in the Deal panel), then open the new quote.`
        : sr.status === 'DECLINED'
          ? 'The buyer declined this offer: send the new offer on this request (“Send offer” — it becomes the next revision).'
          : 'This request is still open: send the new offer on it (“Send offer”).',
    };
  }
  // The same item: that listing again when it can be offered, else "similar to" it.
  const listing = sr.product ?? sr.similarTo;
  const anchor = listing && !sr.similarToProductId && listing.status === 'PUBLISHED' && listing.quantity > 0 ? listing : null;
  const similar = !anchor && listing && listing.status === 'PUBLISHED' ? listing : null;
  const now = new Date();
  const ref = quoteRefOrProforma(sr);
  const guest = sr.customerType === 'GUEST' && !sr.submittedById;
  const token = guest ? makeQuoteAccessToken() : null;
  const created = await prisma.$transaction(async (tx) => {
    const n = await tx.sourcingRequest.create({
      data: {
        buyerEmail: sr.buyerEmail,
        buyerName: sr.buyerName,
        companyName: sr.companyName,
        productCategory: similar ? `Similar to: ${decodeEntities(similar.title).replace(/\s+/g, ' ').trim()}`.slice(0, 120) : sr.productCategory,
        budget: sr.budget,
        timeframe: sr.timeframe,
        description: sr.description,
        productId: anchor?.id ?? null,
        similarToProductId: similar?.id ?? null,
        submittedById: sr.submittedById,
        customerType: sr.customerType,
        accessToken: token,
        accessTokenIssuedAt: token ? now : null,
        accessTokenExpiresAt: token ? quoteTokenExpiry(now) : null,
        assignedToId: session.user.id,
        priority: sr.priority,
        dueAt: computeQuoteDueAt(now, sr.priority),
        lastReplyAt: now,
        lastReplyByStaff: false,
      },
    });
    await tx.quoteMessage.create({
      data: {
        sourcingRequestId: n.id, authorId: session.user.id, isInternalNote: true, fromStaff: true,
        body: `Opened by ${session.user.email} for the same buyer from ${ref} (${canceledOrder ? `its order ${canceledOrder} was canceled` : `closed${sr.lostReason ? `: ${sr.lostReason}` : ''}`}). Send the new offer here.`,
      },
    });
    await tx.quoteMessage.create({
      data: {
        sourcingRequestId: sr.id, authorId: session.user.id, isInternalNote: true, fromStaff: true,
        body: `New quote ${QUOTE_REF(n.id)} opened for this buyer by ${session.user.email}.`,
      },
    });
    return n;
  });
  await audit('quote.clone', QUOTE_REF(created.id), `from ${ref}${canceledOrder ? ` (order ${canceledOrder} canceled)` : ''} · ${anchor ? `listing ${anchor.id}` : similar ? `similar to ${similar.id}` : 'no listing'} · by ${session.user.email}`);
  revalidatePath('/admin/quotes');
  revalidatePath(`/admin/quotes/${sr.id}`);
  revalidatePath('/app/quotes');
  return {
    notice: `New quote ${QUOTE_REF(created.id)} opened for ${sr.buyerName} and assigned to you${!anchor && listing ? ` (the listing can not be offered as is, so it is “similar to” it)` : ''}. Send the offer there — the buyer is told when you do.`,
    sourcingRequestId: created.id,
  };
}

/**
 * Assigned supplier “Decline to quote (hand back)”: the request goes back to
 * the team (unassigned, still open, the reply SLA restarts) with the reason as
 * an internal note and a mail to the intake inbox. The buyer is not told —
 * the team decides (another supplier, or a close with a reason).
 */
export async function handBackQuote(id: string, reason: string): Promise<QuoteActionResult> {
  const session = await requireSession({ redirectTo: '/app' });
  await ensureSettingsLoaded();
  const site = siteName();
  const why = (reason ?? '').trim().slice(0, 1000);
  if (why.length < 4) return { error: 'Tell us why you can not quote (at least 4 characters).' };
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id },
    select: {
      id: true, proformaNumber: true, status: true, assignedToId: true, priority: true, tags: true,
      sellerProposalStatus: true, sellerProposalCents: true, sellerProposalCurrency: true,
      productCategory: true, offerTerms: true, product: { select: { title: true } },
    },
  });
  if (!sr) return { error: 'This quote no longer exists.' };
  if (sr.assignedToId !== session.user.id) return { error: 'This request is not assigned to you (any more).' };
  if (sr.status !== 'PENDING' && sr.status !== 'RESPONDED') {
    return { error: sr.status === 'ACCEPTED' ? `The buyer accepted the offer, so the deal is binding. Contact the ${site} team.` : 'This request is no longer open.' };
  }
  const now = new Date();
  const withdrawn = sr.sellerProposalStatus === 'PENDING' && sr.sellerProposalCents != null
    ? formatPrice(sr.sellerProposalCents, sr.sellerProposalCurrency ?? 'EUR')
    : null;
  const claim = await prisma.sourcingRequest.updateMany({
    where: { id, assignedToId: session.user.id, status: { in: ['PENDING', 'RESPONDED'] } },
    data: {
      assignedToId: null,
      dueAt: computeQuoteDueAt(now, sr.priority),
      slaBreachAt: null,
      tags: Array.from(new Set([...sr.tags, 'HANDED_BACK'])),
      ...(withdrawn ? { sellerProposalStatus: null } : {}),
    },
  });
  if (claim.count !== 1) return { error: 'This request changed meanwhile. Reload the page.' };
  const ref = quoteRefOrProforma(sr);
  const item = offerItemTitle(sr);
  await prisma.quoteMessage.create({
    data: {
      sourcingRequestId: id, authorId: session.user.id, isInternalNote: true, fromStaff: true,
      body: `The supplier (${session.user.email}) declined to quote and handed the request back: ${sentence(why)}${withdrawn ? ` Their pending proposal of ${withdrawn} is withdrawn.` : ''} The buyer was not told — assign another supplier, quote it yourself, or close it with a reason.`,
    },
  });
  await sendInternalEmail({
    to: process.env.QUOTE_INTAKE_EMAIL ?? '',
    subject: `[${ref}] Supplier declined to quote — back with the team`,
    html: mailLayout({
      heading: 'A supplier handed a request back',
      body: [
        `The supplier declined to quote <strong dir="auto">${escapeHtml(item)}</strong> (<strong>${ref}</strong>) and gave it back to the team.`,
        `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;">${escapeHtmlLines(why)}</blockquote>`,
        withdrawn ? `Their pending proposal of ${escapeHtml(withdrawn)} is withdrawn.` : '',
        'The request is unassigned and still open. The buyer was not told anything.',
      ].filter(Boolean),
      cta: { href: `${siteBase()}/admin/quotes/${id}`, label: 'Open the request' },
    }),
  }, 'quotes:handback');
  await notifyAdmins(`Supplier declined to quote — ${ref}`, `${item}: ${why}`.slice(0, 400), `/admin/quotes/${id}`, 'QUOTE_NEW');
  await audit('quote.handback', ref, `by ${session.user.email}: ${why.slice(0, 300)}${withdrawn ? ` · proposal ${withdrawn} withdrawn` : ''}`);
  revalidatePath(`/app/seller/inbox/${id}`);
  revalidatePath('/app/seller/inbox');
  revalidatePath(`/admin/quotes/${id}`);
  revalidatePath('/admin/quotes');
  return { notice: `Handed back to the ${site} team with your reason. The buyer is not notified; the request no longer shows in your inbox.` };
}

/**
 * Staff detach a request from its listing (it becomes “similar to” that unit)
 * or move it to another listing — e.g. a request anchored to a unit that sold
 * before any offer. Not while an offer is open: the buyer could accept that
 * offer for the other unit. A unit held for the request is released. Audited.
 */
export async function setQuoteProduct(input: { sourcingRequestId: string; productId: string | null; note?: string | null }): Promise<QuoteActionResult> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:proforma', { redirectTo: '/admin/quotes' });
  await ensureSettingsLoaded();
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: input.sourcingRequestId },
    select: {
      id: true, proformaNumber: true, status: true, quotedPriceCents: true, validUntilAt: true, productId: true, similarToProductId: true,
      product: { select: { id: true, title: true } },
      order: { select: { status: true, paymentSubmittedAt: true } },
    },
  });
  if (!sr) return { error: 'This quote no longer exists.' };
  if (sr.status !== 'PENDING' && sr.status !== 'RESPONDED') return { error: 'Only an open request can change its listing (this one is accepted, declined or closed).' };
  if (offerPhase(sr, sr.order) === 'open') {
    return { error: 'An offer is open on this request, and the buyer could accept it for the other unit. Change the listing before you send an offer (or once the offer expired).' };
  }
  const target = input.productId
    ? await prisma.product.findUnique({ where: { id: input.productId }, select: { id: true, title: true, status: true, quantity: true } })
    : null;
  if (input.productId && !target) return { error: 'That listing no longer exists.' };
  if (target && target.id === sr.productId) return { notice: 'The request is already on this listing.' };
  const old = sr.product;
  if (!target && !old) return { notice: 'This request has no listing to detach.' };
  const note = (input.note ?? '').trim().slice(0, 500);
  const data = target
    ? { productId: target.id, similarToProductId: null }
    : { productId: null, similarToProductId: old!.id, productCategory: `Similar to: ${decodeEntities(old!.title).replace(/\s+/g, ' ').trim()}`.slice(0, 120) };
  let released = 0;
  try {
    released = await prisma.$transaction(async (tx) => {
      const claim = await tx.sourcingRequest.updateMany({ where: { id: sr.id, status: sr.status, productId: sr.productId }, data });
      if (claim.count !== 1) throw new StatusClaimLost();
      const units = await releaseQuoteHold(sr.id, target ? 'Quote moved to another listing' : 'Quote detached from its listing', tx);
      await tx.quoteMessage.create({
        data: {
          sourcingRequestId: sr.id, authorId: session.user.id, isInternalNote: true, fromStaff: true,
          body: `${target ? `Listing changed${old ? ` from “${decodeEntities(old.title)}”` : ''} to “${decodeEntities(target.title)}”` : `Detached from “${decodeEntities(old!.title)}” — now a request for a similar unit`} by ${session.user.email}.${note ? ` ${sentence(note)}` : ''}${units ? ' The held unit went back on sale.' : ''}`,
        },
      });
      return units;
    });
  } catch (e) {
    if (e instanceof StatusClaimLost) return { error: 'This request changed meanwhile. Reload the page.' };
    throw e;
  }
  await audit('quote.product.set', quoteRefOrProforma(sr), `${old?.id ?? '-'} → ${target ? target.id : `similar to ${old!.id}`} by ${session.user.email}${note ? ` · "${note.slice(0, 120)}"` : ''}${released ? ` · ${released} unit(s) released` : ''}`);
  revalidatePath(`/admin/quotes/${sr.id}`);
  revalidatePath('/admin/quotes');
  const warn = target && (target.status !== 'PUBLISHED' || target.quantity < 1)
    ? ` Note: that listing is ${target.status !== 'PUBLISHED' ? 'not published' : 'out of stock'} — an offer on it needs ${target.status !== 'PUBLISHED' ? 'the “not published” override' : 'the unit back in stock'}.`
    : '';
  return { notice: `${target ? 'Listing changed.' : 'Detached: the request is now for a similar unit.'}${released ? ' The held unit went back on sale.' : ''}${warn}` };
}

/** Why a decline / close claim found the quote changed — read again, said as it is. */
async function statusClaimLost(id: string, status: 'DECLINED' | 'CLOSED', expectedRevision: number): Promise<QuoteActionResult> {
  const fresh = await prisma.sourcingRequest.findUnique({ where: { id }, select: { status: true, offerRevision: true, order: { select: { orderNumber: true } } } });
  if (fresh?.status === 'ACCEPTED') {
    return {
      error: status === 'DECLINED'
        ? `You accepted this offer a moment ago${fresh.order ? ` (order ${fresh.order.orderNumber})` : ''}. To cancel it, use “Cancel order” on the payment page while it is unpaid.`
        : `The buyer accepted the offer a moment ago${fresh.order ? ` (order ${fresh.order.orderNumber})` : ''}, so nothing was closed or sent. Use “Cancel order” in the Deal panel if the deal must not go ahead.`,
    };
  }
  if (fresh?.status === status) return { notice: status === 'DECLINED' ? 'This offer is already declined.' : 'This request is already closed.' };
  if (status === 'DECLINED' && fresh?.status === 'RESPONDED' && fresh.offerRevision !== expectedRevision) return { error: OFFER_UPDATED_BEFORE_DECLINE };
  if (status === 'DECLINED' && fresh?.status === 'CLOSED') return { error: 'This request was closed a moment ago, so there is no offer to decline.' };
  return { error: 'This quote changed meanwhile. Reload the page and try again.' };
}

async function setQuoteStatusCore(
  id: string,
  status: 'DECLINED' | 'CLOSED',
  opts: { reason?: string | null; note?: string | null; offerRevision?: number },
): Promise<QuoteActionResult> {
  if (status !== 'DECLINED' && status !== 'CLOSED') {
    return { error: 'Use "Accept offer" to accept an offer.' };
  }
  const session = await requireSession({ redirectTo: '/app' });
  await ensureSettingsLoaded();
  const site = siteName();
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id },
    select: {
      id: true, proformaNumber: true,
      submittedById: true,
      assignedToId: true,
      status: true,
      archivedAt: true,
      offerRevision: true,
      quotedPriceCents: true,
      quotedCurrency: true,
      offerSubtotalCents: true, offerShippingCents: true, offerVatTreatment: true, offerVatRateBp: true, offerVatCents: true, offerTotalCents: true, offerTerms: true,
      description: true,
      productId: true,
      productCategory: true,
      buyerName: true,
      buyerEmail: true,
      accessToken: true,
      assignedTo: { select: { role: true, email: true } },
      product: { select: { title: true, brand: { select: { name: true } } } },
    },
  });
  if (!sr) return { error: 'This quote no longer exists.' };

  const role = (session.user as { role?: string }).role;
  const isAdmin = role === 'ADMIN';
  const isBuyer = sr.submittedById === session.user.id;
  const isAssignee = sr.assignedToId === session.user.id;
  // The buyer declines an offer; only staff close a request. A supplier hands
  // the request back to the team instead (handBackQuote): the buyer's request
  // stays open and the team decides what to tell them.
  if (status === 'CLOSED' && !isAdmin) {
    return { error: isAssignee ? `Use “Decline to quote (hand back)” instead: the request goes back to the ${site} team, who take it from there.` : 'You are not allowed to change this quote.' };
  }
  if (status === 'DECLINED' && !isAdmin && !isBuyer) return { error: 'You are not allowed to change this quote.' };
  if (isAdmin && !isBuyer && !isAssignee) {
    await requireCapability('quotes:status', { redirectTo: '/admin/quotes' });
  }

  // Once accepted, the deal is binding: the buyer cancels the ORDER (payment
  // page, while unpaid) and only staff cancel it otherwise — never the
  // supplier, and never through "decline" / "close".
  if (sr.status === 'ACCEPTED') {
    const o = await prisma.order.findUnique({ where: { sourcingRequestId: id }, select: { orderNumber: true, status: true } });
    if (status === 'DECLINED') {
      return { error: `You already accepted this offer${o ? ` (order ${o.orderNumber})` : ''}. To cancel it, use “Cancel order” on the payment page while it is unpaid, or contact support.` };
    }
    if (o && o.status !== 'CANCELED') {
      return { error: `The buyer accepted this offer (order ${o.orderNumber}). Use “Cancel order” in the Deal panel: it voids the proforma, releases the unit and emails the buyer.` };
    }
  }
  if (status === 'DECLINED') {
    if (sr.status === 'DECLINED') return { notice: 'This offer is already declined.' };
    if (sr.status === 'CLOSED') return { error: 'This request is closed, so there is no offer to decline.' };
    if (sr.status !== 'RESPONDED' || sr.quotedPriceCents == null) return { error: 'There is no offer to decline yet.' };
    if (opts.offerRevision !== undefined && opts.offerRevision !== sr.offerRevision) return { error: OFFER_UPDATED_BEFORE_DECLINE };
  }
  if (status === 'CLOSED' && sr.status === 'CLOSED') {
    if (!sr.archivedAt && autoArchiveOnClose()) {
      await prisma.sourcingRequest.updateMany({ where: { id, status: 'CLOSED', archivedAt: null }, data: { archivedAt: new Date(), archivedById: session.user.id } });
      await audit('quote.archive', quoteRefOrProforma(sr), `auto on CLOSE by ${session.user.email}`);
      revalidatePath('/admin/quotes');
      return { notice: 'This request is already closed; it was archived.' };
    }
    return { notice: 'This request is already closed.' };
  }

  // Declining or closing ends the deal, so an unpaid order linked to it (old
  // auto-created orders) must stop being payable. A paid order is a real sale
  // (managed on the order page), and a buyer's payment proof in flight wins.
  const linked = await prisma.order.findUnique({
    where: { sourcingRequestId: id },
    select: { orderNumber: true, status: true, paymentSubmittedAt: true },
  });
  if (linked && linked.status !== 'PENDING_PAYMENT' && linked.status !== 'CANCELED') {
    return {
      error: `Order ${linked.orderNumber} is already ${linked.status.toLowerCase().replace(/_/g, ' ')} — manage it from the order page instead.`,
    };
  }
  if (linked?.status === 'PENDING_PAYMENT' && linked.paymentSubmittedAt) {
    return {
      error: isAdmin
        ? `The buyer already sent a payment proof for order ${linked.orderNumber}. Verify or reject it on the order before closing this quote.`
        : `A payment proof was already sent for order ${linked.orderNumber}. Contact support if you want to cancel it.`,
    };
  }

  // Closing archives only when the owner wants it (default: stays in Lost).
  const shouldAutoArchive = status === 'CLOSED' && !sr.archivedAt && autoArchiveOnClose();
  const lost = {
    lostReason: opts.reason ?? (status === 'CLOSED' ? `Closed by ${site}` : null),
    lostNote: opts.note ?? null,
  };
  const expectedRevision = opts.offerRevision ?? sr.offerRevision;
  // The claim names the exact state decided on: a decline only the offer the
  // buyer looked at; a close only a request nobody accepted meanwhile (an
  // accepted one only when its order is canceled, checked above). An
  // acceptance that committed first wins — then nothing is canceled or mailed.
  const where: Prisma.SourcingRequestWhereInput = { id, ...statusClaimFilter(status, sr.status, expectedRevision) };
  let canceledOrder: string | null = null;
  let released = 0;
  try {
    ({ canceledOrder, released } = await prisma.$transaction(async (tx) => {
      const claim = await tx.sourcingRequest.updateMany({
        where,
        data: { status, dueAt: null, ...lost, ...(shouldAutoArchive ? { archivedAt: new Date(), archivedById: session.user.id } : {}) },
      });
      if (claim.count !== 1) throw new StatusClaimLost();
      const pending = await tx.order.findFirst({
        where: { sourcingRequestId: id, status: 'PENDING_PAYMENT', paymentSubmittedAt: null },
        select: { orderNumber: true },
      });
      const cancel = await tx.order.updateMany({
        where: { sourcingRequestId: id, status: 'PENDING_PAYMENT', paymentSubmittedAt: null },
        data: { status: 'CANCELED' },
      });
      // A proof that landed after the check above wins: roll the close back.
      const proofPending = await tx.order.count({
        where: { sourcingRequestId: id, status: 'PENDING_PAYMENT', paymentSubmittedAt: { not: null } },
      });
      if (proofPending > 0) throw new ProofInFlightError();
      // A unit held for this offer (STOCK_RESERVE_ON = OFFER_SENT) goes back on sale.
      const units = await releaseQuoteHold(id, status === 'DECLINED' ? 'Offer declined by the buyer' : 'Quote closed without a deal', tx);
      return {
        canceledOrder: cancel.count === 1 ? pending?.orderNumber ?? null : null,
        released: units,
      };
    }));
  } catch (e) {
    if (e instanceof ProofInFlightError) {
      return { error: 'A payment proof was just submitted for this order, so the quote stays open. Review the order first.' };
    }
    if (e instanceof StatusClaimLost) return statusClaimLost(id, status, expectedRevision);
    throw e;
  }
  const ref = quoteRefOrProforma(sr);
  const itemTitle = sr.product || sr.productCategory || sr.offerTerms ? offerItemTitle(sr) : null;
  await audit('quote.status', ref, `${sr.status} → ${status} by ${session.user.email}${status === 'DECLINED' ? ` · r${expectedRevision}` : ''}${opts.reason ? ` · reason: ${opts.reason}` : ''}${opts.note ? ` · "${opts.note.slice(0, 120)}"` : ''}${released ? ` · ${released} unit(s) released` : ''}`);
  if (shouldAutoArchive) {
    await audit('quote.archive', ref, `auto on CLOSE by ${session.user.email}`);
  }
  if (canceledOrder) {
    await audit('order.cancel', canceledOrder, `quote ${ref} ${status.toLowerCase()} by ${session.user.email}`);
    revalidatePath('/app/orders');
    revalidatePath('/admin/orders');
  }
  if (status === 'DECLINED') {
    const offerShown = sr.quotedPriceCents != null ? offerAmounts(sr) : null;
    const amount = offerShown ? `${formatPrice(offerShown.totalCents, sr.quotedCurrency || 'EUR')}${offerShown.vatDecided ? '' : ' excl. VAT'}` : null;
    if (opts.note || opts.reason) {
      await prisma.quoteMessage.create({
        data: {
          sourcingRequestId: id,
          authorId: session.user.id,
          fromStaff: false,
          body: `Offer declined${opts.reason ? ` — ${opts.reason}` : ''}.${opts.note ? `\n${opts.note}` : ''}`,
        },
      });
    }
    await notifyAdmins(
      `Offer declined — ${ref}`,
      `${sr.buyerName} declined${amount ? ` the offer of ${amount}` : ' the offer'}${opts.reason ? ` (${opts.reason})` : ''}.${canceledOrder ? ` Order ${canceledOrder} was canceled.` : ''} You can send a new offer on the same request.`,
      `/admin/quotes/${id}`,
      'SYSTEM',
    );
    if (sr.assignedToId && sr.assignedTo?.role === 'SELLER') {
      await notifyUser(sr.assignedToId, `Offer declined — ${ref}`, `The buyer declined the offer${opts.reason ? ` (${opts.reason})` : ''}.`, `/app/seller/inbox/${id}`);
    }
    const inbox = staffQuoteInbox(sr);
    await sendInternalEmail({
      to: inbox.to,
      subject: `[${ref}] The buyer declined the offer${opts.reason ? ` — ${headerText(opts.reason, 60)}` : ''}`,
      html: mailLayout({
        heading: 'The buyer declined the offer',
        body: [
          mailP(`${inbox.toSeller ? 'The buyer' : `<span dir="auto">${escapeHtml(sr.buyerName)}</span> &lt;${escapeHtml(sr.buyerEmail)}&gt;`} declined ${amount && !(inbox.toSeller && !sellerSeesSellPrice()) ? `the offer of <strong>${escapeHtml(amount)}</strong>` : 'the offer'}${itemTitle ? ` for <strong dir="auto">${escapeHtml(itemTitle)}</strong>` : ''} on quote <strong>${ref}</strong>.`),
          `Reason: <strong>${escapeHtml(opts.reason ?? 'none given')}</strong>`,
          opts.note ? `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;">${escapeHtmlLines(opts.note)}</blockquote>` : '',
          released ? `${released} reserved unit(s) went back on sale.` : '',
          inbox.toSeller ? '' : 'A new offer can be sent on the same request (it becomes the next revision).',
        ].filter(Boolean),
        cta: { href: `${siteBase()}${inbox.toSeller ? `/app/seller/inbox/${id}` : `/admin/quotes/${id}`}`, label: 'Open the quote' },
      }),
    }, 'quotes:decline-staff');
  }
  // Closing (staff "Close (no deal)") ends the deal for the buyer: tell them it
  // is over, why (the close reason and note) and that any open order is no
  // longer payable — in the conversation and by mail. Fires once (the claim).
  let buyerNotified = false;
  let buyerEmailError: string | null = null;
  if (status === 'CLOSED') {
    const why = opts.reason ? sentence(opts.reason) : '';
    await prisma.quoteMessage.create({
      data: {
        sourcingRequestId: id,
        authorId: session.user.id,
        fromStaff: true,
        body: `Request closed without a deal${opts.reason ? ` — ${opts.reason}` : ''}.${opts.note ? `\n${opts.note}` : ''}${canceledOrder ? `\nOrder ${canceledOrder} was canceled, so no payment is due.` : ''}`,
      },
    });
    const orderLine = canceledOrder ? ` Order ${canceledOrder} was canceled, so no payment is due.` : '';
    await notifyUser(
      sr.submittedById,
      `Quote ${ref} was closed`,
      `Your request was closed without a deal.${why ? ` ${why}` : ''}${orderLine} If you still need the item, open a new request.`.slice(0, 480),
      `/app/quotes/${id}`,
    );
    buyerNotified = !!sr.submittedById;
    const sent = await trySendEmail({
      to: sr.buyerEmail,
      subject: `[${ref}] Your quote request was closed`,
      html: mailLayout({
        heading: 'Your quote request was closed',
        body: [
          `Hi <span dir="auto">${escapeHtml(sr.buyerName)}</span>,`,
          `Your request <strong>${ref}</strong>${itemTitle ? ` for <strong dir="auto">${escapeHtml(itemTitle)}</strong>` : ''} was closed without a deal.`,
          opts.reason ? `Reason: <strong>${escapeHtml(opts.reason)}</strong>` : '',
          opts.note ? `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;">${escapeHtmlLines(opts.note)}</blockquote>` : '',
          canceledOrder ? `Order <strong>${canceledOrder}</strong> was canceled, so <strong>no payment is due</strong>. Please don’t send a transfer for it. If you already paid, contact our support team and we’ll sort it out.` : '',
          `If you still need the item, you can open a new request on ${escapeHtml(site)} at any time.`,
        ].filter(Boolean),
        cta: { href: buyerQuoteLink(sr), label: 'View the quote' },
      }),
    }, 'quotes:close');
    if (sent.ok) buyerNotified = true;
    else buyerEmailError = sent.error;
    if (sr.assignedToId && sr.assignedToId !== session.user.id) {
      await notifyUser(
        sr.assignedToId,
        `Quote ${ref} was closed`,
        `${site} closed this request without a deal.`,
        sr.assignedTo?.role === 'SELLER' ? `/app/seller/inbox/${id}` : `/admin/quotes/${id}`,
      );
    }
  }
  revalidatePath(`/app/quotes/${id}`);
  revalidatePath('/app/quotes');
  revalidatePath(`/app/seller/inbox/${id}`);
  revalidatePath(`/admin/quotes/${id}`);
  revalidatePath('/admin/quotes');

  if (status === 'CLOSED') {
    const parts = [`Request closed${opts.reason ? ` (${opts.reason})` : ''}.`];
    if (canceledOrder) parts.push(`Order ${canceledOrder} was canceled.`);
    if (released) parts.push(`${released} reserved unit(s) went back on sale.`);
    if (shouldAutoArchive) parts.push('The request was archived.');
    if (buyerEmailError) {
      return {
        warning: `${parts.join(' ')} ${sr.submittedById ? 'The buyer was notified in their dashboard, but the' : 'The'} email to ${sr.buyerEmail} could not be delivered (${buyerEmailError}).`,
      };
    }
    if (buyerNotified) parts.push('The buyer was notified.');
    return { notice: parts.join(' ') };
  }
  return {
    notice: `You declined the offer.${canceledOrder ? ` Order ${canceledOrder} was canceled.` : ''} The ${site} team was told${opts.reason ? ' why' : ''}.`,
  };
}

/**
 * Form entry point. Known failures come back as a readable `error` instead of a
 * throw: production builds replace thrown messages with a generic "Server
 * Components render" error, so the buyer never learned why nothing was sent.
 */
export async function submitAndRedirect(input: SourcingInputType): Promise<{ error: string; captcha?: boolean }> {
  if (!(await getServerSession())) {
    return { error: 'You are signed out. Sign in again, then send your request.' };
  }
  let result: Awaited<ReturnType<typeof submitSourcingRequest>>;
  try {
    result = await submitSourcingRequest(input);
  } catch (e) {
    if (e instanceof PublicFormError) return { error: e.message, captcha: e.captcha };
    return { error: quoteSubmitError(e) };
  }
  // Empty id => the hidden anti-bot field was filled. Buyers are signed in, so
  // this is almost always browser autofill; say so rather than fake a success.
  if (!result.id) {
    return { error: 'Your request was not sent: your browser auto-filled a hidden field. Reload the page and type your request without autofill.' };
  }
  redirect(`/let-us-find-it/thanks?id=${result.id}`);
}

const QUOTE_FIELD_LABELS: Record<string, string> = {
  description: 'Your description',
  buyerName: 'Your name',
  companyName: 'Company / Institution',
  productCategory: 'Equipment category',
  budget: 'Budget',
  timeframe: 'Timeframe',
};

function quoteSubmitError(e: unknown): string {
  if (e instanceof z.ZodError) {
    const issue = e.issues[0];
    const field = String(issue?.path[0] ?? '');
    if (issue?.code === 'too_small' && field === 'description') {
      return 'Please describe what you need in at least 20 characters.';
    }
    if (issue?.code === 'too_small' && field === 'buyerName') {
      return 'Your account has no name. Add your name in your profile, then try again.';
    }
    if (issue?.code === 'too_big') {
      return `${QUOTE_FIELD_LABELS[field] ?? 'One of the fields'} is too long. Please shorten it and try again.`;
    }
    return 'Some details are invalid. Please check the form and try again.';
  }
  const msg = e instanceof Error ? e.message : '';
  if (msg.startsWith('Too many submissions')) return msg;
  console.error('[quotes] submit failed', e);
  return 'Something went wrong and your request was not sent. Please try again in a minute.';
}

// ────────────────────────────────────────────────────────────────────────────
//   Lifecycle: priority / assignment / archive / delete / magic-link reissue
//   (parity with SupportTicket production-hardening pass)
// ────────────────────────────────────────────────────────────────────────────

const ALLOWED_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT', 'VIP'] as const;
type AllowedQuotePriority = (typeof ALLOWED_PRIORITIES)[number];

export async function setQuotePriority(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:status', { redirectTo: '/admin/quotes' });
  const id = String(formData.get('quoteId') ?? '');
  const priority = String(formData.get('priority') ?? '') as AllowedQuotePriority;
  if (!id || !ALLOWED_PRIORITIES.includes(priority)) return { ok: false, message: 'Invalid priority.' };
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id }, select: { id: true, proformaNumber: true, priority: true, dueAt: true },
  });
  if (!sr) return { ok: false, message: 'Quote not found.' };
  await ensureSettingsLoaded();
  // The SLA clock only runs while the request waits on our team; a new priority
  // re-times it then, and never restarts it for a deal waiting on the buyer.
  await prisma.sourcingRequest.update({
    where: { id },
    data: { priority, ...(sr.dueAt ? { dueAt: computeQuoteDueAt(new Date(), priority), slaBreachAt: null } : {}) },
  });
  await audit('quote.priority', quoteRefOrProforma(sr), `${sr.priority} → ${priority} by ${session.user.email}`);
  revalidatePath('/admin/quotes');
  revalidatePath(`/admin/quotes/${id}`);
  return { ok: true, message: `Priority set to ${priority}.` };
}

export async function claimQuote(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:assign', { redirectTo: '/admin/quotes' });
  const id = String(formData.get('quoteId') ?? '');
  if (!id) return { ok: false, message: 'Missing quote id.' };
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id }, select: { id: true, proformaNumber: true, assignedToId: true },
  });
  if (!sr) return { ok: false, message: 'Quote not found.' };
  if (sr.assignedToId === session.user.id) return { ok: false, message: 'Already yours.' };
  await prisma.sourcingRequest.update({ where: { id }, data: { assignedToId: session.user.id } });
  await audit('quote.claim', quoteRefOrProforma(sr), `claimer=${session.user.email}${sr.assignedToId ? ` (took from ${sr.assignedToId})` : ''}`);
  revalidatePath('/admin/quotes');
  revalidatePath(`/admin/quotes/${id}`);
  return { ok: true, message: 'Claimed.' };
}

export async function transferQuote(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:assign', { redirectTo: '/admin/quotes' });
  await ensureSettingsLoaded();
  const id = String(formData.get('quoteId') ?? '');
  const toUserId = String(formData.get('toUserId') ?? '');
  if (!id || !toUserId) return { ok: false, message: 'Missing fields.' };
  const [sr, target] = await Promise.all([
    prisma.sourcingRequest.findUnique({ where: { id }, select: { id: true, proformaNumber: true, assignedToId: true } }),
    prisma.user.findUnique({ where: { id: toUserId }, select: { email: true, role: true } }),
  ]);
  if (!sr) return { ok: false, message: 'Quote not found.' };
  if (!target || (target.role !== 'ADMIN' && target.role !== 'SELLER')) {
    return { ok: false, message: 'Target must be an admin or seller.' };
  }
  await prisma.sourcingRequest.update({ where: { id }, data: { assignedToId: toUserId } });
  // Sellers can't open /admin pages; they work quotes from their seller inbox.
  const href = target.role === 'SELLER' ? `/app/seller/inbox/${id}` : `/admin/quotes/${id}`;
  await notifyUser(toUserId, `Quote ${quoteRefOrProforma(sr)} transferred to you`, `${session.user.email} transferred a quote to you.`, href);
  // Placeholder addresses (imported sellers) are skipped; never fatal.
  await sendInternalEmail({
    to: target.email,
    subject: `[${quoteRefOrProforma(sr)}] A quote was transferred to you`,
    html: mailLayout({
      heading: 'A quote was transferred to you',
      body: [`Quote <strong>${quoteRefOrProforma(sr)}</strong> was transferred to you on ${escapeHtml(siteName())}. Open it to reply to the buyer or send an offer.`],
      cta: { href: `${siteBase()}${href}`, label: 'Open the quote' },
    }),
  }, 'quotes:transfer');
  await audit('quote.transfer', quoteRefOrProforma(sr), `from=${session.user.email} to=${target.email}`);
  revalidatePath('/admin/quotes');
  revalidatePath(`/admin/quotes/${id}`);
  return { ok: true, message: `Transferred to ${target.email}.` };
}

export async function archiveQuote(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:archive', { redirectTo: '/admin/quotes' });
  const id = String(formData.get('quoteId') ?? '');
  if (!id) return { ok: false, message: 'Missing quote id.' };
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id }, select: { id: true, proformaNumber: true, archivedAt: true },
  });
  if (!sr) return { ok: false, message: 'Quote not found.' };
  if (sr.archivedAt) return { ok: false, message: 'Already archived.' };
  await prisma.sourcingRequest.update({
    where: { id },
    data: { archivedAt: new Date(), archivedById: session.user.id },
  });
  await audit('quote.archive', quoteRefOrProforma(sr), session.user.email);
  revalidatePath('/admin/quotes');
  return { ok: true, message: 'Archived.' };
}

export async function unarchiveQuote(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:archive', { redirectTo: '/admin/quotes' });
  const id = String(formData.get('quoteId') ?? '');
  if (!id) return { ok: false, message: 'Missing quote id.' };
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id }, select: { id: true, proformaNumber: true, archivedAt: true },
  });
  if (!sr) return { ok: false, message: 'Quote not found.' };
  if (!sr.archivedAt) return { ok: false, message: 'Not archived.' };
  await prisma.sourcingRequest.update({ where: { id }, data: { archivedAt: null, archivedById: null } });
  await audit('quote.unarchive', quoteRefOrProforma(sr), session.user.email);
  revalidatePath('/admin/quotes');
  return { ok: true, message: 'Restored.' };
}

export async function bulkArchiveQuotes(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:archive', { redirectTo: '/admin/quotes' });
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No quotes selected.' };
  const targets = await prisma.sourcingRequest.findMany({
    where: { id: { in: ids }, archivedAt: null },
    select: { id: true, proformaNumber: true },
  });
  if (targets.length === 0) return { ok: false, count: 0, message: 'None of the selected quotes are unarchived.' };
  await prisma.sourcingRequest.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { archivedAt: new Date(), archivedById: session.user.id },
  });
  await audit('quote.bulkarchive', undefined, `${targets.length} quotes by ${session.user.email}`);
  revalidatePath('/admin/quotes');
  return { ok: true, count: targets.length, message: `Archived ${targets.length} quote${targets.length === 1 ? '' : 's'}.` };
}

export async function bulkUnarchiveQuotes(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:archive', { redirectTo: '/admin/quotes' });
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No quotes selected.' };
  const targets = await prisma.sourcingRequest.findMany({
    where: { id: { in: ids }, archivedAt: { not: null } },
    select: { id: true },
  });
  if (targets.length === 0) return { ok: false, count: 0, message: 'None of the selected quotes are archived.' };
  await prisma.sourcingRequest.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { archivedAt: null, archivedById: null },
  });
  await audit('quote.bulkunarchive', undefined, `${targets.length} quotes by ${session.user.email}`);
  revalidatePath('/admin/quotes');
  return { ok: true, count: targets.length, message: `Restored ${targets.length} quote${targets.length === 1 ? '' : 's'}.` };
}

export async function deleteQuotePermanently(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:delete', { redirectTo: '/admin/quotes' });
  const id = String(formData.get('quoteId') ?? '');
  if (!id) return { ok: false, message: 'Missing quote id.' };
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id },
    select: {
      id: true, proformaNumber: true, buyerName: true, buyerEmail: true,
      status: true, priority: true, archivedAt: true,
      _count: { select: { messages: true } },
    },
  });
  if (!sr) return { ok: false, message: 'Quote not found.' };
  if (!sr.archivedAt) return { ok: false, message: 'Archive the quote first, then delete.' };
  // A05: a quote with an offer / acceptance / proforma / order / staff reply is
  // a business record — it stays archived (the DB refuses accepted quotes too).
  const blockers = await quoteDeletionBlockers(sr.id);
  if (blockers.length) {
    await audit('quote.delete.refused', quoteRefOrProforma(sr), blockers.join('; ').slice(0, 480));
    return { ok: false, message: `Quote ${quoteRefOrProforma(sr)} cannot be deleted: ${blockers.join('; ')}. It stays archived as a business record.` };
  }
  const snap = { ref: quoteRefOrProforma(sr), name: sr.buyerName, email: sr.buyerEmail, status: sr.status, priority: sr.priority, msgs: sr._count.messages };
  await audit('quote.delete.permanent', quoteRefOrProforma(sr), JSON.stringify(snap).slice(0, 480));
  await prisma.sourcingRequest.delete({ where: { id } });
  revalidatePath('/admin/quotes');
  return { ok: true, message: `Quote ${quoteRefOrProforma(sr)} permanently deleted.` };
}

export async function bulkDeleteQuotes(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:delete', { redirectTo: '/admin/quotes' });
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No quotes selected.' };
  const targets = await prisma.sourcingRequest.findMany({
    where: { id: { in: ids }, archivedAt: { not: null } },
    select: { id: true, proformaNumber: true, buyerEmail: true, status: true, priority: true },
  });
  if (targets.length === 0) {
    return { ok: false, count: 0, message: 'None of the selected quotes are archived. Archive them first.' };
  }
  const deletable: typeof targets = [];
  const kept: string[] = [];
  for (const t of targets) {
    const blockers = await quoteDeletionBlockers(t.id);
    if (blockers.length) kept.push(`${quoteRefOrProforma(t)} (${blockers.join(', ')})`);
    else deletable.push(t);
  }
  for (const t of deletable) {
    await audit('quote.delete.permanent', quoteRefOrProforma(t), `bulk · ${t.buyerEmail} · ${t.status} · ${t.priority}`);
  }
  if (deletable.length) await prisma.sourcingRequest.deleteMany({ where: { id: { in: deletable.map((t) => t.id) } } });
  revalidatePath('/admin/quotes');
  return {
    ok: deletable.length > 0,
    count: deletable.length,
    message: `Deleted ${deletable.length} quote${deletable.length === 1 ? '' : 's'}.${kept.length ? ` Kept (business records, stay archived): ${kept.join('; ')}.` : ''}`,
  };
}

export async function reissueQuoteMagicLink(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:reply', { redirectTo: '/admin/quotes' });
  await ensureSettingsLoaded();
  const id = String(formData.get('quoteId') ?? '');
  if (!id) return { ok: false, message: 'Missing quote id.' };
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id },
    select: { id: true, proformaNumber: true, buyerName: true, buyerEmail: true, customerType: true },
  });
  if (!sr) return { ok: false, message: 'Quote not found.' };
  if (sr.customerType !== 'GUEST') {
    return { ok: false, message: 'Only GUEST quotes have magic links.' };
  }
  const now = new Date();
  const newToken = makeQuoteAccessToken();
  await prisma.sourcingRequest.update({
    where: { id },
    data: {
      accessToken: newToken,
      accessTokenIssuedAt: now,
      accessTokenExpiresAt: quoteTokenExpiry(now),
    },
  });

  const href = `${siteBase()}/quotes/t/${newToken}`;
  const sent = await trySendEmail({
    to: sr.buyerEmail,
    subject: `[${quoteRefOrProforma(sr)}] New link to view your quote`,
    html: mailLayout({
      heading: `Here’s a fresh link, ${sr.buyerName}`,
      body: [`Our team rotated the access link on quote <strong>${quoteRefOrProforma(sr)}</strong>. Any previous link no longer works.`],
      cta: { href, label: 'View quote' },
      footer: ['This link is valid for 14 days. Keep it private.'],
    }),
  }, 'quotes:magiclink');
  await audit('quote.magiclink.reissue', quoteRefOrProforma(sr), `by ${session.user.email}`);
  revalidatePath(`/admin/quotes/${id}`);
  return sent.ok
    ? { ok: true, message: `New link emailed to ${sr.buyerEmail}.` }
    : { ok: true, message: `New link created (the old one no longer works), but the email to ${sr.buyerEmail} could not be delivered (${sent.error}).` };
}
