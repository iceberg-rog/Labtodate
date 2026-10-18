import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import type { SupportTicket } from '@prisma/client';
import { prisma } from '@/lib/db';
import { sendInternalEmail } from '@/lib/email';
import { escapeHtml, escapeHtmlLines, headerText } from '@/lib/email-html';
import { siteBase } from '@/lib/quotes/mail';
import { audit, notifyAdmins } from '@/lib/observability';
import {
  belongsToCustomer,
  customerReplyRule,
  mentionedOrderNumbers,
  mentionedProformaNumbers,
  slaAfterCustomerMessage,
} from './rules';
import { computeTicketDueAt, magicLinkExpiry, reopenDays, supportDate } from './policy';

/**
 * Server-side ticket helpers shared by the staff actions (lib/support/actions)
 * and the guest magic-link actions (app/support/t/[token]/actions). NOT a
 * 'use server' module: nothing here checks who is calling, so these functions
 * must never become client-callable actions — callers authorize first.
 */

/** Magic-link access token. URL-safe base64 of 24 random bytes. */
export function makeAccessToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Where the customer reads and answers a ticket: the guest's private link, or the account's support page with the ticket open. */
export function ticketLink(t: { ref: string; customerType: string; accessToken: string | null }): string {
  return t.customerType === 'GUEST' && t.accessToken
    ? `${siteBase()}/support/t/${t.accessToken}`
    : `${siteBase()}${ticketAppPath(t.ref)}`;
}

/** In-app path of a ticket for a signed-in customer (bell notifications). */
export function ticketAppPath(ref: string): string {
  return `/app/support?open=${encodeURIComponent(ref)}#${encodeURIComponent(ref)}`;
}

/**
 * Make a guest ticket's private link valid at least until `minExpiry`
 * (default: a full magic-link period from now). A live link is extended in
 * place; an expired or missing one is replaced by a new token (the old link
 * stays dead). Registered tickets and legacy links without an expiry are
 * left alone.
 */
export async function renewGuestLink(
  t: Pick<SupportTicket, 'id' | 'customerType' | 'accessToken' | 'accessTokenExpiresAt'>,
  minExpiry: Date = magicLinkExpiry(),
): Promise<{ token: string | null; expiresAt: Date | null }> {
  if (t.customerType !== 'GUEST') return { token: t.accessToken, expiresAt: t.accessTokenExpiresAt };
  if (t.accessToken && !t.accessTokenExpiresAt) return { token: t.accessToken, expiresAt: null };
  const now = new Date();
  const expiresAt = new Date(Math.max(minExpiry.getTime(), t.accessTokenExpiresAt?.getTime() ?? 0));
  const live = !!t.accessToken && !!t.accessTokenExpiresAt && t.accessTokenExpiresAt.getTime() > now.getTime();
  if (live && t.accessTokenExpiresAt!.getTime() >= expiresAt.getTime()) return { token: t.accessToken, expiresAt: t.accessTokenExpiresAt };
  const token = live ? t.accessToken! : makeAccessToken();
  await prisma.supportTicket.update({
    where: { id: t.id },
    data: live
      ? { accessTokenExpiresAt: expiresAt }
      : { accessToken: token, accessTokenIssuedAt: now, accessTokenExpiresAt: expiresAt },
  });
  return { token, expiresAt };
}

// ── Orders and quote requests mentioned in a ticket ──────────────────────────

export type Customer = { userId: string | null; email: string };

const ORDER_OWNER_SELECT = {
  id: true, orderNumber: true, status: true, createdAt: true, buyerId: true, invoiceEmail: true,
  buyer: { select: { email: true } },
} as const;

type OwnedOrderRow = { id: string; orderNumber: string; status: string; createdAt: Date; buyerId: string; invoiceEmail: string | null; buyer: { email: string } | null };

export function orderBelongsTo(o: Pick<OwnedOrderRow, 'buyerId' | 'invoiceEmail' | 'buyer'>, c: Customer): boolean {
  return belongsToCustomer({ ownerId: o.buyerId, emails: [o.buyer?.email, o.invoiceEmail] }, c);
}

/** The customer's own order with this number, or null (unknown, or someone else's). */
export async function findCustomerOrder(orderNumber: string, c: Customer): Promise<OwnedOrderRow | null> {
  const o = await prisma.order.findUnique({ where: { orderNumber: orderNumber.trim().toUpperCase() }, select: ORDER_OWNER_SELECT });
  return o && orderBelongsTo(o, c) ? o : null;
}

/**
 * Commerce a new ticket talks about: the first mentioned order (L2D-…) or
 * quote proforma (PRO-…) that belongs to the customer. Numbers of other
 * customers are never linked — staff see them as "mentions order X — not
 * this customer's" on the ticket instead.
 */
export async function detectOwnedCommerce(text: string, c: Customer): Promise<{ orderId: string | null; sourcingRequestId: string | null }> {
  const orderNos = mentionedOrderNumbers(text).slice(0, 10);
  if (orderNos.length) {
    const orders = await prisma.order.findMany({ where: { orderNumber: { in: orderNos } }, select: ORDER_OWNER_SELECT });
    const own = orderNos.map((n) => orders.find((o) => o.orderNumber === n)).find((o) => o && orderBelongsTo(o, c));
    if (own) return { orderId: own.id, sourcingRequestId: null };
  }
  const proNos = mentionedProformaNumbers(text).slice(0, 10);
  if (proNos.length) {
    const reqs = await prisma.sourcingRequest.findMany({
      where: { proformaNumber: { in: proNos } },
      select: { id: true, proformaNumber: true, submittedById: true, buyerEmail: true },
    });
    const own = proNos
      .map((n) => reqs.find((r) => r.proformaNumber === n))
      .find((r) => r && belongsToCustomer({ ownerId: r.submittedById, emails: [r.buyerEmail] }, c));
    if (own) return { orderId: null, sourcingRequestId: own.id };
  }
  return { orderId: null, sourcingRequestId: null };
}

// ── Customer replies ─────────────────────────────────────────────────────────

/** Why the customer cannot reply to this ticket (shown as is), or null. */
export function customerReplyRefusal(t: Pick<SupportTicket, 'ref' | 'status' | 'updatedAt' | 'archivedAt'>): string | null {
  const rule = customerReplyRule(t, reopenDays());
  if (rule.canReply) return null;
  if (t.status === 'SPAM') return 'This ticket is closed and cannot take replies. Please open a new ticket.';
  return `This ticket could be reopened until ${supportDate(rule.reopenUntil!)}. Please open a new ticket and mention ${t.ref}.`;
}

/**
 * Store a customer's (or guest's) message and hand the ticket back to the
 * team: WAITING_ON_SUPPORT, out of the archive, the SLA clock (re)started
 * when the ball was with the customer. Then the intake e-mail, the staff
 * bell and the audit entry. The caller has checked access, the rate limit
 * and customerReplyRefusal().
 */
export async function recordCustomerReply(
  t: SupportTicket,
  m: {
    authorId: string | null;
    /** Name shown to staff ("Jane Doe", or "Jane Doe (jane@lab.com)" for a guest). */
    authorLabel: string;
    /** Who, for the audit trail (the account or ticket e-mail). */
    actor: string;
    body: string;
    urls: string[];
    names: string[];
    via: 'account' | 'guest';
  },
): Promise<{ reopened: boolean }> {
  const now = new Date();
  const reopened = t.status === 'RESOLVED' || t.status === 'CLOSED' || !!t.archivedAt;
  const sla = slaAfterCustomerMessage(t) === 'restart'
    ? { dueAt: computeTicketDueAt(now, t.priority), slaBreachAt: null }
    : {};
  await prisma.supportMessage.create({
    data: { ticketId: t.id, fromStaff: false, authorId: m.authorId, body: m.body.slice(0, 5000), attachments: m.urls, attachmentNames: m.names },
  });
  await prisma.supportTicket.update({
    where: { id: t.id },
    data: {
      status: 'WAITING_ON_SUPPORT',
      lastReplyAt: now,
      lastReplyByStaff: false,
      // BUG-018: a customer reply MUST resurface the ticket to the working
      // queue — also when it reopens a resolved / closed (archived) ticket.
      archivedAt: null,
      archivedById: null,
      ...sla,
    },
  });

  const ops = process.env.SUPPORT_INTAKE_EMAIL || process.env.SUPPORT_EMAIL || process.env.COMPANY_EMAIL || '';
  const label = m.via === 'guest' ? 'Guest' : 'Customer';
  const files = m.urls.length ? `<p style="color:#6b7280;">+ ${m.urls.length} attachment${m.urls.length === 1 ? '' : 's'}</p>` : '';
  // Staff copy — skipped for placeholder inboxes and never fatal: the reply is saved.
  await sendInternalEmail({
    to: ops,
    subject: `[${t.ref}] ${label} ${reopened ? 'reopened' : 'reply'}: ${headerText(t.subject, 160)}`,
    html: `<p>${escapeHtml(m.authorLabel)} ${reopened ? 'reopened' : 'replied to'} ticket ${t.ref}:</p><blockquote style="border-left:3px solid #A3E635;padding-left:12px;color:#555;">${escapeHtmlLines(m.body)}</blockquote>${files}<p><a href="${siteBase()}/admin/tickets/${t.id}">Open the ticket</a></p>`,
  }, m.via === 'guest' ? 'support:guest-reply' : 'support:customer-reply');
  await notifyAdmins(
    `${label} ${reopened ? 'reopened' : 'replied'} · ${t.ref}`,
    `${m.authorLabel} ${reopened ? 'reopened' : 'replied on'} "${t.subject}"`,
    `/admin/tickets/${t.id}`,
    'TICKET_NEW',
  );
  await audit(m.via === 'guest' ? 'ticket.guest.reply' : 'ticket.customer.reply', t.ref, `${m.actor}${m.urls.length ? ` +${m.urls.length}attach` : ''}`);
  if (reopened) await audit('ticket.reopen', t.ref, `by the customer (was ${t.status}${t.archivedAt ? ', archived' : ''})`);

  revalidatePath('/app/support');
  revalidatePath('/admin/tickets');
  revalidatePath(`/admin/tickets/${t.id}`);
  return { reopened };
}
