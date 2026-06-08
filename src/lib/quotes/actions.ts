'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getServerSession, requireSession, requireCapability } from '@/lib/auth-server';
import { sendEmail } from '@/lib/email';
import { ensureSettingsLoaded } from '@/lib/settings';
import { renderInvoiceHtml } from '@/lib/invoice';
import { rateLimit } from '@/lib/ratelimit';
import { notifyAdmins, notifyUser, audit } from '@/lib/observability';
import { createOrderWithUniqueNumber, sendOrderReceived } from '@/lib/orders/actions';

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

const SourcingInput = z.object({
  buyerEmail: z.string().email(),
  buyerName: z.string().min(2).max(120),
  companyName: z.string().max(180).optional().nullable(),
  productCategory: z.string().max(120).optional().nullable(),
  budget: z.string().max(120).optional().nullable(),
  timeframe: z.string().max(120).optional().nullable(),
  description: z.string().min(20).max(4000),
  productSlug: z.string().optional().nullable(),
});

export type SourcingInputType = z.infer<typeof SourcingInput>;

export async function submitSourcingRequest(input: SourcingInputType) {
  rateLimit('quote');
  await ensureSettingsLoaded();
  const parsed = SourcingInput.parse(input);
  const session = await getServerSession();
  const submittedById = session?.user.id ?? null;
  // RB-3: never mix a typed email with an authenticated session. A logged-in
  // submitter's quote is bound to THEIR account identity — the typed email is
  // ignored for ownership so a record can't end up owned by two people. Guests
  // (no session) keep the email they typed (they have no account to bind to).
  const buyerEmail = session?.user.email ?? parsed.buyerEmail;
  const buyerName = session?.user.name ?? parsed.buyerName;

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
      buyerEmail,
      buyerName,
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
      assignedTo: { select: { email: true, name: true } },
    },
  });

  // Confirmation to buyer — REGISTERED gets dashboard CTA, GUEST gets magic-link.
  const buyerCta = accessToken
    ? `${process.env.BETTER_AUTH_URL ?? ''}/quotes/t/${accessToken}`
    : `${process.env.BETTER_AUTH_URL ?? ''}/app/quotes`;
  await sendEmail({
    to: buyerEmail,
    subject: created.product
      ? `Quote request received: ${created.product.title}`
      : 'lab2date sourcing request received',
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:540px;">
        <h2 style="color:#0E4F40;">We&rsquo;ve got your request</h2>
        <p>Hi ${buyerName}, our team and the supplier will review your request and reply within 24 business hours.</p>
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
  });

  // Notify assignee (seller or platform inbox)
  const assigneeEmail =
    created.assignedTo?.email ?? process.env.QUOTE_INTAKE_EMAIL ?? 'sourcing@lab2date.com';
  await sendEmail({
    to: assigneeEmail,
    subject: created.product
      ? `New quote request: ${created.product.title}`
      : `New sourcing request from ${parsed.buyerName}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:540px;">
        <h2 style="color:#0E4F40;">${created.product ? 'Quote request' : 'Sourcing request'}</h2>
        <p>From <strong>${parsed.buyerName}</strong> &lt;${parsed.buyerEmail}&gt;${parsed.companyName ? ` · ${parsed.companyName}` : ''}</p>
        ${created.product ? `<p><strong>Product:</strong> ${created.product.title}</p>` : ''}
        ${parsed.budget ? `<p><strong>Budget:</strong> ${parsed.budget}</p>` : ''}
        ${parsed.timeframe ? `<p><strong>Timeframe:</strong> ${parsed.timeframe}</p>` : ''}
        <p><strong>Description:</strong></p>
        <blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${parsed.description.replace(/\n/g, '<br>')}</blockquote>
        <p>Reply via lab2date dashboard: <a href="${process.env.BETTER_AUTH_URL}/app/seller/inbox/${created.id}">Open in seller inbox</a></p>
      </div>
    `,
  });

  await notifyAdmins(
    'New quote request',
    `${parsed.buyerName}: ${created.product?.title ?? parsed.productCategory ?? 'sourcing request'}`,
    '/admin/quotes',
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

export async function replyToQuote(input: z.infer<typeof ReplyInput>) {
  const parsed = ReplyInput.parse(input);
  const session = await requireSession({ redirectTo: '/app' });

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: parsed.sourcingRequestId },
    select: {
      id: true, proformaNumber: true,
      assignedToId: true, submittedById: true, buyerEmail: true, status: true,
      accessToken: true, accessTokenExpiresAt: true,
    },
  });
  if (!sr) throw new Error('Quote not found');

  const role = (session.user as { role?: string }).role;
  const isAdmin = role === 'ADMIN';
  const isAssignee = !!sr.assignedToId && sr.assignedToId === session.user.id;
  const isBuyer = !!sr.submittedById && sr.submittedById === session.user.id;
  const allowed = isAdmin || isAssignee || isBuyer;
  if (!allowed) throw new Error('Forbidden');

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
          `/app/seller/inbox/${sr.id}`,
        );
      }
      await notifyAdmins('Buyer replied on a quote', 'A buyer responded on a sourcing request.', '/admin/quotes');
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
}

const ProformaInput = z.object({
  sourcingRequestId: z.string().min(1),
  priceCents: z.number().int().positive().max(1_000_000_00),
  currency: z.string().min(3).max(3).default('EUR'),
  note: z.string().max(2000).optional().nullable(),
});

export async function sendProforma(input: z.infer<typeof ProformaInput>) {
  const parsed = ProformaInput.parse(input);
  await ensureSettingsLoaded();
  const session = await requireSession({ redirectTo: '/app' });

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: parsed.sourcingRequestId },
    include: { product: { select: { title: true } } },
  });
  if (!sr) throw new Error('Quote not found');

  const role = (session.user as { role?: string }).role;
  const isAdmin = role === 'ADMIN';
  const isAssignee = !!sr.assignedToId && sr.assignedToId === session.user.id;
  const allowed = isAdmin || isAssignee;
  if (!allowed) throw new Error('Forbidden');
  // Admin path needs explicit cap. Assignee seller is already gated by
  // ownership (they were the chosen supplier for this product/quote).
  if (isAdmin && !isAssignee) {
    await requireCapability('quotes:proforma', { redirectTo: '/admin/quotes' });
  }

  const itemTitle = sr.product?.title ?? sr.productCategory ?? 'Requested equipment';
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
  const paymentInstructionsSnapshot = bank.iban
    ? [
        `Beneficiary: ${bank.company}`,
        bank.name ? `Bank: ${bank.name}` : '',
        `IBAN: ${bank.iban}`,
        bank.swift ? `SWIFT/BIC: ${bank.swift}` : '',
        `Reference: ${number}`,
        `Amount: ${(parsed.priceCents / 100).toLocaleString()} ${parsed.currency}`,
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

  // ─── Re-issue continuity (NO order creation here) ─────────────────────
  // RB-2: Issuing a proforma must NOT create an order. It only moves the deal
  // to "proforma sent · awaiting buyer decision". The Order is materialised
  // ONLY when the buyer explicitly accepts (see setQuoteStatus → ACCEPTED).
  // If an order already exists (proforma re-issued after the buyer accepted),
  // refresh its totals to the new price; never create one at proforma time.
  let createdOrder: { id: string; orderNumber: string } | null = null;
  if (sr.submittedById) {
    const existing = await prisma.order.findUnique({
      where: { sourcingRequestId: sr.id },
      select: { id: true, orderNumber: true },
    });
    if (existing) {
      const subtotal = parsed.priceCents;
      const shipping = Math.max(0, parseInt(process.env.DEFAULT_SHIPPING_CENTS || '0', 10) || 0);
      const taxPct = Math.max(0, parseFloat(process.env.DEFAULT_TAX_PERCENT || '0') || 0);
      const tax = Math.round((subtotal * taxPct) / 100);
      await prisma.order.update({
        where: { id: existing.id },
        data: {
          subtotalCents: subtotal,
          shippingCents: shipping,
          taxCents: tax,
          totalCents: subtotal + shipping + tax,
          currency: parsed.currency,
        },
      });
      createdOrder = existing;
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
}

export async function setQuoteStatus(id: string, status: 'ACCEPTED' | 'DECLINED' | 'CLOSED') {
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
  if (!sr) throw new Error('Quote not found');

  const role = (session.user as { role?: string }).role;
  const isAdmin = role === 'ADMIN';
  // Buyer can accept/decline, seller can close. Admin can do all (with cap).
  const allowed =
    isAdmin ||
    (sr.submittedById === session.user.id && status !== 'CLOSED') ||
    (sr.assignedToId === session.user.id && status === 'CLOSED');
  if (!allowed) throw new Error('Forbidden');
  if (isAdmin && sr.submittedById !== session.user.id && sr.assignedToId !== session.user.id) {
    await requireCapability('quotes:status', { redirectTo: '/admin/quotes' });
  }

  // RB-2: a quote can only be ACCEPTED once a formal proforma exists
  // (quotedPriceCents set). Enforce server-side so a direct API call can't
  // create an ACCEPTED-but-no-price/no-order state.
  if (status === 'ACCEPTED' && sr.quotedPriceCents == null) {
    throw new Error('This quote has no formal proforma yet — it cannot be accepted.');
  }

  // Auto-archive on CLOSED — mirrors the support-ticket auto-archive flow.
  const shouldAutoArchive = status === 'CLOSED' && !sr.archivedAt;
  await prisma.sourcingRequest.update({
    where: { id },
    data: shouldAutoArchive
      ? { status, archivedAt: new Date(), archivedById: session.user.id }
      : { status },
  });
  await audit('quote.status', quoteRefOrProforma(sr), `${sr.status} → ${status} by ${session.user.email}`);
  if (shouldAutoArchive) {
    await audit('quote.archive', quoteRefOrProforma(sr), `auto on CLOSE by ${session.user.email}`);
  }
  revalidatePath(`/app/quotes/${id}`);
  revalidatePath(`/app/seller/inbox/${id}`);
  revalidatePath(`/admin/quotes/${id}`);
  revalidatePath('/admin/quotes');

  // RB-2: Buyer ACCEPT is the single Order-conversion point. Proforma issuance
  // no longer creates the order, so we materialise it here (PENDING_PAYMENT)
  // on explicit acceptance, then send the buyer to the payment workspace.
  if (status === 'ACCEPTED' && sr.submittedById) {
    let order = await prisma.order.findUnique({
      where: { sourcingRequestId: id },
      select: { orderNumber: true },
    });
    if (!order) {
      const subtotal = sr.quotedPriceCents ?? 0;
      const shipping = Math.max(0, parseInt(process.env.DEFAULT_SHIPPING_CENTS || '0', 10) || 0);
      const taxPct = Math.max(0, parseFloat(process.env.DEFAULT_TAX_PERCENT || '0') || 0);
      const tax = Math.round((subtotal * taxPct) / 100);
      const itemTitle = sr.product?.title ?? sr.description?.slice(0, 80) ?? 'Requested equipment';
      const created = await createOrderWithUniqueNumber({
        buyerId: sr.submittedById,
        status: 'PENDING_PAYMENT',
        subtotalCents: subtotal,
        shippingCents: shipping,
        taxCents: tax,
        totalCents: subtotal + shipping + tax,
        currency: sr.quotedCurrency ?? 'EUR',
        paidAt: null,
        sourcingRequestId: id,
        items: {
          create: {
            productId: sr.productId ?? null,
            titleSnapshot: itemTitle,
            brandSnapshot: sr.product?.brand?.name ?? null,
            priceCentsSnapshot: subtotal,
            quantity: 1,
          },
        },
      });
      order = { orderNumber: created.orderNumber };
      // RB-5: reserve one unit of the catalogue product (oversell-safe — only
      // decrements when stock is available). The refund/cancel paths restore it
      // symmetrically (increment by item qty), so reserve↔restore stay balanced.
      if (sr.productId) {
        await prisma.product.updateMany({
          where: { id: sr.productId, quantity: { gte: 1 } },
          data: { quantity: { decrement: 1 } },
        });
      }
    }
    await notifyAdmins(
      `Quote accepted → order ${order.orderNumber}`,
      `Buyer confirmed. Awaiting payment proof on /admin/orders.`,
      '/admin/orders?view=awaiting_verify',
      'ORDER_FROM_QUOTE',
    );
    await notifyUser(
      sr.submittedById,
      `Quote accepted — order ${order.orderNumber}`,
      'Open the purchase workspace to upload your payment proof and complete delivery details.',
      `/app/orders/${order.orderNumber}/payment`,
    );
    redirect(`/app/orders/${order.orderNumber}/payment`);
  }
}

export async function submitAndRedirect(input: SourcingInputType) {
  const result = await submitSourcingRequest(input);
  redirect(`/let-us-find-it/thanks?id=${result.id}`);
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
  await notifyUser(toUserId, `Quote ${quoteRefOrProforma(sr)} transferred to you`, `${session.user.email} transferred a quote to you.`, `/admin/quotes/${id}`);
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
