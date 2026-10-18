import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { escapeHtml, headerText } from '@/lib/email-html';
import { consumeReservation, releaseReservation, reserveStock } from '@/lib/stock/reserve';
import { QUOTE_REF, fmtDay } from '@/lib/quotes/offer';
import { mailLayout, siteBase } from './mail';

/**
 * Stock holds for quote deals (A09) on top of lib/stock/reserve.ts. One hold per
 * quote: source QUOTE, refId = the SourcingRequest id. Product.quantity is the
 * AVAILABLE count, so a held unit can not be bought with Buy Now / the cart
 * (their guarded decrement needs quantity ≥ 1) and no other offer on it can be
 * accepted.
 *
 *  - reserved when the offer is sent / accepted / paid (STOCK_RESERVE_ON);
 *    a revised offer quantity resizes the hold;
 *  - released exactly once on decline, close, expiry, buyer or staff cancel
 *    (an expired open-offer hold tells the buyer and the assignee);
 *  - consumed (sold, no restock) when the payment is verified / approved on
 *    terms — decided by the hold's state, not by the current setting, so a
 *    paid order takes its unit exactly once even if STOCK_RESERVE_ON changed
 *    in between.
 * Server-internal (no session checks) — never import from a client component.
 */

type Db = Prisma.TransactionClient;

export interface UnitAvailability {
  productId: string;
  quantity: number;
  /** This quote already holds the unit. */
  heldByThisQuote: boolean;
  /** Units this quote holds (0 when none) — available to it on top of `quantity`. */
  heldQty: number;
  /** Other active holds on the product (order / other quote). */
  otherHolds: Array<{ source: string; refId: string; orderNumber: string | null; quoteRef: string | null }>;
}

const quoteRefOf = (id: string) => QUOTE_REF(id);

/** What staff need to know before sending / while viewing an offer on a listed unit. */
export async function unitAvailability(productId: string, quoteId: string): Promise<UnitAvailability | null> {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, quantity: true } });
  if (!product) return null;
  const holds = await prisma.stockReservation.findMany({
    where: { productId, releasedAt: null, consumedAt: null },
    select: { source: true, refId: true, qty: true, order: { select: { orderNumber: true } } },
  });
  const mine = holds.filter((h) => h.source === 'QUOTE' && h.refId === quoteId);
  return {
    productId,
    quantity: product.quantity,
    heldByThisQuote: mine.length > 0,
    heldQty: mine.reduce((a, h) => a + h.qty, 0),
    otherHolds: holds
      .filter((h) => !(h.source === 'QUOTE' && h.refId === quoteId))
      .map((h) => ({ source: h.source, refId: h.refId, orderNumber: h.order?.orderNumber ?? null, quoteRef: h.source === 'QUOTE' ? quoteRefOf(h.refId) : null })),
  };
}

export type HoldResult = { ok: true; created: boolean } | { ok: false; message: string };

/**
 * Hold `qty` units for the quote (idempotent per quote; an existing hold is
 * resized to `qty`). With `orderId` the hold belongs to the accepted order and
 * never expires on its own (it ends when the order is paid or canceled);
 * without, it expires at `expiresAt` (open offer).
 */
export async function holdUnitForQuote(
  tx: Db,
  p: { quoteId: string; productId: string; qty: number; orderId?: string | null; expiresAt?: Date | null },
): Promise<HoldResult> {
  const r = await reserveStock(
    { productId: p.productId, qty: p.qty, source: 'QUOTE', refId: p.quoteId, orderId: p.orderId ?? null, expiresAt: p.orderId ? null : p.expiresAt ?? null },
    tx,
  );
  if (!r.ok) return { ok: false, message: r.message };
  if (!r.created) {
    // An existing open-offer hold now belongs to the accepted order: no expiry.
    await tx.stockReservation.update({
      where: { id: r.reservationId },
      data: p.orderId ? { orderId: p.orderId, expiresAt: null } : { expiresAt: p.expiresAt ?? null },
    });
  }
  return { ok: true, created: r.created };
}

/** Put the quote's held unit back on sale (exactly once). Returns units released. */
export async function releaseQuoteHold(quoteId: string, reason: string, tx?: Db): Promise<number> {
  return releaseReservation({ source: 'QUOTE', refId: quoteId }, reason, tx);
}

/** The held unit was sold (payment verified / approved on terms). */
export async function consumeQuoteHold(quoteId: string, tx?: Db): Promise<number> {
  return consumeReservation({ source: 'QUOTE', refId: quoteId }, tx);
}

/** Did this (quote) order take a unit out of stock? (A consumed or active hold exists.) */
export async function quoteOrderTookStock(orderId: string, db: Db | typeof prisma = prisma): Promise<boolean> {
  const n = await db.stockReservation.count({ where: { orderId, source: 'QUOTE', releasedAt: null } });
  return n > 0;
}

/** Outcome of taking a paid quote order's unit out of stock. */
export interface TakeUnitResult {
  /** The unit is sold to this order (or the order holds no listed unit). */
  ok: boolean;
  /** The unit is no longer in stock: staff decide refund, backorder or another unit (STOCK_SHORTAGE). */
  short: boolean;
  /** For staff ('' when there is nothing to say). */
  warning: string;
}

const taken = (): TakeUnitResult => ({ ok: true, short: false, warning: '' });

/**
 * A quote order was paid: its listed unit is sold to it (A09). Decided by
 * STATE, never by the current STOCK_RESERVE_ON (the setting may have changed
 * since the offer was sent or accepted):
 *  - already sold to this order (a second "paid" path, e.g. mark-paid + card
 *    webhook) → nothing more is taken;
 *  - a hold exists (offer sent / accepted) → it follows the order quantity and
 *    is consumed;
 *  - no hold (PAYMENT_VERIFIED, or the mode changed) → the unit is taken now
 *    with the guarded decrement and consumed;
 *  - the unit is gone → `short`: nothing is taken, the payment still counts
 *    (money arrived) and staff decide refund, backorder or another unit.
 * Used by every "paid" path: verify / mark paid / terms (admin) and a card
 * payment confirmed by the Stripe webhook (pay-by-card on the payment page).
 */
export async function takeQuoteUnit(
  tx: Prisma.TransactionClient,
  order: { id: string; sourcingRequestId: string | null; items: Array<{ productId: string | null; quantity: number }> },
): Promise<TakeUnitResult> {
  if (!order.sourcingRequestId) return taken();
  const quoteId = order.sourcingRequestId;
  const sold = await tx.stockReservation.findFirst({
    where: { source: 'QUOTE', refId: quoteId, orderId: order.id, consumedAt: { not: null }, releasedAt: null },
    select: { id: true },
  });
  if (sold) return taken();
  const item = order.items.find((i) => i.productId) ?? order.items[0];
  if (item?.productId) {
    const h = await holdUnitForQuote(tx, { quoteId, productId: item.productId, qty: item.quantity, orderId: order.id });
    if (!h.ok) {
      return {
        ok: false,
        short: true,
        warning: `Unit no longer in stock: ${h.message.replace(/\.$/, '')}. The payment counts — decide refund, backorder or another unit before shipping or invoicing.`,
      };
    }
  }
  await consumeQuoteHold(quoteId, tx);
  return taken();
}

/**
 * takeQuoteUnit for the callers that append a sentence to their staff message:
 * '' when the unit was taken, else " Warning: …".
 */
export async function sellQuoteUnit(tx: Prisma.TransactionClient, quoteId: string, orderId: string, item: { productId: string | null; quantity: number } | undefined): Promise<string> {
  const r = await takeQuoteUnit(tx, { id: orderId, sourcingRequestId: quoteId, items: item ? [item] : [] });
  return r.warning ? ` Warning: ${r.warning}` : '';
}

/** What the buyer and staff are told when an open offer's hold lapsed (pure). */
export function holdLapsedNotice(p: {
  quoteId: string;
  buyerName: string;
  item: string;
  qty: number;
  expiredAt: Date;
  validUntilAt: Date | null;
  now: Date;
}): { subject: string; html: (buyerLink: string) => string; buyerNote: string; staffBody: (mail: { ok: boolean; error?: string }) => string } {
  const ref = QUOTE_REF(p.quoteId);
  const many = p.qty > 1;
  const units = many ? `${p.qty} units` : 'the unit';
  const offerOpen = !!p.validUntilAt && p.validUntilAt.getTime() > p.now.getTime();
  const until = p.validUntilAt ? fmtDay(p.validUntilAt) : null;
  return {
    subject: `[${ref}] The reservation for your offer has ended — ${headerText(p.item, 80)}`,
    html: (buyerLink) => mailLayout({
      heading: 'Your reservation has ended',
      body: [
        `Hi <span dir="auto">${escapeHtml(p.buyerName)}</span>,`,
        `We had reserved ${units} of <strong dir="auto">${escapeHtml(p.item)}</strong> for your offer ${ref} until ${escapeHtml(fmtDay(p.expiredAt))}. That reservation has ended: ${many ? 'the units are' : 'the unit is'} back on sale, and another buyer can now order ${many ? 'them' : 'it'}.`,
        offerOpen
          ? `Your offer itself stays valid until ${escapeHtml(until)}. You can still accept it while the unit is in stock, or reply to us if you need more time.`
          : `Your offer expired on ${escapeHtml(until ?? fmtDay(p.expiredAt))}. If you still need the item, ask us for a new offer.`,
      ],
      cta: { href: buyerLink, label: offerOpen ? 'Review the offer' : 'Ask for a new offer' },
      footer: [`Reference ${ref}`],
    }),
    buyerNote: `"${p.item}" is no longer reserved for you and is back on sale.${offerOpen ? ` Your offer stays valid until ${until} while the unit is in stock.` : ''}`,
    staffBody: (mail) =>
      `The stock reservation for this open offer ended on ${fmtDay(p.expiredAt)}: ${units} of "${p.item}" ${many ? 'are' : 'is'} back on sale. The buyer was ${mail.ok ? 'e-mailed' : `NOT reached by e-mail (${mail.error ?? 'unknown error'})`}${offerOpen ? `; the offer stays valid until ${until}` : '; the offer has expired'}. Follow up: send an updated offer to reserve the unit again, or close the quote.`,
  };
}

/**
 * An open offer's hold lapsed (releaseExpiredReservations, OFFER_SENT): the
 * unit is back on sale. The buyer — whose offer may still say "valid until …"
 * — is mailed and notified, the assignee (else the admins) too, and the quote
 * is flagged for follow-up: an internal note and dueAt = now (top of the SLA
 * queue). Quotes that are no longer open are skipped: their own ending (decline,
 * close, acceptance) already told everyone. Never throws.
 */
export async function notifyQuoteHoldLapsed(h: { quoteId: string; qty: number; expiredAt: Date }, now = new Date()): Promise<void> {
  try {
    const sr = await prisma.sourcingRequest.findUnique({
      where: { id: h.quoteId },
      select: {
        id: true, status: true, archivedAt: true, buyerEmail: true, buyerName: true, submittedById: true, accessToken: true,
        validUntilAt: true, productCategory: true, assignedToId: true,
        assignedTo: { select: { email: true, role: true } },
        product: { select: { title: true } },
      },
    });
    if (!sr || sr.status !== 'RESPONDED' || sr.archivedAt) return;
    // Dynamic: mail transport + notifications are not needed by the stock core (and its unit tests).
    const [{ trySendEmail, sendInternalEmail, isDeliverableEmail }, { notifyUser, notifyAdmins }] = await Promise.all([
      import('@/lib/email'),
      import('@/lib/observability'),
    ]);
    const ref = QUOTE_REF(sr.id);
    const notice = holdLapsedNotice({
      quoteId: sr.id, buyerName: sr.buyerName, item: sr.product?.title ?? sr.productCategory ?? 'the requested equipment',
      qty: h.qty, expiredAt: h.expiredAt, validUntilAt: sr.validUntilAt, now,
    });
    const buyerLink = sr.submittedById || !sr.accessToken ? `${siteBase()}/app/quotes/${sr.id}` : `${siteBase()}/quotes/t/${sr.accessToken}`;
    const sent = await trySendEmail({ to: sr.buyerEmail, subject: notice.subject, html: notice.html(buyerLink) }, 'quotes:hold-lapsed');
    await notifyUser(sr.submittedById, `Reservation ended — ${ref}`, notice.buyerNote, `/app/quotes/${sr.id}`);

    const staffBody = notice.staffBody(sent);
    await prisma.quoteMessage.create({ data: { sourcingRequestId: sr.id, body: staffBody, isInternalNote: true, fromStaff: true } });
    await prisma.sourcingRequest.updateMany({ where: { id: sr.id, status: 'RESPONDED' }, data: { dueAt: now } });
    const title = `Reservation ended — ${ref}`;
    if (sr.assignedToId) {
      const href = sr.assignedTo?.role === 'SELLER' ? `/app/seller/inbox/${sr.id}` : `/admin/quotes/${sr.id}`;
      await notifyUser(sr.assignedToId, title, staffBody, href);
      const staffEmail = sr.assignedTo?.email;
      if (isDeliverableEmail(staffEmail)) {
        await sendInternalEmail({
          to: staffEmail,
          subject: `[${ref}] The reservation for the open offer ended`,
          html: mailLayout({ heading: 'The reservation ended', body: [escapeHtml(staffBody)], cta: { href: `${siteBase()}${href}`, label: 'Open the request' } }),
        }, 'quotes:hold-lapsed-staff');
      }
    } else {
      await notifyAdmins(title, staffBody, `/admin/quotes/${sr.id}`, 'SYSTEM');
    }
  } catch (e) {
    await import('@/lib/observability').then((m) => m.logError('quotes:hold-lapsed', e)).catch(() => {});
  }
}
