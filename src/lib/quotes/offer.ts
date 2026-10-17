/**
 * Quote → offer → acceptance: the pure rules shared by the server actions, the
 * pages that show an offer, and the documents. Not a 'use server' module (every
 * export of one becomes a public endpoint) and free of settings / DB access —
 * it is imported by client-safe modules (lib/documents/index.ts).
 *
 * Lifecycle (SourcingRequest.status):
 *   PENDING    request received, nothing sent yet
 *   RESPONDED  staff replied; when quotedPriceCents is set an OFFER is open and
 *              the buyer can accept or decline it until validUntilAt (the
 *              offer validity). The offer's amounts and terms are a snapshot
 *              (offer* columns + offerTerms, see pricing.ts). No order, no
 *              proforma number exist yet. Staff may update the offer (revision+1).
 *   ACCEPTED   the buyer accepted with their billing + delivery details: ONE
 *              order (PENDING_PAYMENT, VAT decided by the engine) + a proforma
 *              were created in the same transaction; Order.dueAt is the payment
 *              due date. validUntilAt keeps the offer validity.
 *   DECLINED   the buyer declined the offer (optional reason in lostReason).
 *   CLOSED     staff closed the request without a deal, the buyer canceled the
 *              unpaid order, or it lapsed unpaid (lib/orders/due-sweep.ts).
 */

/** Built-in fallback when the OFFER_CURRENCIES setting is unreadable. */
export const OFFER_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'] as const;

/** End of the given calendar day (UTC) — "valid until 2026-10-16" means the
 *  whole of that day, not midnight at its start. */
export function endOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/** Prefix of quote references (Settings → Quotes & offers → Quote reference prefix; RFQ by default).
 *  Server code sees the setting (hydrated into process.env); a client bundle uses the default. */
export function quoteRefPrefix(): string {
  const v = (typeof process !== 'undefined' ? process.env.QUOTE_REFERENCE_PREFIX : '') || '';
  return /^[A-Za-z0-9]{1,8}$/.test(v.trim()) ? v.trim().toUpperCase() : 'RFQ';
}

/** "RFQ-3F9A2C": the quote's reference until a proforma number exists. */
export const QUOTE_REF = (id: string) => `${quoteRefPrefix()}-${id.slice(-6).toUpperCase()}`;

/** Settings → Quotes & offers → Largest offer amount (goods, in cents; default 1,000,000.00). */
export function offerMaxCents(): number {
  const n = Number.parseInt((typeof process !== 'undefined' ? process.env.OFFER_MAX_AMOUNT_CENTS : '') || '', 10);
  return Number.isFinite(n) && n >= 100 ? Math.min(n, 2_000_000_000) : 100_000_000;
}

/** A typed quote reference ("RFQ-3F9A2C", "RFQ3F9A2C", or with the configured prefix) — for search boxes. */
export function isQuoteRef(q: string): boolean {
  const m = /^([A-Za-z0-9]{1,8})-?([a-z0-9]{6})$/i.exec(q.trim());
  return !!m && ['RFQ', quoteRefPrefix()].includes(m[1].toUpperCase());
}

/** Legacy display fallback for quotes accepted before numbered proformas
 *  (the old PRO-YYYY-XXXXXX scheme). New proformas come from the PF series. */
export function proformaNumberFor(id: string, issuedAt = new Date()): string {
  return `PRO-${issuedAt.getFullYear()}-${id.slice(-6).toUpperCase()}`;
}

/** The reference shown for a quote: the proforma number once the offer was
 *  accepted, the RFQ reference before. */
export function quoteRef(sr: { id: string; proformaNumber: string | null }): string {
  return sr.proformaNumber ?? QUOTE_REF(sr.id);
}

const LIVE_ORDER = ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
export const PAID_ORDER_STATES: readonly string[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

export type OfferPhase =
  | 'none'          // no price sent yet
  | 'open'          // offer awaiting the buyer's decision
  | 'expired'       // offer past its validity — cannot be accepted
  | 'accepted'      // accepted (order + proforma exist)
  | 'void';         // declined / closed / its order canceled

/**
 * Where an offer stands, from the buyer's point of view. A legacy quote that
 * the old code "auto-accepted" (RESPONDED + an unpaid order without a payment
 * proof) still counts as an OPEN offer: acceptance adopts that order. The
 * server refuses to accept anything that is not 'open' (acceptOffer).
 */
export function offerPhase(
  sr: { status: string; quotedPriceCents: number | null; validUntilAt: Date | string | null },
  linkedOrder: { status: string; paymentSubmittedAt?: Date | string | null } | null | undefined,
  now = Date.now(),
): OfferPhase {
  if (sr.status === 'DECLINED' || sr.status === 'CLOSED') return 'void';
  if (sr.status === 'ACCEPTED') return 'accepted';
  if (sr.quotedPriceCents == null) return 'none';
  if (linkedOrder) {
    if (linkedOrder.status === 'CANCELED' || linkedOrder.status === 'REFUNDED') return 'void';
    // Legacy: paid, or a payment proof already sent → the buyer committed.
    if (linkedOrder.status !== 'PENDING_PAYMENT' || linkedOrder.paymentSubmittedAt) return 'accepted';
  }
  const until = sr.validUntilAt ? new Date(sr.validUntilAt).getTime() : null;
  if (until != null && until < now) return 'expired';
  return 'open';
}

/** A linked order that still matters (anything but canceled/refunded). */
export function isLiveOrder(status: string | null | undefined): boolean {
  return !!status && LIVE_ORDER.includes(status);
}

/** Offer validity in the UI: "16 Oct 2026". */
export function fmtDay(d: Date | string): string {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** ISO date (YYYY-MM-DD) in UTC. */
export function isoDay(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10);
}
