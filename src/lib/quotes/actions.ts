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
import { QUOTE_REF, offerMaxCents, endOfDayUtc, fmtDay, isoDay, offerPhase, quoteRef, PAID_ORDER_STATES } from '@/lib/quotes/offer';
import { vatTreatmentLabel, type VatTreatmentCode } from '@/lib/tax/determine';
import { billingAddressJson, parseDetailsInput, shippingAddressJson, type DetailsFieldErrors, type OrderDetails } from '@/lib/orders/details';
import {
  autoArchiveOnClose, declineReasons, offerCurrencies, offerDefaults, offerIncoterms, openOfferHoldDays, quoteSlaHours,
  requireTermsAcceptance, sellerMarkupBp, sellerOffersRequireApproval, sellerPriceRounding, sellerSeesSellPrice, stockReserveOn, termsOfSaleUrl, vatIdRule,
} from '@/lib/quotes/policy';
import {
  applyMarkup, daysFrom, fillPaymentTermsText, incotermLabel, offerAmounts, parseOfferTerms, pctLabel, type OfferTerms,
} from '@/lib/quotes/pricing';
import { decideVatForDetails, offerVatAtSend, offerVatLines, vatExplanation } from '@/lib/quotes/engine';
import { holdUnitForQuote, releaseQuoteHold, unitAvailability } from '@/lib/quotes/stock';
import { mailLayout, mailTable } from '@/lib/quotes/mail';

// ────────────────────────────────────────────────────────────────────────────
//   Mirror of Support-ticket production-hardening helpers
// ────────────────────────────────────────────────────────────────────────────

/** Reply deadline for a request waiting on lab2date (QUOTE_SLA_HOURS per priority). */
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

  // If anchored to a product, route to that product's seller.
  let productId: string | null = null;
  let assignedToId: string | null = null;
  if (parsed.productSlug) {
    const product = await prisma.product.findUnique({
      where: { slug: parsed.productSlug },
      select: { id: true, sellerId: true, title: true },
    });
    if (product) {
      productId = product.id;
      assignedToId = product.sellerId;
    }
  }
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

  // Confirmation to buyer — REGISTERED gets dashboard CTA, GUEST gets magic-link.
  // The request is already saved: a failed confirmation is logged, not thrown,
  // or the buyer is told "not sent" and resubmits duplicates.
  const buyerCta = accessToken
    ? `${siteBase()}/quotes/t/${accessToken}`
    : `${siteBase()}/app/quotes/${created.id}`;
  await trySendEmail({
    to: parsed.buyerEmail,
    subject: created.product
      ? `Quote request received: ${headerText(created.product.title, 120)}`
      : 'lab2date sourcing request received',
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:540px;">
        <h2 style="color:#0E4F40;">We&rsquo;ve got your request</h2>
        <p>Hi <span dir="auto">${escapeHtml(parsed.buyerName)}</span>, our team and the supplier will review your request and send you an <strong>offer</strong> (price, terms and how long it is valid) ${escapeHtml(quoteTurnaroundPhrase())}.</p>
        <p>Nothing is ordered until you accept that offer. You can accept or decline it from your dashboard.</p>
        ${created.product ? `<p><strong>Product:</strong> <span dir="auto">${escapeHtml(created.product.title)}</span></p>` : ''}
        <p><strong>What you wrote:</strong></p>
        <blockquote dir="auto" style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${escapeHtmlLines(parsed.description)}</blockquote>
        <p style="margin:18px 0;">
          <a href="${buyerCta}" style="background:#0E4F40;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
            ${accessToken ? 'View / reply to your quote' : 'Open in dashboard'}
          </a>
        </p>
        ${accessToken ? `<p style="color:#888;font-size:11px;">This is a private link tied to your request — keep it to yourself. Valid for 14 days.</p>` : ''}
        <p style="color:#888;font-size:12px;">Reference: ${QUOTE_REF(created.id)}</p>
      </div>
    `,
  }, 'quotes:confirmation');

  // Notify assignee (seller or platform inbox). Imported sellers carry
  // placeholder addresses, so those go to the intake inbox. The request is
  // already saved: a failed staff notification must not fail the buyer's submit
  // (they'd see an error and resubmit, creating duplicates).
  // Sellers never learn who the buyer is (lab2date mediates), so a seller copy
  // carries no buyer identity and links to the seller inbox; staff and intake
  // copies link to the admin workspace, which labels internal notes.
  const inbox = staffQuoteInbox(created);
  const assigneeLink = inbox.toSeller
    ? `${siteBase()}/app/seller/inbox/${created.id}`
    : `${siteBase()}/admin/quotes/${created.id}`;
  await sendInternalEmail({
    to: inbox.to,
    subject: created.product
      ? `New quote request: ${headerText(created.product.title, 120)}`
      : facilityLabel ? `New access request — ${headerText(facilityLabel, 120)}`
      : inbox.toSeller ? 'New sourcing request' : `New sourcing request from ${headerText(parsed.buyerName)}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:540px;">
        <h2 style="color:#0E4F40;">${created.product ? 'Quote request' : 'Sourcing request'}</h2>
        ${inbox.toSeller ? '' : `<p>From <strong dir="auto">${escapeHtml(parsed.buyerName)}</strong> &lt;${escapeHtml(parsed.buyerEmail)}&gt;${parsed.companyName ? ` · <span dir="auto">${escapeHtml(parsed.companyName)}</span>` : ''}</p>`}
        ${created.product ? `<p><strong>Product:</strong> <span dir="auto">${escapeHtml(created.product.title)}</span></p>` : ''}
        ${facilityLabel ? `<p><strong>Facility:</strong> ${escapeHtml(facilityLabel)}</p>` : ''}
        ${parsed.budget ? `<p><strong>Budget:</strong> <span dir="auto">${escapeHtml(parsed.budget)}</span></p>` : ''}
        ${parsed.timeframe ? `<p><strong>Timeframe:</strong> <span dir="auto">${escapeHtml(parsed.timeframe)}</span></p>` : ''}
        <p><strong>Description:</strong></p>
        <blockquote dir="auto" style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${escapeHtmlLines(parsed.description)}</blockquote>
        <p>Reply with questions or send the buyer an offer: <a href="${assigneeLink}">${inbox.toSeller ? 'Open in seller inbox' : 'Open in admin'}</a></p>
      </div>
    `,
  }, 'quotes:intake');

  await notifyAdmins(
    'New quote request',
    `${parsed.buyerName}: ${created.product?.title ?? parsed.productCategory ?? 'sourcing request'}`,
    `/admin/quotes/${created.id}`,
    'QUOTE_NEW',
  );

  await audit(
    'quote.submit',
    QUOTE_REF(created.id),
    `type=${customerType} buyer=${parsed.buyerEmail}${productId ? ` productId=${productId}` : ''}${assignedToId ? ` assignee=${assignedToId}` : ''}`,
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
  // Admin/seller-only flag. Buyer cannot post internal notes — even if they
  // tried to inject `internal: '1'` the action would refuse (see check below).
  internal: z.boolean().optional(),
});

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
  const isInternalNote = !!parsed.internal && (isAdmin || isAssignee);
  const fromStaff = isAdmin || isAssignee;
  const now = new Date();

  await prisma.quoteMessage.create({
    data: {
      sourcingRequestId: parsed.sourcingRequestId,
      body: parsed.body,
      authorId: session.user.id,
      attachments: parsed.attachments ?? [],
      isInternalNote,
      fromStaff,
    },
  });

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
      const buyerLink = sr.submittedById || !sr.accessToken
        ? `${siteBase()}/app/quotes/${sr.id}`
        : `${siteBase()}/quotes/t/${sr.accessToken}`;
      const sent = await trySendEmail({
        to: sr.buyerEmail,
        subject: `[${quoteRefOrProforma(sr)}] New reply on your lab2date quote`,
        html: mailLayout({
          heading: 'New reply on your quote',
          body: [`We replied to your quote request <strong>${quoteRefOrProforma(sr)}</strong>.`],
          cta: { href: buyerLink, label: 'Read the reply' },
        }),
      }, 'quotes:reply');
      if (!sent.ok) {
        warning = `Reply saved and visible to the buyer in their dashboard, but the email to ${isAdmin ? sr.buyerEmail : 'the buyer'} could not be delivered (${sent.error}).`;
      }
      if (sr.submittedById) {
        await notifyUser(
          sr.submittedById,
          'New reply on your quote',
          'The supplier responded to your quote request.',
          `/app/quotes/${sr.id}`,
        );
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
        html: `<p>The buyer replied on quote <strong>${quoteRefOrProforma(sr)}</strong>.</p><p><a href="${inbox.toSeller ? `${siteBase()}/app/seller/inbox/${sr.id}` : `${siteBase()}/admin/quotes/${sr.id}`}">Open the thread</a> to read it and respond.</p>`,
      }, 'quotes:buyer-reply');
    }
  }

  await audit(
    isInternalNote ? 'quote.note.add' : 'quote.reply',
    quoteRefOrProforma(sr),
    `${session.user.email}${parsed.attachments?.length ? ` +${parsed.attachments.length}attach` : ''}`,
  );

  revalidatePath(`/app/quotes/${parsed.sourcingRequestId}`);
  revalidatePath(`/app/seller/inbox/${parsed.sourcingRequestId}`);
  revalidatePath(`/admin/quotes/${parsed.sourcingRequestId}`);
  revalidatePath('/admin/quotes');
  return warning ? { warning } : {};
}

// ────────────────────────────────────────────────────────────────────────────
//   Offer → acceptance
// ────────────────────────────────────────────────────────────────────────────

const OfferInput = z.object({
  sourcingRequestId: z.string().min(1),
  /** Unit price (excl. VAT). For a supplier: their price to lab2date. */
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
};

async function loadQuoteForOffer(id: string) {
  return prisma.sourcingRequest.findUnique({
    where: { id },
    include: {
      product: { select: { id: true, title: true, vatScheme: true } },
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
  const goodsCents = c.unitCents * c.qty;
  const itemTitle = sr.product?.title ?? sr.productCategory ?? 'Requested equipment';
  const money = (x: number) => formatPrice(x, c.currency);

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
  const previousAmounts = sr.status === 'RESPONDED' && sr.quotedPriceCents != null ? offerAmounts(sr) : null;
  const isUpdate = !!previousAmounts;
  const terms: OfferTerms = {
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
  };
  const linked = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: { id: true, orderNumber: true, status: true, paymentSubmittedAt: true, adminNotes: true },
  });
  const holdDays = openOfferHoldDays();
  const holdUntil = holdDays ? new Date(Math.min(c.validUntil.getTime(), now.getTime() + holdDays * 86_400_000)) : c.validUntil;

  let detachedOrder: string | null = null;
  const nextRevision = (sr.offerRevision ?? 0) + 1;
  try {
    await prisma.$transaction(async (tx) => {
      // Guarded write: a buyer who accepted / declined in the meantime wins.
      const claim = await tx.sourcingRequest.updateMany({
        where: { id: sr.id, status: { in: ['PENDING', 'RESPONDED'] }, offerRevision: sr.offerRevision },
        data: {
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
            adminNotes: `${linked.adminNotes ? `${linked.adminNotes}\n` : ''}[${isoDay(now)}] Unlinked from quote ${QUOTE_REF(sr.id)}: a new offer was sent (the order was created by the old auto-accept flow and never paid).`.slice(0, 4000),
          },
        });
        detachedOrder = linked.orderNumber;
      }
      if (sr.productId && mode === 'OFFER_SENT') {
        const hold = await holdUnitForQuote(tx, { quoteId: sr.id, productId: sr.productId, qty: c.qty, expiresAt: holdUntil });
        if (!hold.ok) throw new OfferBlockedError(`The listed unit could not be reserved for this offer: ${hold.message}`);
      }
      await tx.quoteMessage.create({
        data: {
          sourcingRequestId: sr.id,
          authorId: c.actorId,
          fromStaff: true,
          body: [
            `${isUpdate ? 'Updated offer' : 'Offer'} (revision ${nextRevision}) for "${itemTitle}": ${c.qty > 1 ? `${c.qty} × ${money(c.unitCents)} = ` : ''}${money(goodsCents)}${c.shippingCents ? ` + freight ${money(c.shippingCents)}` : ''} excl. VAT${d ? `; VAT ${pctLabel(d.rateBp)}: ${money(vatCents ?? 0)}; total ${money(totalCents)}` : '; VAT is determined from your billing details when you accept'}. Valid until ${fmtDay(c.validUntil)}.`,
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
  const buyerLink = sr.submittedById || !sr.accessToken ? `${siteBase()}/app/quotes/${sr.id}` : `${siteBase()}/quotes/t/${sr.accessToken}`;
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
        offerMailRows(amounts),
        prevLine,
        termsMailRows(terms, c.validUntil),
        c.note ? `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;color:#374151;">${escapeHtmlLines(c.note)}</blockquote>` : '',
      ].filter(Boolean),
      cta: { href: buyerLink, label: 'Review and accept the offer' },
      footer: [
        'Nothing is ordered yet. When you accept, you confirm your billing and delivery details; we then create your order and email you the proforma invoice (PDF) with the bank details.',
        `Terms of sale: <a href="${escapeHtml(termsOfSaleUrl().startsWith('/') ? `${siteBase()}${termsOfSaleUrl()}` : termsOfSaleUrl())}">${escapeHtml(termsOfSaleUrl())}</a> · Reference ${QUOTE_REF(sr.id)}`,
      ],
    }),
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
      `lab2date sent the buyer an offer based on your price for "${itemTitle}". You will be notified when the buyer decides.`,
      `/app/seller/inbox/${sr.id}`,
    );
  }
  await audit(
    isUpdate ? 'quote.offer.update' : 'quote.offer.send',
    QUOTE_REF(sr.id),
    `r${nextRevision} · ${itemTitle} · ${c.qty}×${money(c.unitCents)} + freight ${money(c.shippingCents)} · vat=${d ? `${d.treatment} ${pctLabel(d.rateBp)}` : 'at acceptance'} · total ${money(totalCents)} · validUntil=${isoDay(c.validUntil)}${previousAmounts ? ` · was ${formatPrice(previousAmounts.totalCents, sr.quotedCurrency || 'EUR')}` : ''}${c.supplierCostCents != null ? ` · supplier ${formatPrice(c.supplierCostCents, c.currency)}` : ''}${detachedOrder ? ` · unlinked legacy order ${detachedOrder}` : ''}${sent.ok ? '' : ` · buyer email failed: ${sent.error}`} · by ${c.actorEmail}`,
  );

  revalidatePath(`/app/quotes/${sr.id}`);
  revalidatePath(`/app/seller/inbox/${sr.id}`);
  revalidatePath(`/admin/quotes/${sr.id}`);
  revalidatePath('/admin/quotes');
  revalidatePath('/app/quotes');

  // Sellers never see the buyer's address.
  const who = c.isAdmin ? sr.buyerEmail : 'the buyer';
  const what = `${isUpdate ? 'Offer updated' : 'Offer sent'}: ${money(totalCents)}${d ? '' : ' excl. VAT (VAT at acceptance)'}, valid until ${fmtDay(c.validUntil)}.`;
  if (!sent.ok) {
    return { warning: `${what} It is saved and the buyer sees it in their dashboard, but the email to ${who} could not be delivered (${sent.error}).` };
  }
  return { notice: `${what} Emailed to ${who}${detachedOrder ? `; old unpaid order ${detachedOrder} was canceled` : ''}.` };
}

/**
 * Staff / assigned supplier "Send offer". Staff publish the offer to the buyer.
 * A supplier's price is a PROPOSAL to lab2date when SELLER_OFFERS_REQUIRE_APPROVAL
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
  if (sr.status === 'ACCEPTED') {
    const o = await prisma.order.findUnique({ where: { sourcingRequestId: sr.id }, select: { orderNumber: true } });
    return {
      error: `The buyer already accepted this offer${o ? ` (order ${o.orderNumber}` : ''}${sr.proformaNumber ? `${o ? ', ' : ' ('}proforma ${sr.proformaNumber})` : o ? ')' : ''}, so its price can no longer be changed. Cancel that order first (Deal panel), then send a new offer on a new quote.`,
    };
  }
  if (sr.status === 'DECLINED' || sr.status === 'CLOSED') {
    return { error: `This quote is ${sr.status === 'DECLINED' ? 'declined' : 'closed'}, so no new offer can be sent on it. Open a new quote for the buyer instead.` };
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
  if (isAssignee && !isAdmin) {
    if (sellerOffersRequireApproval()) {
      return submitSellerProposal(sr, session.user.id, {
        priceCents: p.priceCents * p.qty, currency: p.currency, note: clean(p.note), leadTime: clean(p.leadTime), warranty: clean(p.warranty),
      });
    }
    // Review off: the buyer gets the supplier price + lab2date's margin.
    const sellUnit = applyMarkup(p.priceCents, sellerMarkupBp(), sellerPriceRounding());
    return publishOffer({
      sr, actorId: session.user.id, actorEmail: session.user.email, isAdmin: false,
      unitCents: sellUnit, qty: p.qty, currency: p.currency, shippingCents: p.shippingCents, note: clean(p.note), validUntil,
      incoterm: incoterm ?? defaults.incoterm, incotermPlace: clean(p.incotermPlace) ?? defaults.incotermPlace,
      leadTime: clean(p.leadTime) ?? clean(defaults.leadTime), warranty: clean(p.warranty),
      paymentDays: p.paymentDays ?? defaults.paymentTermDays,
      supplierCostCents: p.priceCents * p.qty, approvesProposal: false, bySupplierDirect: true,
    });
  }

  const proposalPending = sr.sellerProposalStatus === 'PENDING' && sr.sellerProposalCents != null;
  return publishOffer({
    sr, actorId: session.user.id, actorEmail: session.user.email, isAdmin,
    unitCents: p.priceCents, qty: p.qty, currency: p.currency, shippingCents: p.shippingCents, note: clean(p.note), validUntil,
    incoterm, incotermPlace: clean(p.incotermPlace), leadTime: clean(p.leadTime), warranty: clean(p.warranty),
    paymentDays: p.paymentDays ?? defaults.paymentTermDays,
    // A pending supplier proposal is approved by this offer (its cost is the margin basis).
    supplierCostCents: proposalPending ? sr.sellerProposalCents : sr.offerSupplierCostCents ?? null,
    approvesProposal: proposalPending, bySupplierDirect: false,
  });
}

/** A supplier's price goes to lab2date for review (A30) — the buyer sees nothing yet. */
async function submitSellerProposal(
  sr: NonNullable<Awaited<ReturnType<typeof loadQuoteForOffer>>>,
  sellerId: string,
  p: { priceCents: number; currency: string; note: string | null; leadTime: string | null; warranty: string | null },
): Promise<QuoteActionResult> {
  const now = new Date();
  const claim = await prisma.sourcingRequest.updateMany({
    where: { id: sr.id, status: { in: ['PENDING', 'RESPONDED'] } },
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
  if (claim.count !== 1) return { error: 'This quote changed meanwhile (accepted, declined or closed). Reload the page.' };
  const itemTitle = sr.product?.title ?? sr.productCategory ?? 'Requested equipment';
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
  return { notice: `Proposal sent to lab2date for review: ${money} (excl. VAT). The buyer sees an offer once lab2date approves it — you are notified then.` };
}

/** Staff decline a supplier proposal (with a note the supplier sees). */
export async function rejectSellerProposal(input: { sourcingRequestId: string; note: string }): Promise<QuoteActionResult> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/quotes' });
  await requireCapability('quotes:proforma', { redirectTo: '/admin/quotes' });
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
    await notifyUser(sr.assignedToId, `Proposal not used — ${QUOTE_REF(sr.id)}`, `lab2date did not send your proposal to the buyer: ${note.slice(0, 160)}`, `/app/seller/inbox/${sr.id}`);
    if (sr.assignedTo?.role === 'SELLER') {
      await sendInternalEmail({
        to: sr.assignedTo.email,
        subject: `[${QUOTE_REF(sr.id)}] Your proposal was not sent to the buyer`,
        html: mailLayout({
          heading: 'Your proposal was not sent to the buyer',
          body: [`lab2date reviewed your proposal of ${escapeHtml(formatPrice(sr.sellerProposalCents ?? 0, sr.sellerProposalCurrency ?? 'EUR'))} and did not send it:`, `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;">${escapeHtmlLines(note)}</blockquote>`, 'You can send a new proposal from your seller inbox.'],
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
  complianceNote: string | null;
};

async function loadQuoteForAcceptance(id: string) {
  return prisma.sourcingRequest.findUnique({
    where: { id },
    include: {
      product: { select: { id: true, title: true, vatScheme: true, brand: { select: { name: true } } } },
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
    return { ok: false, result: { error: 'This quote is closed, so its offer can no longer be accepted. Open a new request if you still need the item.' } };
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
  const parsed = parseDetailsInput(p.details ?? {}, { vatIdRule: vatIdRule() });
  if (!parsed.ok) return { ok: false, result: { error: parsed.message, fieldErrors: parsed.fieldErrors } };
  const details = parsed.details;

  const terms = parseOfferTerms(sr.offerTerms);
  const amounts = offerAmounts(sr);
  const qty = terms?.qty ?? 1;
  const unitCents = terms?.unitCents || Math.round(amounts.goodsCents / qty);
  const vat = await decideVatForDetails(details, offerVatLines({ goodsCents: amounts.goodsCents, shippingCents: amounts.shippingCents, scheme: sr.product?.vatScheme ?? null }));
  for (const c of [vat.shipTo, vat.billing]) {
    if (c?.mode === 'BLOCK') {
      return { ok: false, result: { error: `${c.reason} The offer can not be accepted with these details — contact us in the conversation below.`, fieldErrors: { [c === vat.shipTo ? 'd_country' : 'b_country']: 'not allowed' } } };
    }
  }
  const d = vat.decision;
  if (d.blocked) {
    return { ok: false, result: { error: `This sale is not possible with these details: ${d.reasons.join(' ')}` } };
  }
  if (d.reviewRequired) {
    await notifyAdmins(
      `Acceptance needs a VAT decision — ${QUOTE_REF(sr.id)}`,
      `The buyer tried to accept, but the VAT could not be decided: ${d.reasons.join(' ')}`.slice(0, 400),
      `/admin/quotes/${sr.id}`,
      'SYSTEM',
    );
    return {
      ok: false,
      result: {
        error: `We could not determine the VAT for these details right now: ${d.reasons.join(' ')} Please try again later — our team has been notified${details.billing.vatId ? ', or remove the VAT ID to accept with VAT charged' : ''}.`,
      },
    };
  }
  const goodsLine = d.lines.find((l) => l.lineType === 'GOODS');
  const totalCents = amounts.goodsCents + amounts.shippingCents + d.taxCents;
  const review = [vat.shipTo, vat.billing].find((c) => c?.mode === 'REVIEW');
  return {
    ok: true,
    prep: {
      sr,
      details,
      terms,
      decisionReasons: d.reasons,
      vatTreatment: d.treatment,
      vatRateBp: d.rateBp,
      shippingRateBp: d.shippingRateBp,
      lineVat: { rateBp: goodsLine?.rateBp ?? d.rateBp, taxCents: goodsLine?.taxCents ?? 0 },
      vatIdEvidence: vat.vatId,
      complianceNote: review ? review.reason : null,
      preview: {
        currency: sr.quotedCurrency || 'EUR',
        qty,
        unitCents,
        goodsCents: amounts.goodsCents,
        shippingCents: amounts.shippingCents,
        vatCents: d.taxCents,
        vatRateBp: d.rateBp,
        vatTreatment: d.treatment,
        vatLabel: vatTreatmentLabel(d.treatment),
        vatExplanation: vatExplanation(d),
        legalText: d.legalText,
        totalCents,
        differsFromOffer: amounts.vatDecided ? amounts.totalCents !== totalCents : true,
        offerTotalCents: amounts.vatDecided ? amounts.totalCents : null,
        complianceReview: review ? review.reason : null,
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
 * bank snapshot). Then redirect to the payment page at once — the proforma PDF
 * and the emails go out after the response, so a busy PDF queue never stalls
 * the acceptance. A double click / second tab is sent to the same order.
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
  const buyerId = sr.submittedById ?? session.user.id;
  const currency = preview.currency;
  const itemTitle = sr.product?.title ?? sr.productCategory ?? 'Requested equipment';
  const lineTruth = sr.productId ? (await orderLineTruthFor([sr.productId])).get(sr.productId) : undefined;
  const warrantySnapshot = terms?.warranty ?? lineTruth?.warrantySnapshot ?? null;
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
  // A REVIEW country: a pre-payment hold like checkout's (lib/checkout/holds.ts —
  // openHolds + holdReason). The order is not payable until staff clear it; the
  // payment term restarts then (releaseHold).
  const hold = r.prep.complianceNote
    ? { holdReason: 'COMPLIANCE' as const, holdNote: `COMPLIANCE: Export compliance check before payment: ${r.prep.complianceNote}`.slice(0, 1000), holdAt: now, openHolds: ['COMPLIANCE'], payableSince: null }
    : { openHolds: [] as string[], payableSince: now };
  const orderTerms = { kind: 'PREPAY', days: preview.dueDays, text: terms?.paymentTerms.text ?? fillPaymentTermsText(offerDefaults().paymentTermsText, preview.dueDays), incoterm: terms?.incoterm ?? null, incotermPlace: terms?.incotermPlace ?? null, leadTime: terms?.leadTime ?? null };

  let order: { id: string; orderNumber: string; proformaId: string; number: string };
  try {
    order = await prisma.$transaction(async (tx) => {
      const claim = await tx.sourcingRequest.updateMany({
        where: { id: sr.id, status: 'RESPONDED', offerRevision: sr.offerRevision, quotedPriceCents: sr.quotedPriceCents, ...(sr.quotedAt ? { quotedAt: sr.quotedAt } : {}) },
        data: { status: 'ACCEPTED', proformaIssuedAt: now, submittedById: buyerId, archivedAt: null, archivedById: null, dueAt: null, slaBreachAt: null },
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
        conditionSnapshot: lineTruth?.conditionSnapshot ?? null,
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
          throw new AcceptBlockedError('Sorry — this unit was just sold or reserved by another buyer, so the offer can not be accepted. Ask us for an alternative in the conversation below.');
        }
      }
      // The proforma: gap-free PF number + immutable snapshot, in THIS transaction.
      const pf = await issueProforma(created.id, { tx, actorId: session.user.id, dueDate });
      if (!pf.ok) throw new Error(`Proforma could not be issued: ${pf.message}`);
      const number = pf.document.number;
      await tx.sourcingRequest.update({ where: { id: sr.id }, data: { proformaNumber: number } });
      await tx.quoteMessage.create({
        data: {
          sourcingRequestId: sr.id,
          authorId: session.user.id,
          fromStaff: false,
          body: `Offer accepted (revision ${sr.offerRevision}): ${money(preview.totalCents)} incl. ${preview.vatRateBp ? `VAT ${pctLabel(preview.vatRateBp)}` : 'VAT 0%'} for "${itemTitle}". Order ${created.orderNumber} and proforma ${number} were created — payment due by ${fmtDay(dueDate)}.${r.prep.complianceNote ? ` Note: ${r.prep.complianceNote}` : ''}`,
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
      return { ...created, proformaId: pf.document.id, number };
    });
  } catch (e) {
    const raced = e instanceof AcceptRaceError || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002');
    if (raced) {
      // A parallel request (double click / second tab) won: send this one to the same order.
      const fresh = await prisma.sourcingRequest.findUnique({ where: { id: sr.id }, select: { status: true, order: { select: { orderNumber: true } } } });
      if (fresh?.status === 'ACCEPTED' && fresh.order) redirect(`/app/orders/${fresh.order.orderNumber}/payment`);
      return { error: 'This offer changed while you were accepting it. Review the current offer and try again.' };
    }
    if (e instanceof AcceptBlockedError) {
      if (/sold or reserved/.test(e.message)) {
        await notifyAdmins(`Acceptance refused: unit no longer available — ${QUOTE_REF(sr.id)}`, `${itemTitle}: the buyer tried to accept, but the unit is sold or held for another deal.`, `/admin/quotes/${sr.id}`, 'SYSTEM');
      }
      return { error: e.message };
    }
    throw e;
  }

  await audit(
    'quote.offer.accept',
    order.number,
    `order=${order.orderNumber} r${sr.offerRevision} total=${money(preview.totalCents)} vat=${preview.vatTreatment} ${pctLabel(preview.vatRateBp)} by ${session.user.email} ip=${ip ?? '-'} ua="${(ua ?? '-').slice(0, 120)}" terms=${requireTermsAcceptance() ? `${termsOfSaleUrl()} accepted` : 'not required'}${r.prep.complianceNote ? ' · compliance hold' : ''}`,
  );

  const sendAll = async () => {
    const paymentUrl = `${siteBase()}/app/orders/${order.orderNumber}/payment`;
    const pdfUrl = absoluteDocumentHref('proforma', order.orderNumber, 'pdf');
    // Render the issued proforma ONCE from its snapshot and store it; the email attaches exactly those bytes.
    // Compliance hold (REVIEW country): no payment request until staff clear it —
    // the proforma goes out then (clearOrderHold), not now.
    const onHold = !!r.prep.complianceNote;
    const doc = onHold ? { attachment: null, error: null } : await documentAttachment({ id: order.proformaId, number: order.number });
    const attachments = doc.attachment ? [doc.attachment] : [];
    const bank = await prisma.fiscalDocument.findUnique({ where: { id: order.proformaId }, select: { snapshot: true } });
    const snap = bank?.snapshot as { bank?: { beneficiary: string; bankName: string; iban: string; bic: string } | null } | null;
    const b = snap?.bank ?? null;
    const payRows: Array<[string, string, boolean?]> = b
      ? [
          ['Beneficiary', escapeHtml(b.beneficiary)],
          ...(b.bankName ? [['Bank', escapeHtml(b.bankName)] as [string, string]] : []),
          ['IBAN', `<span style="font-family:ui-monospace,monospace;">${escapeHtml(b.iban)}</span>`],
          ...(b.bic ? [['BIC', `<span style="font-family:ui-monospace,monospace;">${escapeHtml(b.bic)}</span>`] as [string, string]] : []),
          ['Reference', `<strong>${escapeHtml(order.number)}</strong>`],
          ['Amount', escapeHtml(money(preview.totalCents)), true],
          ['Pay by', `<strong>${escapeHtml(fmtDay(dueDate))}</strong>`],
        ]
      : [['Reference', escapeHtml(order.number)], ['Amount', escapeHtml(money(preview.totalCents)), true], ['Pay by', escapeHtml(fmtDay(dueDate))]];
    const proformaHtml = mailLayout({
      heading: `Thank you — your order ${order.orderNumber} is confirmed`,
      body: [
        `Hi <span dir="auto">${escapeHtml(sr.buyerName)}</span>,`,
        onHold
          ? `You accepted our offer for <strong dir="auto">${escapeHtml(itemTitle)}</strong>. We created order <strong>${order.orderNumber}</strong>.`
          : `You accepted our offer for <strong dir="auto">${escapeHtml(itemTitle)}</strong>. We created order <strong>${order.orderNumber}</strong> and proforma invoice <strong>${order.number}</strong>${doc.attachment ? ' (attached as PDF)' : ''}.`,
        offerMailRows({ qty: preview.qty, unitCents: preview.unitCents, goodsCents: preview.goodsCents, shippingCents: preview.shippingCents, vatDecided: true, vatRateBp: preview.vatRateBp, vatCents: preview.vatCents, vatLabel: preview.vatLabel, totalCents: preview.totalCents, currency }),
        r.prep.complianceNote
          ? `<p style="margin:0 0 12px;padding:10px;border-radius:8px;background:#fffbeb;border:1px solid #fcd34d;"><strong>Please do not pay yet.</strong> ${escapeHtml(r.prep.complianceNote)} We email you as soon as the check is done.</p>`
          : `<h3 style="color:#0E4F40;margin:16px 0 6px;font-size:15px;">How to pay</h3>${mailTable(payRows)}${b ? '' : '<p style="margin:0 0 12px;">Our bank details are on the payment page.</p>'}`,
        onHold ? '' : 'After paying, upload your bank receipt on the payment page so we can verify it and ship.',
      ].filter(Boolean),
      cta: { href: paymentUrl, label: 'Go to the payment page' },
      footer: onHold
        ? ['We send you the proforma invoice with the bank details as soon as the check is done.']
        : [`${doc.attachment ? 'Your proforma invoice is attached.' : 'Your proforma invoice is ready on the payment page.'} You can also <a href="${pdfUrl}">download the PDF</a> at any time (sign-in required).`],
    });
    const buyerMail = await trySendEmail({
      to: sr.buyerEmail,
      subject: onHold
        ? `Order ${order.orderNumber} received — export check before payment (${headerText(itemTitle, 70)})`
        : `Proforma invoice ${order.number} — order ${order.orderNumber} (${headerText(itemTitle, 80)})`,
      html: proformaHtml,
      attachments,
    }, 'quotes:accept');
    if (buyerMail.ok && !onHold) await markDocumentSent(order.proformaId);
    const copyTo = companyCopyAddress();
    if (copyTo) await sendInternalEmail({ to: copyTo, subject: `[copy] Proforma invoice ${order.number} — order ${order.orderNumber}`, html: proformaHtml, attachments }, 'quotes:accept-copy');
    // Staff / assigned seller — sellers never see who the buyer is.
    const inbox = staffQuoteInbox(sr);
    await sendInternalEmail({
      to: inbox.to,
      subject: `[${QUOTE_REF(sr.id)}] Offer accepted — order ${order.orderNumber}`,
      html: mailLayout({
        heading: 'Offer accepted',
        body: [
          `${inbox.toSeller ? 'The buyer' : `<span dir="auto">${escapeHtml(sr.buyerName)}</span> &lt;${escapeHtml(sr.buyerEmail)}&gt;${details.billing.legalName ? ` (<span dir="auto">${escapeHtml(details.billing.legalName)}</span>)` : ''}`} accepted the offer for <strong dir="auto">${escapeHtml(itemTitle)}</strong>${inbox.toSeller && !sellerSeesSellPrice() ? '' : `: <strong>${escapeHtml(money(preview.totalCents))}</strong> (${escapeHtml(preview.vatLabel)})`}.`,
          `Order <strong>${order.orderNumber}</strong> · proforma <strong>${order.number}</strong> · payment due ${escapeHtml(fmtDay(dueDate))}.${r.prep.complianceNote ? ` <strong>On compliance hold:</strong> ${escapeHtml(r.prep.complianceNote)}` : ' Awaiting the buyer’s bank transfer.'}`,
          buyerMail.ok ? '' : `<strong>The proforma email to the buyer could not be delivered</strong> (${escapeHtml(buyerMail.error)}).`,
        ].filter(Boolean),
        cta: { href: `${siteBase()}${inbox.toSeller ? `/app/seller/inbox/${sr.id}` : `/admin/quotes/${sr.id}`}`, label: 'Open the quote' },
      }),
    }, 'quotes:accept-staff');
    await notifyUser(buyerId, `Offer accepted — order ${order.orderNumber}`, `Proforma ${order.number} is ready. Pay ${money(preview.totalCents)} by bank transfer by ${fmtDay(dueDate)} and upload the receipt.`, `/app/orders/${order.orderNumber}/payment`);
    if (sr.assignedToId && sr.assignedTo?.role === 'SELLER') {
      await notifyUser(sr.assignedToId, `Offer accepted — ${QUOTE_REF(sr.id)}`, `The buyer accepted the offer for "${itemTitle}". Awaiting payment.`, `/app/seller/inbox/${sr.id}`);
    }
    await notifyAdmins(
      `Offer accepted — order ${order.orderNumber}`,
      `${itemTitle} · ${money(preview.totalCents)} · proforma ${order.number}${buyerMail.ok ? '' : ' · proforma email to the buyer FAILED'}${doc.attachment ? '' : ' · PDF not attached'}${r.prep.complianceNote ? ' · COMPLIANCE HOLD' : ''}`,
      `/admin/quotes/${sr.id}`,
      'ORDER_FROM_QUOTE',
    );
    if (!buyerMail.ok || doc.error) {
      await audit('quote.offer.accept.mail', order.number, `${buyerMail.ok ? 'email ok' : `email failed: ${buyerMail.error}`}${doc.error ? ` · pdf: ${doc.error}` : ''}`);
    }
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

// ── Decline / close ─────────────────────────────────────────────────────────

/** The buyer declines an open offer, optionally saying why. */
export async function declineOffer(input: { sourcingRequestId: string; reason?: string | null; note?: string | null }): Promise<QuoteActionResult> {
  await ensureSettingsLoaded();
  const reasons = declineReasons();
  const reason = (input.reason ?? '').trim();
  if (reason && !reasons.includes(reason)) return { error: 'Choose one of the listed reasons (or none).' };
  const note = (input.note ?? '').trim().slice(0, 1000) || null;
  return setQuoteStatusCore(input.sourcingRequestId, 'DECLINED', { reason: reason || null, note });
}

class ProofInFlightError extends Error {}

export async function setQuoteStatus(id: string, status: 'DECLINED' | 'CLOSED'): Promise<QuoteActionResult> {
  return setQuoteStatusCore(id, status, {});
}

async function setQuoteStatusCore(
  id: string,
  status: 'DECLINED' | 'CLOSED',
  opts: { reason?: string | null; note?: string | null },
): Promise<QuoteActionResult> {
  if (status !== 'DECLINED' && status !== 'CLOSED') {
    return { error: 'Use "Accept offer" to accept an offer.' };
  }
  const session = await requireSession({ redirectTo: '/app' });
  await ensureSettingsLoaded();
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id },
    select: {
      id: true, proformaNumber: true,
      submittedById: true,
      assignedToId: true,
      status: true,
      archivedAt: true,
      quotedPriceCents: true,
      quotedCurrency: true,
      offerSubtotalCents: true, offerShippingCents: true, offerVatTreatment: true, offerVatRateBp: true, offerVatCents: true, offerTotalCents: true,
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
  // Buyer can decline, seller can close. Admin can do both (with cap).
  const allowed =
    isAdmin ||
    (sr.submittedById === session.user.id && status === 'DECLINED') ||
    (sr.assignedToId === session.user.id && status === 'CLOSED');
  if (!allowed) return { error: 'You are not allowed to change this quote.' };
  if (isAdmin && sr.submittedById !== session.user.id && sr.assignedToId !== session.user.id) {
    await requireCapability('quotes:status', { redirectTo: '/admin/quotes' });
  }

  // Once accepted, the deal is binding: the buyer cancels the ORDER (payment
  // page, while unpaid) and only lab2date staff cancel it otherwise — never the
  // supplier, and never through "decline" / "close".
  if (sr.status === 'ACCEPTED') {
    const o = await prisma.order.findUnique({ where: { sourcingRequestId: id }, select: { orderNumber: true, status: true } });
    if (status === 'DECLINED') {
      return { error: `You already accepted this offer${o ? ` (order ${o.orderNumber})` : ''}. To cancel it, use “Cancel order” on the payment page while it is unpaid, or contact support.` };
    }
    if (!isAdmin) {
      return { error: `The buyer accepted this offer${o ? ` (order ${o.orderNumber})` : ''}, so it is a binding order. Only lab2date can cancel it — contact the lab2date team.` };
    }
    if (o && o.status !== 'CANCELED') {
      return { error: `The buyer accepted this offer (order ${o.orderNumber}). Use “Cancel order” in the Deal panel: it voids the proforma, releases the unit and emails the buyer.` };
    }
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
  const statusChanged = sr.status !== status;
  const lost = {
    lostReason: opts.reason ?? (status === 'CLOSED' ? 'Closed by lab2date' : null),
    lostNote: opts.note ?? null,
  };
  let changed = false;
  let canceledOrder: string | null = null;
  let released = 0;
  try {
    ({ changed, canceledOrder, released } = await prisma.$transaction(async (tx) => {
      const claim = await tx.sourcingRequest.updateMany({
        where: shouldAutoArchive
          ? { id, OR: [{ status: { not: status } }, { archivedAt: null }] }
          : { id, status: { not: status } },
        data: shouldAutoArchive
          ? { status, archivedAt: new Date(), archivedById: session.user.id, dueAt: null, ...lost }
          : { status, dueAt: null, ...(statusChanged ? lost : {}) },
      });
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
        changed: claim.count === 1,
        canceledOrder: cancel.count === 1 ? pending?.orderNumber ?? null : null,
        released: units,
      };
    }));
  } catch (e) {
    if (e instanceof ProofInFlightError) {
      return { error: 'A payment proof was just submitted for this order, so the quote stays open. Review the order first.' };
    }
    throw e;
  }
  const ref = quoteRefOrProforma(sr);
  const itemTitle = sr.product?.title ?? sr.productCategory ?? null;
  if (changed && statusChanged) {
    await audit('quote.status', ref, `${sr.status} → ${status} by ${session.user.email}${opts.reason ? ` · reason: ${opts.reason}` : ''}${opts.note ? ` · "${opts.note.slice(0, 120)}"` : ''}${released ? ` · ${released} unit(s) released` : ''}`);
  }
  if (changed && shouldAutoArchive) {
    await audit('quote.archive', ref, `auto on CLOSE by ${session.user.email}`);
  }
  if (canceledOrder) {
    await audit('order.cancel', canceledOrder, `quote ${ref} ${status.toLowerCase()} by ${session.user.email}`);
    revalidatePath('/app/orders');
    revalidatePath('/admin/orders');
  }
  if (changed && statusChanged && status === 'DECLINED') {
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
      `${sr.buyerName} declined${amount ? ` the offer of ${amount}` : ' the offer'}${opts.reason ? ` (${opts.reason})` : ''}.${canceledOrder ? ` Order ${canceledOrder} was canceled.` : ''}`,
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
          `${inbox.toSeller ? 'The buyer' : `<span dir="auto">${escapeHtml(sr.buyerName)}</span> &lt;${escapeHtml(sr.buyerEmail)}&gt;`} declined ${amount && !(inbox.toSeller && !sellerSeesSellPrice()) ? `the offer of <strong>${escapeHtml(amount)}</strong>` : 'the offer'}${itemTitle ? ` for <strong dir="auto">${escapeHtml(itemTitle)}</strong>` : ''} on quote <strong>${ref}</strong>.`,
          `Reason: <strong>${escapeHtml(opts.reason ?? 'none given')}</strong>`,
          opts.note ? `<blockquote dir="auto" style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;">${escapeHtmlLines(opts.note)}</blockquote>` : '',
          released ? `${released} reserved unit(s) went back on sale.` : '',
        ].filter(Boolean),
        cta: { href: `${siteBase()}${inbox.toSeller ? `/app/seller/inbox/${id}` : `/admin/quotes/${id}`}`, label: 'Open the quote' },
      }),
    }, 'quotes:decline-staff');
  }
  // Closing (seller "Close request" or admin "Close (no deal)") ends the deal
  // for the buyer, so tell them it is over (and that any open order is no
  // longer payable). Fires once.
  let buyerNotified = false;
  let buyerEmailError: string | null = null;
  if (status === 'CLOSED' && ((changed && statusChanged) || canceledOrder)) {
    const orderLine = canceledOrder ? ` Order ${canceledOrder} was canceled, so no payment is due.` : '';
    await notifyUser(
      sr.submittedById,
      `Quote ${ref} was closed`,
      `Your request was closed without a deal.${orderLine} If you still need the item, open a new request.`,
      `/app/quotes/${id}`,
    );
    buyerNotified = !!sr.submittedById;
    const buyerLink = sr.submittedById || !sr.accessToken ? `${siteBase()}/app/quotes/${id}` : `${siteBase()}/quotes/t/${sr.accessToken}`;
    const sent = await trySendEmail({
      to: sr.buyerEmail,
      subject: `[${ref}] Your quote request was closed`,
      html: mailLayout({
        heading: 'Your quote request was closed',
        body: [
          `Hi <span dir="auto">${escapeHtml(sr.buyerName)}</span>,`,
          `Your request <strong>${ref}</strong>${itemTitle ? ` for <strong dir="auto">${escapeHtml(itemTitle)}</strong>` : ''} was closed without a deal.`,
          canceledOrder ? `Order <strong>${canceledOrder}</strong> was canceled, so <strong>no payment is due</strong>. Please don&rsquo;t send a transfer for it. If you already paid, contact our support team and we&rsquo;ll sort it out.` : '',
          'If you still need the item, you can open a new request on lab2date at any time.',
        ].filter(Boolean),
        cta: { href: buyerLink, label: 'View the quote' },
      }),
    }, 'quotes:close');
    if (sent.ok) buyerNotified = true;
    else buyerEmailError = sent.error;
    if (!isAdmin) {
      await notifyAdmins(
        `Quote closed by the supplier — ${ref}`,
        canceledOrder
          ? `The supplier closed the request without a deal. Order ${canceledOrder} was canceled and the buyer was notified.`
          : 'The supplier closed the request without a deal. The buyer was notified.',
        `/admin/quotes/${id}`,
        'SYSTEM',
      );
    } else if (sr.assignedToId && sr.assignedToId !== session.user.id) {
      await notifyUser(
        sr.assignedToId,
        `Quote ${ref} was closed`,
        'lab2date closed this request without a deal.',
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
    const parts = [changed && statusChanged ? 'Request closed.' : 'This request is closed.'];
    if (canceledOrder) parts.push(`Order ${canceledOrder} was canceled.`);
    if (released) parts.push(`${released} reserved unit(s) went back on sale.`);
    if (shouldAutoArchive && changed) parts.push('The request was archived.');
    if (buyerEmailError) {
      return {
        warning: `${parts.join(' ')} ${sr.submittedById ? 'The buyer was notified in their dashboard, but the' : 'The'} email to ${isAdmin ? sr.buyerEmail : 'the buyer'} could not be delivered (${buyerEmailError}).`,
      };
    }
    if (buyerNotified) parts.push('The buyer was notified.');
    return { notice: parts.join(' ') };
  }
  return {
    notice: changed && statusChanged
      ? `You declined the offer.${canceledOrder ? ` Order ${canceledOrder} was canceled.` : ''} The supplier was told${opts.reason ? ' why' : ''}.`
      : 'This offer is already declined.',
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
  // The SLA clock only runs while the request waits on lab2date; a new priority
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
    html: `<p>Quote <strong>${quoteRefOrProforma(sr)}</strong> was transferred to you on lab2date.</p><p><a href="${siteBase()}${href}">Open the quote</a> to reply to the buyer or send an offer.</p>`,
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

  const site = process.env.SITE_NAME || 'Labtodate';
  const href = `${process.env.BETTER_AUTH_URL ?? ''}/quotes/t/${newToken}`;
  const sent = await trySendEmail({
    to: sr.buyerEmail,
    subject: `[${quoteRefOrProforma(sr)}] New link to view your quote`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:560px;">
        <h2 style="color:#0E4F40;">Here&rsquo;s a fresh link, ${escapeHtml(sr.buyerName)}</h2>
        <p>Your support team rotated the access link on quote <strong>${quoteRefOrProforma(sr)}</strong>. Any previous link no longer works.</p>
        <p style="margin:18px 0;">
          <a href="${href}" style="background:#0E4F40;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
            View quote
          </a>
        </p>
        <p style="color:#888;font-size:11px;">This link is valid for 14 days. Keep it private.</p>
        <p style="color:#888;font-size:12px;">${escapeHtml(site)}</p>
      </div>`,
  }, 'quotes:magiclink');
  await audit('quote.magiclink.reissue', quoteRefOrProforma(sr), `by ${session.user.email}`);
  revalidatePath(`/admin/quotes/${id}`);
  return sent.ok
    ? { ok: true, message: `New link emailed to ${sr.buyerEmail}.` }
    : { ok: true, message: `New link created (the old one no longer works), but the email to ${sr.buyerEmail} could not be delivered (${sent.error}).` };
}
