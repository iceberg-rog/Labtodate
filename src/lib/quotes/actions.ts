'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getServerSession, requireSession, requireCapability } from '@/lib/auth-server';
import { isDeliverableEmail } from '@/lib/email';
import { headerText } from '@/lib/email-html';
import { siteLink } from '@/lib/email-templates/links';
import { ensureSettingsLoaded } from '@/lib/settings';
import type { Prisma } from '@prisma/client';
import { composeQuote, type ComposeInputT } from '@/lib/documents/quote-compose';
import { addDays, buildSnapshot, endOfDayUtc } from '@/lib/documents/build';
import { renderDocumentHtml } from '@/lib/documents/render';
import { getGeneral } from '@/lib/documents/config';
import { companySnapshot, readiness } from '@/lib/documents/company';
import { fmtDate, fmtMoney } from '@/lib/documents/vars';
import { documentFileName, ensureLegacyQuoteDoc, issueQuote, snapshotOf, withCountryName } from '@/lib/documents/issue';
import { billingAddressFrom, orderItemsFrom, orderMoneyFrom } from '@/lib/documents/quote-order';
import { parseQuoteDetails } from '@/lib/documents/build';
import { getSiteTexts } from '@/lib/site/content';
import { sendTemplatedEmail, sendTemplatedEmailSafe } from '@/lib/email-templates/send';
import { rateLimit } from '@/lib/ratelimit';
import { intakeEmail } from '@/lib/intake';
import { notifyAdmins, notifyUser, audit, logError } from '@/lib/observability';
import { createOrderWithUniqueNumber, sendOrderReceived } from '@/lib/orders/internal';

// ────────────────────────────────────────────────────────────────────────────
//   Mirror of Support-ticket production-hardening helpers
// ────────────────────────────────────────────────────────────────────────────

const QUOTE_SLA_HOURS: Record<string, number> = {
  URGENT: 2,
  VIP: 2,
  HIGH: 8,
  NORMAL: 24,
  LOW: 72,
};
function computeQuoteDueAt(now: Date, priority: string): Date {
  const h = QUOTE_SLA_HOURS[priority] ?? QUOTE_SLA_HOURS.NORMAL;
  return new Date(now.getTime() + h * 3600 * 1000);
}

function makeQuoteAccessToken(): string {
  return randomBytes(24).toString('base64url');
}
const QUOTE_MAGIC_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
function quoteTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + QUOTE_MAGIC_LINK_TTL_MS);
}

const QUOTE_REF = (id: string) => `RFQ-${id.slice(-6).toUpperCase()}`;

function quoteRefOrProforma(sr: { id: string; proformaNumber: string | null }): string {
  return sr.proformaNumber ?? QUOTE_REF(sr.id);
}

/** Readable result for quote actions. Production builds hide thrown messages
 *  behind a generic "Server Components render" error, so known failures are
 *  returned instead of thrown. `notice` tells the actor what a successful
 *  action did besides the obvious (e.g. which order a close canceled). */
export type QuoteActionResult = {
  error?: string;
  notice?: string;
  /** Set when the action needs an explicit "yes, do it anyway" from the user
   *  (e.g. quoting more units than the listing has in stock). The caller shows
   *  this text in a confirm and resends with the matching confirm flag. */
  needsConfirm?: string;
};


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
  // What was asked for: the listing, the lab / typed category, or else the
  // start of the buyer's own words (never an English placeholder).
  const requestItem = headerText(created.product?.title || parsed.productCategory || parsed.description, 120);
  const receivedVars = {
    'customer.name': parsed.buyerName,
    'quote.number': QUOTE_REF(created.id),
    'quote.item': requestItem,
    'quote.description': parsed.description,
    'quote.turnaround': process.env.QUOTE_TURNAROUND?.trim() ?? '',
  };
  await sendTemplatedEmail(
    accessToken
      ? {
          key: 'quote_request_received_guest',
          to: parsed.buyerEmail,
          vars: {
            ...receivedVars,
            'link.quote': siteLink(`/quotes/t/${accessToken}`),
            'link.valid_days': String(Math.round(QUOTE_MAGIC_LINK_TTL_MS / 86_400_000)),
          },
        }
      : { key: 'quote_request_received', to: parsed.buyerEmail, vars: { ...receivedVars, 'link.quote': siteLink('/app/quotes') } },
  ).catch((e) => console.error('[quotes] buyer confirmation failed', QUOTE_REF(created.id), e));

  // Notify assignee (seller or platform inbox). Imported sellers carry
  // placeholder addresses, so those go to the intake inbox. The request is
  // already saved: a failed staff notification must not fail the buyer's submit
  // (they'd see an error and resubmit, creating duplicates).
  // Sellers never learn who the buyer is (Labtodate mediates), so a seller copy
  // carries no buyer identity and links to the seller inbox; staff and intake
  // copies link to the admin workspace, which labels internal notes.
  const sellerEmail = created.assignedTo?.email;
  const toSeller = created.assignedTo?.role === 'SELLER' && isDeliverableEmail(sellerEmail);
  // The intake inbox is only ever a configured address (skipped and logged otherwise).
  const assigneeEmail = isDeliverableEmail(sellerEmail)
    ? sellerEmail
    : await intakeEmail('quote', 'staff_quote_request_new');
  const requestDetails = {
    'quote.number': QUOTE_REF(created.id),
    'quote.item': requestItem,
    'quote.budget': parsed.budget || '—',
    'quote.timeframe': parsed.timeframe || '—',
    'quote.description': parsed.description,
  };
  if (assigneeEmail) await sendTemplatedEmail(
    toSeller
      ? {
          // No buyer identity in the seller's copy (no fields for it either).
          key: 'quote_request_new_seller',
          to: assigneeEmail,
          vars: { ...requestDetails, 'link.quote': siteLink(`/app/seller/inbox/${created.id}`) },
        }
      : {
          key: 'staff_quote_request_new',
          to: assigneeEmail,
          // An admin assignee gets their own language; the intake inbox English.
          lang: isDeliverableEmail(sellerEmail) ? undefined : 'en',
          vars: {
            ...requestDetails,
            'buyer.name': parsed.buyerName,
            'buyer.email': parsed.buyerEmail,
            'buyer.company': parsed.companyName || '—',
            'quote.product': created.product?.title ?? '—',
            'quote.facility': facilityLabel ?? '—',
            'link.admin': siteLink(`/admin/quotes/${created.id}`),
          },
        },
  ).catch((e) => console.error('[quotes] assignee notification failed', QUOTE_REF(created.id), e));

  await notifyAdmins(
    'New quote request',
    `${parsed.buyerName}: ${created.product?.title ?? parsed.productCategory ?? 'sourcing request'}`,
    `/admin/quotes/${created.id}`,
    'QUOTE_NEW',
  );
  // Same in-app trail the buyer gets for a support ticket.
  if (submittedById) {
    await notifyUser(
      submittedById,
      `Quote request ${QUOTE_REF(created.id)} received`,
      `We logged your request for "${created.product?.title ?? parsed.productCategory ?? 'your item'}". Follow replies and offers under Quotes.`,
      `/app/quotes/${created.id}`,
    );
  }

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
      id: true, proformaNumber: true,
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
    await prisma.sourcingRequest.update({
      where: { id: parsed.sourcingRequestId },
      data: {
        lastReplyAt: now,
        lastReplyByStaff: fromStaff,
        ...statusUpdate,
        // BUG-018: a buyer reply must resurface an archived quote to the admin
        // queue, otherwise the customer's message is hidden in Archived.
        ...(!fromStaff ? { archivedAt: null, archivedById: null } : {}),
      },
    });
  }

  // Email + in-app notify — never on internal notes.
  if (!isInternalNote) {
    if (fromStaff) {
      await sendTemplatedEmailSafe({
        key: 'quote_reply',
        to: sr.buyerEmail,
        vars: {
          'quote.number': quoteRefOrProforma(sr),
          'link.quote': sr.accessToken ? siteLink(`/quotes/t/${sr.accessToken}`) : siteLink(`/app/quotes/${sr.id}`),
        },
      });
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
          sr.assignedTo?.role === 'SELLER' ? `/app/seller/inbox/${sr.id}` : `/admin/quotes/${sr.id}`,
        );
      }
      await notifyAdmins('Buyer replied on a quote', 'A buyer responded on a sourcing request.', `/admin/quotes/${sr.id}`);
      // Email whoever handles the quote, as the thread promises: a seller with a
      // real address, otherwise the intake inbox (imported sellers carry
      // placeholder addresses). Best-effort — the reply is already saved.
      const assigneeEmail = sr.assignedTo?.email;
      const toSeller = sr.assignedTo?.role === 'SELLER' && isDeliverableEmail(assigneeEmail);
      const toAssignee = isDeliverableEmail(assigneeEmail);
      // The intake inbox is only ever a configured address (skipped and logged otherwise).
      const replyTo = toAssignee ? assigneeEmail : await intakeEmail('quote', 'quote_buyer_replied');
      if (replyTo) await sendTemplatedEmailSafe({
        key: 'quote_buyer_replied',
        to: replyTo,
        // The assignee gets their own language; the intake inbox English.
        lang: toAssignee ? undefined : 'en',
        vars: {
          'quote.number': quoteRefOrProforma(sr),
          'link.quote': toSeller ? siteLink(`/app/seller/inbox/${sr.id}`) : siteLink(`/admin/quotes/${sr.id}`),
        },
      }).catch((e) => console.error('[quotes] buyer-reply notification failed', quoteRefOrProforma(sr), e));
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
  return {};
}

const ProformaInput = z.object({
  sourcingRequestId: z.string().min(1),
  // Per UNIT of the main line. With the default quantity of 1 this is also
  // the line total, so a caller that does not send a quantity behaves as before.
  priceCents: z.number().int().positive().max(1_000_000_00),
  quantity: z.number().int().positive().max(9_999).default(1),
  currency: z.string().min(3).max(3).default('EUR'),
  note: z.string().max(2000).optional().nullable(),
  /** Composer fields (extra lines, shipping, billing, VAT, validity, language). */
  compose: z.unknown().optional(),
  /** The admin confirmed sending although company details are missing. */
  confirmIncomplete: z.boolean().optional(),
  /** Build everything and return the PDF preview instead of sending. */
  previewOnly: z.boolean().optional(),
  /** The admin saw the "more than in stock" warning and chose to quote anyway. */
  confirmOverStock: z.boolean().optional(),
});

export type ProformaResult = QuoteActionResult & {
  /** Company details missing: ask, then resend with confirmIncomplete. */
  confirm?: string;
  /** previewOnly: the rendered document (HTML) and the computed totals. */
  previewHtml?: string;
  totals?: { subtotalCents: number; shippingCents: number; vatCents: number; totalCents: number };
  vatReason?: string;
};

// z.input, not z.infer: quantity and currency have zod defaults, so a caller
// that omits them is valid — the parse fills them in.
export async function sendProforma(input: z.input<typeof ProformaInput>): Promise<ProformaResult> {
  const result = ProformaInput.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = String(issue?.path[0] ?? '');
    if (field === 'priceCents') {
      return { error: issue?.code === 'too_big' ? 'Max proforma amount is €1,000,000.' : 'Enter a price above zero.' };
    }
    if (field === 'note') return { error: 'The note is too long (max 2,000 characters).' };
    return { error: 'This proforma could not be sent. Check the price and try again.' };
  }
  const parsed = result.data;
  await ensureSettingsLoaded();
  const session = await requireSession({ redirectTo: '/app' });

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: parsed.sourcingRequestId },
    include: { product: { select: { title: true, quantity: true, status: true } }, submittedBy: { select: { docLanguage: true } } },
  });
  if (!sr) return { error: 'This quote no longer exists.' };

  const role = (session.user as { role?: string }).role;
  const isAdmin = role === 'ADMIN';
  const isAssignee = !!sr.assignedToId && sr.assignedToId === session.user.id;
  const allowed = isAdmin || isAssignee;
  if (!allowed) return { error: 'You are not allowed to send a proforma on this quote.' };
  // Admin path needs explicit cap. Assignee seller is already gated by
  // ownership (they were the chosen supplier for this product/quote).
  if (isAdmin && !isAssignee) {
    await requireCapability('quotes:proforma', { redirectTo: '/admin/quotes' });
  }

  const itemTitle = sr.product?.title ?? sr.productCategory ?? 'Requested equipment';

  // ─── The offer: lines, shipping, billing block, VAT, language, validity ──
  const composed = await composeQuote({
    mainLine: { title: itemTitle, qty: parsed.quantity, unitCents: parsed.priceCents },
    input: (parsed.compose ?? {}) as ComposeInputT,
    previous: sr.quoteDetails,
    buyerLang: sr.submittedBy?.docLanguage,
    actorEmail: session.user.email,
  });
  if ('error' in composed) return { error: composed.error };
  const { details, totals } = composed;
  // quotedPriceCents stays "the quoted amount" every list shows: the goods
  // excl. VAT and shipping (= order.subtotalCents). The document and the
  // order carry shipping and VAT on top.
  const quotedUnitCents = parsed.priceCents;
  const quotedQuantity = parsed.quantity;
  const quotedTotalCents = totals.subtotalCents;

  const now = new Date();
  // Every (re-)issue starts the validity again from the composer's days.
  const validUntil = parsed.compose || !sr.validUntilAt ? endOfDayUtc(addDays(now, details.validDays)) : sr.validUntilAt;

  if (parsed.previewOnly) {
    const snap = await buildSnapshot({
      kind: 'QUOTE',
      lang: details.lang,
      number: sr.proformaNumber ?? 'PRO-…',
      issuedAt: now,
      currency: parsed.currency,
      customer: {
        name: details.billing.name || sr.buyerName,
        company: details.billing.company ?? sr.companyName,
        email: sr.buyerEmail,
        addressLines: withCountryName([...details.billing.addressLines, ...(details.billing.country ? [details.billing.country] : [])], details.lang),
        country: details.billing.country,
        vatId: details.billing.vatId,
      },
      lines: details.lines,
      shippingCents: details.shippingCents,
      vat: { treatment: details.vat.treatment, rateBp: details.vat.rateBp, reason: details.vat.reason },
      note: parsed.note ?? null,
      validUntil,
      preview: true,
    });
    return { previewHtml: renderDocumentHtml(snap), totals, vatReason: details.vat.reason };
  }

  // Company block must be complete before a document leaves the house.
  const general = await getGeneral();
  const missing = readiness(await companySnapshot({ withLogo: false })).filter((m) => m.required);
  if (missing.length) {
    const list = missing.map((m) => m.label).join(', ');
    if (general.readiness === 'BLOCK') {
      return { error: `Fill in ${list} in Admin → Documents → Company & bank before sending quotes.` };
    }
    if (!parsed.confirmIncomplete) {
      return { confirm: `The company block is missing: ${list}. The buyer will see a document without it. Send anyway?` };
    }
  }

  // ─── Stock guard ──────────────────────────────────────────────────────
  // Quoting more units than the listing holds used to go through silently; the
  // stock decrement at payment then skipped (stock too low) and the one-off
  // part stayed on sale. Warn and require an explicit confirm instead — the
  // admin may genuinely have more units than the listing says.
  if (sr.product && sr.product.quantity < parsed.quantity && !parsed.confirmOverStock) {
    const have = Math.max(0, sr.product.quantity);
    return {
      needsConfirm:
        have === 0
          ? `This listing has no stock left, but you are quoting ${parsed.quantity}. Send the proforma anyway? Update the listing stock first if you do have the units.`
          : `This listing has only ${have} in stock, but you are quoting ${parsed.quantity}. Send the proforma anyway? Update the listing stock first if you do have the units.`,
    };
  }

  // ─── Financial freeze guard (BUG-023 / invariant F12-adjacent) ─────────
  // If this quote already materialised an order and that order has LEFT
  // PENDING_PAYMENT (paid, shipped, refunded, …), its money fields are
  // frozen. Re-sending the proforma at the SAME amounts is fine
  // (document/email resend); an amount or currency CHANGE must go through
  // refund/cancel + a fresh quote. Checked BEFORE any write.
  const linkedOrder = sr.submittedById
    ? await prisma.order.findUnique({
        where: { sourcingRequestId: sr.id },
        select: { id: true, orderNumber: true, status: true, subtotalCents: true, totalCents: true, currency: true },
      })
    : null;
  if (
    linkedOrder &&
    linkedOrder.status !== 'PENDING_PAYMENT' &&
    (linkedOrder.subtotalCents !== totals.subtotalCents || linkedOrder.totalCents !== totals.totalCents || linkedOrder.currency !== parsed.currency)
  ) {
    return {
      error: `Order ${linkedOrder.orderNumber} is ${linkedOrder.status} — its amounts can no longer be changed by re-issuing a proforma. Refund/cancel the order first, or open a new quote.`,
    };
  }

  const fmt = (cents: number) => fmtMoney(cents, parsed.currency, details.lang);

  // ─── Offer first, order on acceptance ─────────────────────────────────
  // A proforma is an OFFER. The order (and the buyer's purchase workspace) is
  // created only when the buyer accepts it — see setQuoteStatus('ACCEPTED').
  // The owner's rule (2026-10-02): offer → buyer accepts → order; sending a
  // price must never create an order on the buyer's behalf.
  // A quote that already has an unpaid order (accepted earlier, or issued
  // before this rule) keeps it: re-issuing rewrites its lines, shipping and
  // VAT from the new document while it is still PENDING_PAYMENT (atomic
  // status precondition; a concurrent payment wins — BUG-023).
  const pendingOrder = sr.submittedById && linkedOrder && linkedOrder.status === 'PENDING_PAYMENT' ? linkedOrder : null;

  // ─── Issue the document (number, frozen snapshot, PDF) ────────────────
  let doc;
  try {
    doc = await issueQuote({
      sr: {
        id: sr.id,
        buyerName: sr.buyerName,
        buyerEmail: sr.buyerEmail,
        companyName: sr.companyName,
        proformaNumber: sr.proformaNumber,
        quotedCurrency: parsed.currency,
        quotedNote: parsed.note ?? null,
      },
      details,
      validUntil,
      issuedAt: now,
      actorId: session.user.id,
      orderNumber: pendingOrder?.orderNumber ?? null,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The quote document could not be issued.' };
  }
  const number = doc.number;

  let createdOrder: { id: string; orderNumber: string } | null = null;
  if (pendingOrder) {
    const frozen = snapshotOf(doc);
    const updated = await prisma.$transaction(async (tx) => {
      const res = await tx.order.updateMany({
        where: { id: pendingOrder.id, status: 'PENDING_PAYMENT' },
        data: orderMoneyFrom(frozen),
      });
      if (res.count === 1) {
        // Keep the lines in sync so totalCents === sum(items) + shipping + VAT.
        await tx.orderItem.deleteMany({ where: { orderId: pendingOrder.id } });
        await tx.orderItem.createMany({
          data: orderItemsFrom(frozen.lines, sr.productId ?? null).map((it) => ({ ...it, orderId: pendingOrder.id })),
        });
      }
      return res.count === 1;
    });
    if (updated) createdOrder = { id: pendingOrder.id, orderNumber: pendingOrder.orderNumber };
  }

  // Snapshot payment instructions at issuance time so an admin can change
  // settings later without altering historical quotes/proformas.
  const bank = {
    name: process.env.BANK_NAME || '',
    iban: process.env.BANK_IBAN || '',
    swift: process.env.BANK_SWIFT || '',
    refHint: process.env.BANK_REFERENCE_HINT || 'Use the quote number as the transfer reference',
    company: process.env.COMPANY_LEGAL_NAME || process.env.SITE_NAME || 'Labtodate',
  };
  const paymentInstructionsSnapshot = bank.iban
    ? [
        `Beneficiary: ${bank.company}`,
        bank.name ? `Bank: ${bank.name}` : '',
        `IBAN: ${bank.iban}`,
        bank.swift ? `SWIFT/BIC: ${bank.swift}` : '',
        `Reference: ${number}`,
        `Amount due: ${fmt(totals.totalCents)}`,
        `Hint: ${bank.refHint}`,
      ].filter(Boolean).join('\n')
    : `Bank details will be sent by email. Quote your proforma number "${number}" in any transfer.`;

  await prisma.sourcingRequest.update({
    where: { id: sr.id },
    data: {
      quotedPriceCents: quotedTotalCents,
      quotedUnitCents,
      quotedQuantity,
      quotedCurrency: parsed.currency,
      quotedNote: parsed.note ?? null,
      quotedAt: now,
      status: 'RESPONDED',
      proformaNumber: number,
      proformaIssuedAt: sr.proformaIssuedAt ?? now,
      validUntilAt: validUntil,
      paymentInstructionsSnapshot,
      quoteDetails: details as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.quoteMessage.create({
    data: {
      sourcingRequestId: sr.id,
      authorId: session.user.id,
      fromStaff: true,
      body: `Quote ${number}${doc.revision > 1 ? ` (revision ${doc.revision})` : ''} sent: ${fmt(totals.totalCents)} incl. VAT for "${itemTitle}"${details.lines.length > 1 ? ` and ${details.lines.length - 1} more line(s)` : ''}, valid until ${validUntil.toISOString().slice(0, 10)}.${parsed.note ? `\n\nNote: ${parsed.note}` : ''}`,
    },
  });

  // ─── E-mail with the PDF attached (+ billing copy) ────────────────────
  // Before acceptance the button opens the offer (accept / decline); a quote
  // that already has an unpaid order links straight to its purchase workspace.
  const base = (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
  const quoteLink = sr.submittedById
    ? `${base}/app/quotes/${sr.id}`
    : sr.accessToken
      ? `${base}/quotes/t/${sr.accessToken}`
      : `${base}/app/quotes/${sr.id}`;
  const orderLink = createdOrder ? `${base}/app/orders/${createdOrder.orderNumber}/payment` : '';
  const snap = snapshotOf(doc);
  const attachments = doc.pdf
    ? [{ filename: documentFileName(snap), content: Buffer.from(doc.pdf), contentType: 'application/pdf' }]
    : [];
  let mailNotice: string | undefined;
  try {
    await sendTemplatedEmail({
      key: createdOrder ? 'quote_updated' : 'quote_sent',
      to: sr.buyerEmail,
      lang: details.lang,
      vars: {
        'customer.name': details.billing.name || sr.buyerName,
        'quote.number': number,
        'quote.item': headerText(itemTitle, 120),
        'quote.total': fmt(totals.totalCents),
        'quote.valid_until': fmtDate(validUntil, details.lang, 'UTC'),
        'order.number': createdOrder?.orderNumber ?? '',
        'payment.instructions': paymentInstructionsSnapshot,
        'link.quote': quoteLink,
        'link.order': orderLink,
      },
      attachments,
    });
    if (!attachments.length) mailNotice = 'Sent, but the PDF could not be made: the e-mail links to the quote instead. Check Admin → Errors.';
  } catch (e) {
    await logError('quote.proforma.email', e);
    mailNotice = `The quote was issued, but the e-mail to ${sr.buyerEmail} failed: ${e instanceof Error ? e.message.slice(0, 160) : 'unknown error'}. Use “Resend” once mail works.`;
  }
  const billing = (process.env.COMPANY_EMAIL || '').trim();
  if (billing && general.billingCopy && attachments.length) {
    await sendTemplatedEmail({
      key: 'document_copy',
      to: billing,
      lang: 'en',
      vars: {
        'document.title': snap.texts.title,
        'document.number': number,
        'document.customer': snap.customer.company || snap.customer.name,
        'document.total': fmt(totals.totalCents),
      },
      attachments,
    }).catch((e) => logError('quote.proforma.billing_copy', e));
  }

  await notifyUser(
    sr.submittedById,
    createdOrder ? `Offer updated — ${number}` : `Offer ready — ${number}`,
    createdOrder
      ? `${fmt(totals.totalCents)} for "${itemTitle}". Complete your purchase to confirm.`
      : `${fmt(totals.totalCents)} for "${itemTitle}". Review the offer and accept or decline it.`,
    createdOrder ? `/app/orders/${createdOrder.orderNumber}/payment` : `/app/quotes/${sr.id}`,
  );
  await notifyAdmins(
    `Quote sent — ${number}`,
    `${itemTitle} · ${fmt(totals.totalCents)} · expires ${validUntil.toISOString().slice(0, 10)}`,
    `/admin/quotes`,
    'QUOTE_APPROVED',
  );
  // Audit so the AR trail is searchable independent of the message thread.
  try {
    await prisma.auditLog.create({
      data: {
        actorEmail: session.user.email,
        action: 'quote.proforma.send',
        target: number,
        meta: `${itemTitle} · ${fmt(totals.totalCents)} · vat=${details.vat.treatment}${details.vat.overridden ? ' (override)' : ''} · rev=${doc.revision} · validUntil=${validUntil.toISOString().slice(0, 10)}`,
      },
    });
  } catch {/* AuditLog model schema mismatch — non-fatal */}

  revalidatePath(`/app/quotes/${sr.id}`);
  revalidatePath(`/app/quotes/${sr.id}/proforma`);
  revalidatePath(`/app/seller/inbox/${sr.id}`);
  revalidatePath(`/admin/quotes`);
  return mailNotice ? { notice: mailNotice } : {};
}

class ProofInFlightError extends Error {}

export async function setQuoteStatus(
  id: string,
  status: 'ACCEPTED' | 'DECLINED' | 'CLOSED',
): Promise<QuoteActionResult> {
  const session = await requireSession({ redirectTo: '/app' });
  const sr = await prisma.sourcingRequest.findUnique({
    where: { id },
    select: {
      id: true, proformaNumber: true,
      submittedById: true,
      assignedToId: true,
      status: true,
      archivedAt: true,
      quotedPriceCents: true,
      quotedUnitCents: true,
      quotedQuantity: true,
      quotedCurrency: true,
      validUntilAt: true,
      description: true,
      productId: true,
      productCategory: true,
      buyerName: true,
      buyerEmail: true,
      companyName: true,
      quoteDetails: true,
      accessToken: true,
      assignedTo: { select: { role: true } },
      product: { select: { title: true, quantity: true, status: true, brand: { select: { name: true } } } },
    },
  });
  if (!sr) return { error: 'This quote no longer exists.' };

  const role = (session.user as { role?: string }).role;
  const isAdmin = role === 'ADMIN';
  // Buyer can accept/decline, seller can close. Admin can do all (with cap).
  const allowed =
    isAdmin ||
    (sr.submittedById === session.user.id && status !== 'CLOSED') ||
    (sr.assignedToId === session.user.id && status === 'CLOSED');
  if (!allowed) return { error: 'You are not allowed to change this quote.' };
  if (isAdmin && sr.submittedById !== session.user.id && sr.assignedToId !== session.user.id) {
    await requireCapability('quotes:status', { redirectTo: '/admin/quotes' });
  }

  // A declined/closed deal stays closed: its order was canceled, so accepting
  // it again would send the buyer to a dead payment workspace.
  if (status === 'ACCEPTED' && (sr.status === 'DECLINED' || sr.status === 'CLOSED')) {
    return { error: 'This quote is closed. Open a new request if you still need the item.' };
  }

  // ─── Buyer accepts the offer → the order is created now ───────────────
  // (Offer first, order on acceptance — see sendProforma.) Checked before any
  // write: the offer must be a formal proforma, still valid, and the listing
  // must still hold the quoted quantity.
  let acceptedOrder: { orderNumber: string } | null = null;
  if (status === 'ACCEPTED' && sr.submittedById) {
    const existingOrder = await prisma.order.findUnique({
      where: { sourcingRequestId: id },
      select: { orderNumber: true, status: true },
    });
    if (existingOrder?.status === 'CANCELED') {
      return { error: 'This offer was canceled. Reply on the quote and we will send a new one.' };
    }
    if (existingOrder) {
      acceptedOrder = { orderNumber: existingOrder.orderNumber };
    } else if (sr.quotedPriceCents != null && sr.proformaNumber) {
      if (sr.validUntilAt && sr.validUntilAt.getTime() < Date.now()) {
        return { error: 'This offer has expired. Reply on the quote and we will confirm the price again.' };
      }
      const qty = sr.quotedQuantity ?? 1;
      // Blocked only when the item is gone (sold out or taken off sale) since
      // the offer was sent. Quoting more units than the listing showed was an
      // explicit admin decision at proforma time (stock-guard confirm); a short
      // listing is then reconciled at payment (consumeStockForPaidQuoteOrder).
      if (sr.product && (sr.product.status !== 'PUBLISHED' || sr.product.quantity <= 0)) {
        await notifyAdmins(
          `Offer accepted but the item is gone — ${quoteRefOrProforma(sr)}`,
          `${sr.buyerName} tried to accept ${qty} × "${sr.product.title}", but the listing ${sr.product.status !== 'PUBLISHED' ? 'is not published' : 'has no stock left'}. Update the listing or re-issue the offer.`,
          `/admin/quotes/${id}`,
          'SYSTEM',
        );
        return {
          error: 'This item is no longer available in the quoted quantity. We have been notified and will get back to you shortly.',
        };
      }
      // The order is exactly the offer the buyer accepted: lines, shipping and
      // VAT from the frozen quote document (older quotes are frozen now).
      const offerDoc = await ensureLegacyQuoteDoc(sr.id);
      if (!offerDoc) return { error: 'This offer could not be loaded. Please reply on the quote and we will re-send it.' };
      const offer = snapshotOf(offerDoc);
      try {
        const order = await createOrderWithUniqueNumber({
          buyerId: sr.submittedById,
          status: 'PENDING_PAYMENT',
          ...orderMoneyFrom(offer),
          billingAddress: billingAddressFrom(parseQuoteDetails(sr.quoteDetails), { name: sr.buyerName, company: sr.companyName }),
          paidAt: null,
          sourcingRequestId: sr.id,
          items: { create: orderItemsFrom(offer.lines, sr.productId ?? null, sr.product?.brand?.name ?? null) },
        });
        acceptedOrder = { orderNumber: order.orderNumber };
        await audit('order.create', order.orderNumber, `from offer ${quoteRefOrProforma(sr)} accepted by ${session.user.email}`);
      } catch (e) {
        // A double-click raced us to the unique sourcingRequestId: use that order.
        const raced = await prisma.order.findUnique({ where: { sourcingRequestId: id }, select: { orderNumber: true } });
        if (!raced) throw e;
        acceptedOrder = raced;
      }
    }
  }

  // Declining or closing ends the deal, so the order auto-created at proforma
  // time must stop being payable. A paid order is a real sale (managed on the
  // order page), and a buyer's payment proof in flight wins over the close.
  const terminal = status === 'DECLINED' || status === 'CLOSED';
  if (terminal) {
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
          : `You already sent a payment proof for order ${linked.orderNumber}. Contact support if you want to cancel it.`,
      };
    }
  }

  // Auto-archive on CLOSED — mirrors the support-ticket auto-archive flow.
  const shouldAutoArchive = status === 'CLOSED' && !sr.archivedAt;
  const statusChanged = sr.status !== status;
  // BUG-041: atomic compare-and-set so a double-click / duplicate submit can't
  // re-stamp state, double-audit, or double-notify the buyer. Side effects are
  // gated on count === 1 (the request that actually won the transition).
  // The linked-order cancel commits in the same transaction. It also runs when
  // the quote is already in this state, so an older declined quote's leftover
  // payable order gets cleaned up too.
  let changed = false;
  let canceledOrder: string | null = null;
  try {
    ({ changed, canceledOrder } = await prisma.$transaction(async (tx) => {
      const claim = await tx.sourcingRequest.updateMany({
        where: shouldAutoArchive
          ? { id, OR: [{ status: { not: status } }, { archivedAt: null }] }
          : { id, status: { not: status } },
        data: shouldAutoArchive
          ? { status, archivedAt: new Date(), archivedById: session.user.id }
          : { status },
      });
      if (!terminal) return { changed: claim.count === 1, canceledOrder: null };
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
      return {
        changed: claim.count === 1,
        canceledOrder: cancel.count === 1 ? pending?.orderNumber ?? null : null,
      };
    }));
  } catch (e) {
    if (e instanceof ProofInFlightError) {
      return { error: 'A payment proof was just submitted for this order, so the quote stays open. Review the order first.' };
    }
    throw e;
  }
  if (changed && statusChanged) {
    await audit('quote.status', quoteRefOrProforma(sr), `${sr.status} → ${status} by ${session.user.email}`);
  }
  if (changed && shouldAutoArchive) {
    await audit('quote.archive', quoteRefOrProforma(sr), `auto on CLOSE by ${session.user.email}`);
  }
  if (canceledOrder) {
    // Proforma orders reserve no stock, so there is nothing to restock.
    await audit('order.cancel', canceledOrder, `quote ${quoteRefOrProforma(sr)} ${status.toLowerCase()} by ${session.user.email}`);
    revalidatePath('/app/orders');
    revalidatePath('/admin/orders');
  }
  if (changed && status === 'DECLINED') {
    await notifyAdmins(
      `Quote declined — ${quoteRefOrProforma(sr)}`,
      canceledOrder ? `The buyer declined. Order ${canceledOrder} was canceled.` : 'The buyer declined the quote.',
      `/admin/quotes/${id}`,
      'SYSTEM',
    );
  }
  // Closing (seller "Close request" or admin "Close (no deal)") ends the deal
  // for the buyer: their last message is still "Proforma ready — complete your
  // purchase", so tell them it is over and that the order is no longer payable.
  // Fires once — for the close that actually happened, or for a leftover order
  // a repeat close just canceled.
  let buyerNotified = false;
  if (status === 'CLOSED' && ((changed && statusChanged) || canceledOrder)) {
    const ref = quoteRefOrProforma(sr);
    const orderLine = canceledOrder
      ? ` Order ${canceledOrder} was canceled, so no payment is due.`
      : '';
    await notifyUser(
      sr.submittedById,
      `Quote ${ref} was closed`,
      `Your request was closed without a deal.${orderLine} If you still need the item, open a new request.`,
      `/app/quotes/${id}`,
    );
    buyerNotified = !!sr.submittedById;
    await sendTemplatedEmail({
      // The "order canceled" version tells the buyer not to pay.
      key: canceledOrder ? 'quote_closed_order_canceled' : 'quote_closed',
      to: sr.buyerEmail,
      vars: {
        'customer.name': sr.buyerName,
        'quote.number': ref,
        'quote.item': headerText(sr.product?.title || sr.productCategory || sr.description, 120),
        'order.number': canceledOrder ?? '',
        'link.quote': sr.accessToken ? siteLink(`/quotes/t/${sr.accessToken}`) : siteLink(`/app/quotes/${id}`),
      },
    })
      .then((sent) => { if (sent) buyerNotified = true; })
      .catch((e) => console.error('[quotes] close notification failed', ref, e));
    if (!isAdmin) {
      // The seller closed it: ops must know a deal (and maybe an order) ended.
      await notifyAdmins(
        `Quote closed by the supplier — ${ref}`,
        canceledOrder
          ? `The supplier closed the request without a deal. Order ${canceledOrder} was canceled and the buyer was notified.`
          : 'The supplier closed the request without a deal. The buyer was notified.',
        `/admin/quotes/${id}`,
        'SYSTEM',
      );
    } else if (sr.assignedToId && sr.assignedToId !== session.user.id) {
      // Staff closed a quote a seller was working on: tell the seller too.
      await notifyUser(
        sr.assignedToId,
        `Quote ${ref} was closed`,
        'Labtodate closed this request without a deal.',
        sr.assignedTo?.role === 'SELLER' ? `/app/seller/inbox/${id}` : `/admin/quotes/${id}`,
      );
    }
  }
  revalidatePath(`/app/quotes/${id}`);
  revalidatePath(`/app/seller/inbox/${id}`);
  revalidatePath(`/admin/quotes/${id}`);
  revalidatePath('/admin/quotes');

  // Buyer ACCEPT path: the order was created above (or already existed).
  // Notify once (the request that won the status transition) and send the
  // buyer to the purchase workspace.
  if (status === 'ACCEPTED' && sr.submittedById) {
    const existing = acceptedOrder;
    if (existing) {
      if (changed) {
        const ref = quoteRefOrProforma(sr);
        const itemTitle = sr.product?.title ?? sr.productCategory ?? 'your item';
        await notifyAdmins(
          `Offer accepted → order ${existing.orderNumber}`,
          `${sr.buyerName} accepted ${ref}. Awaiting payment proof on /admin/orders.`,
          '/admin/orders?view=awaiting_verify',
          'ORDER_FROM_QUOTE',
        );
        await notifyUser(
          sr.submittedById,
          `Offer accepted — order ${existing.orderNumber}`,
          'Open the purchase workspace to upload your payment proof and complete delivery details.',
          `/app/orders/${existing.orderNumber}/payment`,
        );
        const workspace = `${(process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '')}/app/orders/${existing.orderNumber}/payment`;
        const placed = await prisma.order.findUnique({ where: { orderNumber: existing.orderNumber }, select: { totalCents: true, currency: true, docLanguage: true } });
        const lang = placed?.docLanguage === 'nl' ? 'nl' : placed?.docLanguage === 'en' ? 'en' : null;
        const site = await getSiteTexts().catch(() => null);
        await sendTemplatedEmailSafe({
          key: 'order_confirmed',
          to: sr.buyerEmail,
          lang,
          vars: {
            'customer.name': sr.buyerName,
            'quote.number': ref,
            'quote.item': itemTitle,
            'order.number': existing.orderNumber,
            'order.total': placed ? fmtMoney(placed.totalCents, placed.currency, lang ?? 'en') : '',
            'rules.payment_verify_time': site?.['rules.payment_verify_time'] ?? '1 business day',
            'link.order': workspace,
          },
        });
      }
      // Redirect unconditionally so a buyer who re-accepts still lands on their
      // payment workspace (idempotent UX) without re-triggering notifications.
      redirect(`/app/orders/${existing.orderNumber}/payment`);
    }
    // Legacy stuck state — admin replied with text-only price, no proforma.
    // Buyer "Accept" should have been hidden in UI (see QuoteThread gating),
    // but if they reached here via API directly, surface a clear admin alert
    // instead of silently creating a half-baked order.
    if (changed) {
      await notifyAdmins(
        `Quote ACCEPTED but no proforma — ${quoteRefOrProforma(sr)}`,
        'Buyer accepted but admin never sent a formal proforma. Issue one now to materialise the order.',
        `/admin/quotes/${id}`,
        'SYSTEM',
      );
    }
  }
  if (status === 'CLOSED') {
    // Tell whoever closed it what happened besides the status change.
    const parts = [changed && statusChanged ? 'Request closed.' : 'This request is closed.'];
    if (canceledOrder) parts.push(`Order ${canceledOrder} was canceled.`);
    if (buyerNotified) parts.push('The buyer was notified.');
    return { notice: parts.join(' ') };
  }
  return {};
}

/**
 * Form entry point. Known failures come back as a readable `error` instead of a
 * throw: production builds replace thrown messages with a generic "Server
 * Components render" error, so the buyer never learned why nothing was sent.
 */
export async function submitAndRedirect(input: SourcingInputType): Promise<{ error: string }> {
  if (!(await getServerSession())) {
    return { error: 'You are signed out. Sign in again, then send your request.' };
  }
  let result: Awaited<ReturnType<typeof submitSourcingRequest>>;
  try {
    result = await submitSourcingRequest(input);
  } catch (e) {
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
    where: { id }, select: { id: true, proformaNumber: true, priority: true },
  });
  if (!sr) return { ok: false, message: 'Quote not found.' };
  const dueAt = computeQuoteDueAt(new Date(), priority);
  await prisma.sourcingRequest.update({
    where: { id },
    data: { priority, dueAt, slaBreachAt: null },
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
  if (isDeliverableEmail(target.email)) {
    await sendTemplatedEmail({
      key: 'quote_transferred',
      to: target.email,
      vars: { 'quote.number': quoteRefOrProforma(sr), 'link.quote': siteLink(href) },
    }).catch((e) => console.error('[quotes] transfer notification failed', quoteRefOrProforma(sr), e));
  }
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
  for (const t of targets) {
    await audit('quote.delete.permanent', quoteRefOrProforma(t), `bulk · ${t.buyerEmail} · ${t.status} · ${t.priority}`);
  }
  await prisma.sourcingRequest.deleteMany({ where: { id: { in: targets.map((t) => t.id) } } });
  revalidatePath('/admin/quotes');
  return { ok: true, count: targets.length, message: `Deleted ${targets.length} quote${targets.length === 1 ? '' : 's'}.` };
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

  await sendTemplatedEmail({
    key: 'quote_link_reissued',
    to: sr.buyerEmail,
    vars: {
      'customer.name': sr.buyerName,
      'quote.number': quoteRefOrProforma(sr),
      'link.quote': siteLink(`/quotes/t/${newToken}`),
      'link.valid_days': String(Math.round(QUOTE_MAGIC_LINK_TTL_MS / 86_400_000)),
    },
  });
  await audit('quote.magiclink.reissue', quoteRefOrProforma(sr), `by ${session.user.email}`);
  revalidatePath(`/admin/quotes/${id}`);
  return { ok: true, message: `New link emailed to ${sr.buyerEmail}.` };
}
