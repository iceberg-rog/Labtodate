'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getServerSession, requireSession, requireCapability } from '@/lib/auth-server';
import { isDeliverableEmail, sendEmail } from '@/lib/email';
import { ensureSettingsLoaded } from '@/lib/settings';
import { renderInvoiceHtml } from '@/lib/invoice';
import { rateLimit } from '@/lib/ratelimit';
import { notifyAdmins, notifyUser, audit } from '@/lib/observability';
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

/** Turnaround promise for buyer copy. Comes from the admin QUOTE_TURNAROUND
 *  setting (the same value /let-us-find-it shows); no setting, no time promise. */
function quoteTurnaroundPhrase(): string {
  const t = process.env.QUOTE_TURNAROUND?.trim();
  return t ? `reply within ${t}` : 'reply as soon as we have something solid';
}

/** Readable result for quote actions. Production builds hide thrown messages
 *  behind a generic "Server Components render" error, so known failures are
 *  returned instead of thrown. */
export type QuoteActionResult = { error?: string };

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
  const buyerCta = accessToken
    ? `${process.env.BETTER_AUTH_URL ?? ''}/quotes/t/${accessToken}`
    : `${process.env.BETTER_AUTH_URL ?? ''}/app/quotes`;
  await sendEmail({
    to: parsed.buyerEmail,
    subject: created.product
      ? `Quote request received: ${created.product.title}`
      : 'lab2date sourcing request received',
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:540px;">
        <h2 style="color:#0E4F40;">We&rsquo;ve got your request</h2>
        <p>Hi ${parsed.buyerName}, our team and the supplier will review your request and ${quoteTurnaroundPhrase()}.</p>
        ${created.product ? `<p><strong>Product:</strong> ${created.product.title}</p>` : ''}
        <p><strong>What you wrote:</strong></p>
        <blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${parsed.description.replace(/\n/g, '<br>')}</blockquote>
        <p style="margin:18px 0;">
          <a href="${buyerCta}" style="background:#0E4F40;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
            ${accessToken ? 'View / reply to your quote' : 'Open in dashboard'}
          </a>
        </p>
        ${accessToken ? `<p style="color:#888;font-size:11px;">This is a private link tied to your request — keep it to yourself. Valid for 14 days.</p>` : ''}
        <p style="color:#888;font-size:12px;">Reference: ${QUOTE_REF(created.id)}</p>
      </div>
    `,
  }).catch((e) => console.error('[quotes] buyer confirmation failed', QUOTE_REF(created.id), e));

  // Notify assignee (seller or platform inbox). Imported sellers carry
  // placeholder addresses, so those go to the intake inbox. The request is
  // already saved: a failed staff notification must not fail the buyer's submit
  // (they'd see an error and resubmit, creating duplicates).
  // Sellers never learn who the buyer is (lab2date mediates), so a seller copy
  // carries no buyer identity and links to the seller inbox; staff and intake
  // copies link to the admin workspace, which labels internal notes.
  const sellerEmail = created.assignedTo?.email;
  const toSeller = created.assignedTo?.role === 'SELLER' && isDeliverableEmail(sellerEmail);
  const assigneeEmail = isDeliverableEmail(sellerEmail)
    ? sellerEmail
    : process.env.QUOTE_INTAKE_EMAIL ?? 'sourcing@lab2date.com';
  const assigneeLink = toSeller
    ? `${process.env.BETTER_AUTH_URL ?? ''}/app/seller/inbox/${created.id}`
    : `${process.env.BETTER_AUTH_URL ?? ''}/admin/quotes/${created.id}`;
  await sendEmail({
    to: assigneeEmail,
    subject: created.product
      ? `New quote request: ${created.product.title}`
      : facilityLabel ? `New access request — ${facilityLabel}`
      : toSeller ? 'New sourcing request' : `New sourcing request from ${parsed.buyerName}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:540px;">
        <h2 style="color:#0E4F40;">${created.product ? 'Quote request' : 'Sourcing request'}</h2>
        ${toSeller ? '' : `<p>From <strong>${parsed.buyerName}</strong> &lt;${parsed.buyerEmail}&gt;${parsed.companyName ? ` · ${parsed.companyName}` : ''}</p>`}
        ${created.product ? `<p><strong>Product:</strong> ${created.product.title}</p>` : ''}
        ${facilityLabel ? `<p><strong>Facility:</strong> ${facilityLabel}</p>` : ''}
        ${parsed.budget ? `<p><strong>Budget:</strong> ${parsed.budget}</p>` : ''}
        ${parsed.timeframe ? `<p><strong>Timeframe:</strong> ${parsed.timeframe}</p>` : ''}
        <p><strong>Description:</strong></p>
        <blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${parsed.description.replace(/\n/g, '<br>')}</blockquote>
        <p>Reply via lab2date dashboard: <a href="${assigneeLink}">${toSeller ? 'Open in seller inbox' : 'Open in admin'}</a></p>
      </div>
    `,
  }).catch((e) => console.error('[quotes] assignee notification failed', QUOTE_REF(created.id), e));

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
      const buyerLink = sr.accessToken
        ? `${process.env.BETTER_AUTH_URL ?? ''}/quotes/t/${sr.accessToken}`
        : `${process.env.BETTER_AUTH_URL ?? ''}/app/quotes/${sr.id}`;
      await sendEmail({
        to: sr.buyerEmail,
        subject: 'New reply on your lab2date quote',
        html: `<p>The supplier replied to your quote request.</p><p><a href="${buyerLink}">Open the thread</a></p>`,
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
      const base = process.env.BETTER_AUTH_URL ?? '';
      await sendEmail({
        to: isDeliverableEmail(assigneeEmail) ? assigneeEmail : process.env.QUOTE_INTAKE_EMAIL ?? 'sourcing@lab2date.com',
        subject: `[${quoteRefOrProforma(sr)}] The buyer replied on a quote`,
        html: `<p>The buyer replied on quote <strong>${quoteRefOrProforma(sr)}</strong>.</p><p><a href="${toSeller ? `${base}/app/seller/inbox/${sr.id}` : `${base}/admin/quotes/${sr.id}`}">Open the thread</a> to read it and respond.</p>`,
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
  priceCents: z.number().int().positive().max(1_000_000_00),
  currency: z.string().min(3).max(3).default('EUR'),
  note: z.string().max(2000).optional().nullable(),
});

export async function sendProforma(input: z.infer<typeof ProformaInput>): Promise<QuoteActionResult> {
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
    include: { product: { select: { title: true } } },
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

  // ─── Financial freeze guard (BUG-023 / invariant F12-adjacent) ─────────
  // If this quote already materialised an order and that order has LEFT
  // PENDING_PAYMENT (paid, shipped, refunded, …), its money fields are
  // frozen. Re-sending the proforma at the SAME price/currency is fine
  // (document/email resend); a price or currency CHANGE must go through
  // refund/cancel + a fresh quote. Checked BEFORE any write so a rejection
  // leaves no partial state.
  const linkedOrder = sr.submittedById
    ? await prisma.order.findUnique({
        where: { sourcingRequestId: sr.id },
        select: { id: true, orderNumber: true, status: true, subtotalCents: true, currency: true },
      })
    : null;
  if (
    linkedOrder &&
    linkedOrder.status !== 'PENDING_PAYMENT' &&
    (linkedOrder.subtotalCents !== parsed.priceCents || linkedOrder.currency !== parsed.currency)
  ) {
    return {
      error: `Order ${linkedOrder.orderNumber} is ${linkedOrder.status} — its amounts can no longer be changed by re-issuing a proforma. Refund/cancel the order first, or open a new quote.`,
    };
  }

  // Re-issuing a proforma keeps the same number for AR continuity; only the
  // first call generates one. The number is short, year-prefixed, derived from
  // the request id so it's stable across reloads and easy to grep in mail.
  const number = sr.proformaNumber || `PRO-${new Date().getFullYear()}-${sr.id.slice(-6).toUpperCase()}`;
  // Quote validity from admin Settings (PROFORMA_VALID_DAYS), 14d default. Past
  // validity, the cron sweep moves the deal to CLOSED and blocks buyer payment.
  const validDays = (() => {
    const raw = parseInt(process.env.PROFORMA_VALID_DAYS ?? '', 10);
    return Number.isFinite(raw) && raw >= 1 && raw <= 365 ? raw : 14;
  })();
  const now = new Date();
  const validUntil = sr.validUntilAt ?? new Date(now.getTime() + validDays * 86400e3);

  // Snapshot payment instructions at issuance time so an admin can change
  // settings later without altering historical quotes/proformas.
  const bank = {
    name: process.env.BANK_NAME || '',
    iban: process.env.BANK_IBAN || '',
    swift: process.env.BANK_SWIFT || '',
    refHint: process.env.BANK_REFERENCE_HINT || 'Use the proforma number as transfer reference',
    company: process.env.COMPANY_LEGAL_NAME || process.env.SITE_NAME || 'lab2date',
  };
  // BUG-031: the buyer must be instructed to transfer the SAME total the order
  // records (subtotalCents + shippingCents + taxCents), never the bare subtotal.
  // Computed here with the identical formula the order materialization below
  // uses, so the proforma "Amount due" can never diverge from order.totalCents.
  // With DEFAULT_SHIPPING_CENTS / DEFAULT_TAX_PERCENT both 0 (current posture)
  // the total equals the subtotal and the single "Amount" line is unchanged.
  const proformaSubtotalCents = parsed.priceCents;
  const proformaShippingCents = Math.max(0, parseInt(process.env.DEFAULT_SHIPPING_CENTS || '0', 10) || 0);
  const proformaTaxPct = Math.max(0, parseFloat(process.env.DEFAULT_TAX_PERCENT || '0') || 0);
  const proformaTaxCents = Math.round((proformaSubtotalCents * proformaTaxPct) / 100);
  const proformaTotalCents = proformaSubtotalCents + proformaShippingCents + proformaTaxCents;
  const fmtProformaMoney = (cents: number) => `${(cents / 100).toLocaleString()} ${parsed.currency}`;
  const amountLines =
    proformaTotalCents === proformaSubtotalCents
      ? [`Amount: ${fmtProformaMoney(proformaTotalCents)}`]
      : [
          `Subtotal: ${fmtProformaMoney(proformaSubtotalCents)}`,
          proformaShippingCents > 0 ? `Shipping: ${fmtProformaMoney(proformaShippingCents)}` : '',
          proformaTaxCents > 0 ? `Tax: ${fmtProformaMoney(proformaTaxCents)}` : '',
          `Amount due: ${fmtProformaMoney(proformaTotalCents)}`,
        ].filter(Boolean);
  const paymentInstructionsSnapshot = bank.iban
    ? [
        `Beneficiary: ${bank.company}`,
        bank.name ? `Bank: ${bank.name}` : '',
        `IBAN: ${bank.iban}`,
        bank.swift ? `SWIFT/BIC: ${bank.swift}` : '',
        `Reference: ${number}`,
        ...amountLines,
        `Hint: ${bank.refHint}`,
      ].filter(Boolean).join('\n')
    : `Bank details will be sent by email. Quote your proforma number "${number}" in any transfer.`;

  await prisma.sourcingRequest.update({
    where: { id: sr.id },
    data: {
      quotedPriceCents: parsed.priceCents,
      quotedCurrency: parsed.currency,
      quotedNote: parsed.note ?? null,
      quotedAt: now,
      status: 'RESPONDED',
      proformaNumber: number,
      proformaIssuedAt: sr.proformaIssuedAt ?? now,
      validUntilAt: validUntil,
      paymentInstructionsSnapshot,
    },
  });

  await prisma.quoteMessage.create({
    data: {
      sourcingRequestId: sr.id,
      authorId: session.user.id,
      fromStaff: true,
      body: `Quoted price: ${(parsed.priceCents / 100).toLocaleString()} ${parsed.currency} for "${itemTitle}". Proforma ${number} sent to the buyer (valid until ${validUntil.toISOString().slice(0, 10)}).${parsed.note ? `\n\nNote: ${parsed.note}` : ''}`,
    },
  });

  // ─── Order creation (procurement workspace) ───────────────────────────
  // Proforma issuance IS the order trigger now. Previously order was created
  // only when buyer hit Accept — that left a stuck "ACCEPTED · no order"
  // state when admin replied with a text-only price. By materialising the
  // Order at proforma-send time, we guarantee the buyer always has a
  // purchase workspace at /app/orders/<num>/payment as soon as a formal
  // price exists.
  let createdOrder: { id: string; orderNumber: string } | null = null;
  if (sr.submittedById) {
    const existing = linkedOrder;
    if (existing) {
      // Already converted — keep the existing order. Totals may only be
      // rewritten while the order is still PENDING_PAYMENT (atomic status
      // precondition; a concurrent payment wins and freezes the amounts —
      // BUG-023). The same-price-resend case for paid orders was already
      // allowed through by the freeze guard above and changes nothing here.
      const subtotal = parsed.priceCents;
      const shipping = Math.max(0, parseInt(process.env.DEFAULT_SHIPPING_CENTS || '0', 10) || 0);
      const taxPct = Math.max(0, parseFloat(process.env.DEFAULT_TAX_PERCENT || '0') || 0);
      const tax = Math.round((subtotal * taxPct) / 100);
      const updated = await prisma.order.updateMany({
        where: { id: existing.id, status: 'PENDING_PAYMENT' },
        data: {
          subtotalCents: subtotal,
          shippingCents: shipping,
          taxCents: tax,
          totalCents: subtotal + shipping + tax,
          currency: parsed.currency,
        },
      });
      if (updated.count === 1) {
        // Keep the single quote line in sync with the re-issued price so
        // totalCents === sum(items) holds (invariant F1). Pre-payment, the
        // proforma IS the offer — the snapshot freezes at payment, not at
        // first issuance.
        await prisma.orderItem.updateMany({
          where: { orderId: existing.id },
          data: { priceCentsSnapshot: subtotal },
        });
      }
      createdOrder = { id: existing.id, orderNumber: existing.orderNumber };
    } else {
      const subtotal = parsed.priceCents;
      const shipping = Math.max(0, parseInt(process.env.DEFAULT_SHIPPING_CENTS || '0', 10) || 0);
      const taxPct = Math.max(0, parseFloat(process.env.DEFAULT_TAX_PERCENT || '0') || 0);
      const tax = Math.round((subtotal * taxPct) / 100);
      const order = await createOrderWithUniqueNumber({
        buyerId: sr.submittedById,
        status: 'PENDING_PAYMENT',
        subtotalCents: subtotal,
        shippingCents: shipping,
        taxCents: tax,
        totalCents: subtotal + shipping + tax,
        currency: parsed.currency,
        paidAt: null,
        sourcingRequestId: sr.id,
        items: {
          create: {
            productId: sr.productId ?? null,
            titleSnapshot: itemTitle,
            brandSnapshot: null,
            priceCentsSnapshot: subtotal,
            quantity: 1,
          },
        },
      });
      createdOrder = { id: order.id, orderNumber: order.orderNumber };
    }
  }

  const { subject, html } = renderInvoiceHtml({
    kind: 'PROFORMA',
    number,
    dateISO: now.toISOString(),
    currency: parsed.currency,
    buyer: { name: sr.buyerName, email: sr.buyerEmail, company: sr.companyName },
    lines: [{ title: itemTitle, qty: 1, unitCents: parsed.priceCents }],
    status: `Valid until ${validUntil.toISOString().slice(0, 10)}`,
    note: parsed.note ?? null,
  });
  // Buyer-facing payment + workspace CTA email. The CTA now points at the
  // ORDER workspace (/app/orders/<num>/payment) instead of the RFQ thread —
  // that's where the buyer completes billing/shipping/upload-receipt.
  const dashboardLink = createdOrder
    ? `${process.env.BETTER_AUTH_URL ?? ''}/app/orders/${createdOrder.orderNumber}/payment`
    : `${process.env.BETTER_AUTH_URL ?? ''}/app/quotes/${sr.id}`;
  const approvalHtml = `
    <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#0E4F40;">Your proforma is ready — ${number}</h2>
      <p>Hi ${sr.buyerName},</p>
      <p>Your quote for <strong>${itemTitle}</strong> is ready: <strong>${(parsed.priceCents / 100).toLocaleString()} ${parsed.currency}</strong>.</p>
      ${createdOrder ? `
      <p>We've opened a <strong>purchase workspace</strong> for you to complete the order. Inside, you'll fill in billing &amp; shipping details and upload your payment proof.</p>
      <p style="margin:18px 0;">
        <a href="${dashboardLink}" style="background:#0E4F40;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
          Complete your purchase
        </a>
      </p>` : `
      <p style="margin:18px 0;">
        <a href="${dashboardLink}" style="background:#0E4F40;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
          Open quote in dashboard
        </a>
      </p>`}
      <p style="color:#374151;font-size:13px;margin-top:24px;"><strong>Valid until ${validUntil.toISOString().slice(0, 10)}</strong>. After this date the price may need to be re-confirmed.</p>
      <h3 style="color:#0E4F40;margin-top:24px;">Payment instructions</h3>
      <pre style="background:#f3f4f6;padding:12px;border-radius:8px;font-family:ui-monospace,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;">${paymentInstructionsSnapshot}</pre>
      <p style="color:#6b7280;font-size:12px;">A formal proforma is attached below. Reply to this email if you need a PO or a different format.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
      ${html}
    </div>
  `;
  await sendEmail({ to: sr.buyerEmail, subject: `Proforma ${number} — ${itemTitle}`, html: approvalHtml });
  const billing = process.env.COMPANY_EMAIL;
  if (billing) await sendEmail({ to: billing, subject: `[copy] Proforma ${number}`, html: approvalHtml });

  await notifyUser(
    sr.submittedById,
    `Proforma ready — ${number}`,
    `${(parsed.priceCents / 100).toLocaleString()} ${parsed.currency} for "${itemTitle}". Complete your purchase to confirm.`,
    createdOrder ? `/app/orders/${createdOrder.orderNumber}/payment` : `/app/quotes/${sr.id}`,
  );
  await notifyAdmins(
    `Proforma sent — ${number}`,
    `${itemTitle} · ${(parsed.priceCents / 100).toLocaleString()} ${parsed.currency} · expires ${validUntil.toISOString().slice(0, 10)}`,
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
        meta: `${itemTitle} · ${(parsed.priceCents / 100).toLocaleString()} ${parsed.currency} · validUntil=${validUntil.toISOString().slice(0, 10)}`,
      },
    });
  } catch {/* AuditLog model schema mismatch — non-fatal */}

  revalidatePath(`/app/quotes/${sr.id}`);
  revalidatePath(`/app/quotes/${sr.id}/proforma`);
  revalidatePath(`/app/seller/inbox/${sr.id}`);
  revalidatePath(`/admin/quotes`);
  return {};
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
      quotedCurrency: true,
      description: true,
      productId: true,
      product: { select: { title: true, brand: { select: { name: true } } } },
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
  revalidatePath(`/app/quotes/${id}`);
  revalidatePath(`/app/seller/inbox/${id}`);
  revalidatePath(`/admin/quotes/${id}`);
  revalidatePath('/admin/quotes');

  // Buyer ACCEPT path: Order was already created at proforma-send time, so
  // here we just redirect to the existing payment workspace. If somehow no
  // Order exists (legacy state where admin replied with text price only),
  // surface a clear error rather than creating a malformed order on the fly.
  if (status === 'ACCEPTED' && sr.submittedById) {
    const existing = await prisma.order.findUnique({
      where: { sourcingRequestId: id },
      select: { orderNumber: true },
    });
    if (existing) {
      if (changed) {
        await notifyAdmins(
          `Quote accepted → order ${existing.orderNumber}`,
          `Buyer confirmed. Awaiting payment proof on /admin/orders.`,
          '/admin/orders?view=awaiting_verify',
          'ORDER_FROM_QUOTE',
        );
        await notifyUser(
          sr.submittedById,
          `Quote accepted — order ${existing.orderNumber}`,
          'Open the purchase workspace to upload your payment proof and complete delivery details.',
          `/app/orders/${existing.orderNumber}/payment`,
        );
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
    await sendEmail({
      to: target.email,
      subject: `[${quoteRefOrProforma(sr)}] A quote was transferred to you`,
      html: `<p>Quote <strong>${quoteRefOrProforma(sr)}</strong> was transferred to you on lab2date.</p><p><a href="${process.env.BETTER_AUTH_URL ?? ''}${href}">Open the quote</a> to reply to the buyer.</p>`,
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

  const site = process.env.SITE_NAME || 'lab2date';
  const href = `${process.env.BETTER_AUTH_URL ?? ''}/quotes/t/${newToken}`;
  await sendEmail({
    to: sr.buyerEmail,
    subject: `[${quoteRefOrProforma(sr)}] New link to view your quote`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:560px;">
        <h2 style="color:#0E4F40;">Here&rsquo;s a fresh link, ${sr.buyerName}</h2>
        <p>Your support team rotated the access link on quote <strong>${quoteRefOrProforma(sr)}</strong>. Any previous link no longer works.</p>
        <p style="margin:18px 0;">
          <a href="${href}" style="background:#0E4F40;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
            View quote
          </a>
        </p>
        <p style="color:#888;font-size:11px;">This link is valid for 14 days. Keep it private.</p>
        <p style="color:#888;font-size:12px;">${site}</p>
      </div>`,
  });
  await audit('quote.magiclink.reissue', quoteRefOrProforma(sr), `by ${session.user.email}`);
  revalidatePath(`/admin/quotes/${id}`);
  return { ok: true, message: `New link emailed to ${sr.buyerEmail}.` };
}
