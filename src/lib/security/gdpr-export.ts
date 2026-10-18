import { prisma } from '@/lib/db';
import { deliveryState, messageText, visibleToParticipant } from '@/lib/messages/mediation';

/**
 * GDPR art. 15 / 20 export (A18): everything held about the signed-in person,
 * machine-readable, WITHOUT staff-internal material (internal notes, admin
 * notes, which staff member did what, assignment to an (anonymous) supplier,
 * access tokens, password hashes, session tokens).
 *
 * Rows are exported whole minus internal fields, so personal data added to
 * these models later (billing profile, VAT ID …) is included automatically;
 * internal fields are recognised by name (see INTERNAL_KEY) or listed per
 * model in OMIT.
 */

/** Field names that are staff-internal on any model. */
const INTERNAL_KEY = /(ById|ByEmail)$|admin|internal|staff|accessToken|^tags$|^priority$|^slaBreachAt$|^dueAt$|^assignedTo/i;

const OMIT: Record<string, string[]> = {
  order: ['paymentNote', 'archivedAt'],
  quote: ['archivedAt', 'lastReplyByStaff', 'paymentInstructionsSnapshot'],
  ticket: ['archivedAt', 'lastReplyByStaff', 'customerType'],
  sell: ['archivedAt'],
  user: [],
};

type Row = Record<string, unknown>;

export function stripInternal<T extends Row>(row: T, model: keyof typeof OMIT | string): Row {
  const omit = new Set(OMIT[model] ?? []);
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (omit.has(k) || INTERNAL_KEY.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function buildPersonalDataExport(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { company: { select: { name: true } } },
  });
  if (!user) return null;
  const email = user.email.toLowerCase();
  const byMe = { OR: [{ submittedById: userId }, { email: { equals: email, mode: 'insensitive' as const } }] };

  const [orders, quotes, tickets, sells, threads, chats, reviews, comments, wishlist, cart, notifications, sessions, accounts, consents, emails, signIns] =
    await Promise.all([
      prisma.order.findMany({ where: { buyerId: userId }, include: { items: true }, orderBy: { createdAt: 'asc' } }),
      prisma.sourcingRequest.findMany({
        where: { OR: [{ submittedById: userId }, { buyerEmail: { equals: email, mode: 'insensitive' } }] },
        include: {
          product: { select: { title: true, slug: true } },
          messages: { where: { isInternalNote: false }, orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.supportTicket.findMany({
        where: byMe,
        include: { messages: { where: { isInternalNote: false }, orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.sellSubmission.findMany({
        where: byMe,
        include: { messages: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.messageThread.findMany({
        where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
        include: { product: { select: { title: true, slug: true } }, messages: { where: visibleToParticipant(userId), orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.assistantConversation.findMany({
        where: { userId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
        orderBy: { startedAt: 'asc' },
      }),
      prisma.review.findMany({ where: { userId }, include: { product: { select: { title: true, slug: true } } } }),
      prisma.blogComment.findMany({
        where: { authorEmail: { equals: email, mode: 'insensitive' } },
        include: { post: { select: { title: true, slug: true } } },
      }),
      prisma.wishlistItem.findMany({ where: { userId }, include: { product: { select: { title: true, slug: true } } } }),
      prisma.cartItem.findMany({ where: { userId }, include: { product: { select: { title: true, slug: true } } } }),
      prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.session.findMany({
        where: { userId },
        select: { createdAt: true, expiresAt: true, lastActiveAt: true, ipAddress: true, userAgent: true },
      }),
      prisma.account.findMany({ where: { userId }, select: { providerId: true, createdAt: true, updatedAt: true } }),
      prisma.consentEvent.findMany({ where: { OR: [{ userId }, { email }] }, orderBy: { createdAt: 'asc' } }),
      prisma.emailLog.findMany({
        where: { toAddr: { equals: email, mode: 'insensitive' } },
        select: { subject: true, status: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      // Their own sign-in / security events (not what staff did).
      prisma.auditLog.findMany({
        where: { action: { startsWith: 'auth.' }, OR: [{ actorId: userId }, { actorEmail: { equals: email, mode: 'insensitive' } }] },
        select: { action: true, ip: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

  // Who wrote a quote message, without naming staff or the (anonymous) supplier.
  const from = (authorId: string | null, fromStaff: boolean) =>
    fromStaff || (authorId && authorId !== userId) ? 'lab2date' : 'you';

  return {
    exportedAt: new Date().toISOString(),
    about:
      'Everything lab2date holds about your account. Internal staff notes and the identity of staff members or suppliers working on your requests are not personal data about you and are left out. Invoices and order records are kept for 7 years under Dutch tax law.',
    account: {
      ...stripInternal(user as unknown as Row, 'user'),
      company: user.company?.name ?? null,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
    signInMethods: accounts,
    sessions,
    signInHistory: signIns,
    marketingConsent: {
      current: user.marketingOptIn,
      history: consents.map((c) => stripInternal(c as unknown as Row, 'consent')),
    },
    orders: orders.map((o) => ({
      ...stripInternal(o as unknown as Row, 'order'),
      items: o.items.map((i) => stripInternal(i as unknown as Row, 'orderItem')),
    })),
    quotes: quotes.map((q) => ({
      ...stripInternal(q as unknown as Row, 'quote'),
      messages: q.messages.map((m) => ({
        from: from(m.authorId, m.fromStaff),
        body: m.body,
        attachments: m.attachments,
        createdAt: m.createdAt,
      })),
    })),
    supportTickets: tickets.map((t) => ({
      ...stripInternal(t as unknown as Row, 'ticket'),
      messages: t.messages.map((m) => ({ from: m.fromStaff ? 'lab2date' : 'you', body: m.body, attachments: m.attachments, createdAt: m.createdAt })),
    })),
    equipmentOffers: sells.map((s) => ({
      ...stripInternal(s as unknown as Row, 'sell'),
      messages: s.messages.map((m) => ({
        from: m.fromStaff ? 'lab2date' : 'you',
        kind: m.kind,
        body: m.body,
        priceCents: m.priceCents,
        currency: m.currency,
        attachments: m.attachments,
        createdAt: m.createdAt,
      })),
    })),
    conversations: threads.map((t) => ({
      subject: t.subject,
      product: t.product,
      yourRole: t.buyerId === userId ? 'buyer' : 'supplier',
      createdAt: t.createdAt,
      messages: t.messages.map((m) => ({ from: m.authorId === userId ? 'you' : 'the other party', body: messageText(m.body), delivery: deliveryState(m.body).toLowerCase(), createdAt: m.createdAt, readAt: m.readAt })),
    })),
    assistantChats: chats.map((c) => ({
      subject: c.subject,
      status: c.status,
      startedAt: c.startedAt,
      guestName: c.guestName,
      guestEmail: c.guestEmail,
      rating: c.rating,
      ratingNote: c.ratingNote,
      messages: c.messages.map((m) => ({
        from: m.role === 'user' ? 'you' : m.role === 'assistant' ? 'assistant (AI)' : 'lab2date',
        body: m.body,
        attachments: m.attachments,
        createdAt: m.createdAt,
      })),
    })),
    reviews: reviews.map((r) => ({ product: r.product, rating: r.rating, body: r.body, createdAt: r.createdAt })),
    blogComments: comments.map((c) => ({ post: c.post, authorName: c.authorName, body: c.body, approved: c.approved, createdAt: c.createdAt })),
    wishlist: wishlist.map((w) => ({ product: w.product, addedAt: w.createdAt })),
    cart: cart.map((c) => ({ product: c.product, quantity: c.quantity, addedAt: c.createdAt })),
    notifications: notifications.map((n) => ({ title: n.title, body: n.body, href: n.href, kind: n.kind, readAt: n.readAt, createdAt: n.createdAt })),
    emailsSentToYou: emails,
  };
}
