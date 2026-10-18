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
 *              due date. validUntilAt keeps the offer validity. A VAT the rules
 *              can not decide puts the order on a VAT review (no proforma yet).
 *   DECLINED   the buyer declined the offer (optional reason in lostReason);
 *              staff may send a new offer on it (back to RESPONDED, revision+1).
 *   CLOSED     staff closed the request without a deal (reason from
 *              QUOTE_CLOSE_REASONS), the buyer canceled the unpaid order, or it
 *              lapsed unpaid (lib/orders/due-sweep.ts). A new offer for the buyer
 *              goes on a new request ("New quote for this buyer").
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

/** A text as one sentence: trimmed, with a full stop unless it already ends in . ! ? or …. */
export function sentence(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  if (!t) return '';
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

// ── Offer destination ────────────────────────────────────────────────────────

/** Incoterms whose named place is the destination (C- and D-terms); E/F-terms name the origin. */
const PLACE_IS_DESTINATION = new Set(['CPT', 'CIP', 'CFR', 'CIF', 'DAP', 'DPU', 'DDP']);

/**
 * The delivery country an offer is priced for, read from its Incoterm place
 * ("DAP Berlin, DE", "DDP Basel (CH)", "CIP Leuven, Belgium"). Null when the
 * rule names the origin (EXW, FCA …) or the place has no recognisable country.
 * `countryCode` maps a country name ("Germany") to its ISO code.
 */
export function destinationFromPlace(
  incoterm: string | null | undefined,
  place: string | null | undefined,
  countryCode: (name: string) => string | null = () => null,
): string | null {
  if (!incoterm || !PLACE_IS_DESTINATION.has(incoterm.trim().toUpperCase()) || !place?.trim()) return null;
  const p = place.trim();
  const iso = (c: string) => (c.toUpperCase() === 'UK' ? 'GB' : c.toUpperCase());
  const paren = /\(([A-Za-z]{2})\)\s*$/.exec(p);
  if (paren) return iso(paren[1]);
  const parts = p.split(/[,;/]|\s+[-–]\s+/).map((s) => s.trim()).filter(Boolean);
  const last = parts.at(-1) ?? '';
  if (/^[A-Za-z]{2}$/.test(last) && parts.length > 1) return iso(last);
  const word = /\s([A-Z]{2})$/.exec(last);
  if (word) return iso(word[1]);
  return parts.length > 1 ? countryCode(last) : null;
}

// ── Buyer–supplier mediation (Settings → Suppliers → MESSAGE_MEDIATION_MODE) ──

/** What a removed e-mail address, phone number, link or IBAN reads as. */
export const CONTACT_REMOVED = '[contact details removed]';

/** First line of a supplier message held for staff review (STAFF_REVIEW): it is an
 *  internal note until staff release it (releaseQuoteMessage strips this line). */
export const HELD_SUPPLIER_MESSAGE_PREFIX = '[Supplier message held for review — the buyer has not seen it]\n';

export function isHeldSupplierMessage(m: { body: string; isInternalNote: boolean }): boolean {
  return m.isInternalNote && m.body.startsWith(HELD_SUPPLIER_MESSAGE_PREFIX);
}

export type ContactKind = 'email' | 'link' | 'iban' | 'phone';

const CONTACT_KIND_LABEL: Record<ContactKind, string> = { email: 'e-mail addresses', link: 'links', iban: 'bank details', phone: 'phone numbers' };

/** "e-mail addresses and phone numbers" — what was removed, in words. */
export function contactKindsLabel(kinds: readonly ContactKind[]): string {
  const words = kinds.map((k) => CONTACT_KIND_LABEL[k]);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] ?? 'contact details';
}

const digits = (s: string) => s.replace(/\D/g, '').length;
const LOOKS_LIKE_DATE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/;
const CONTACT_PATTERNS: Array<{ kind: ContactKind; re: RegExp; keep?: (m: string) => boolean }> = [
  { kind: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi },
  { kind: 'email', re: /[A-Z0-9._%+-]+\s*[[(]\s*at\s*[\])]\s*[A-Z0-9-]+(?:\s*(?:\.|[[(]\s*dot\s*[\])])\s*[A-Z0-9-]+)+/gi },
  { kind: 'link', re: /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi },
  { kind: 'link', re: /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|biz|io|co|eu|de|nl|be|fr|uk|ch|at|it|es|pl|se|dk|no|fi|cz|us|ca|au|cn|jp|ru|shop|store)\b(?:\/[^\s<>()]*)?/gi },
  // 15+ characters (the shortest IBAN), so serial numbers and VAT IDs stay.
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, keep: (m) => m.replace(/\s/g, '').length < 15 },
  // International (+49 …, 0049 …) and national (030 …, (0)20 …) numbers with at least 8 digits.
  { kind: 'phone', re: /(?:\+|\b00)\d[\d ().\/-]{6,}\d/g, keep: (m) => digits(m) < 8 },
  { kind: 'phone', re: /(?:\(0\d{1,4}\)|\b0\d{1,4})[ .\/-]?\d[\d .\/-]{4,}\d/g, keep: (m) => digits(m) < 9 || LOOKS_LIKE_DATE.test(m) },
];

/**
 * MASK_CONTACTS: e-mail addresses, links / web addresses, IBANs and phone
 * numbers in a supplier's message replaced with CONTACT_REMOVED, so buyer and
 * supplier keep dealing through the platform. Prices, dates, serial and order
 * numbers stay (a phone number needs a leading + / 00 / 0 and 8+ digits).
 */
export function maskContactDetails(text: string): { text: string; masked: boolean; kinds: ContactKind[] } {
  let out = text;
  const kinds = new Set<ContactKind>();
  for (const p of CONTACT_PATTERNS) {
    out = out.replace(p.re, (m) => {
      if (p.keep?.(m)) return m;
      kinds.add(p.kind);
      return CONTACT_REMOVED;
    });
  }
  return { text: out, masked: kinds.size > 0, kinds: Array.from(kinds) };
}

/**
 * What happens to a supplier's message to the buyer under a mediation mode:
 * the stored body, whether it is held for staff (an internal note until
 * released) and what was removed. Staff and buyer messages are never changed.
 */
export function mediateSupplierMessage(
  mode: 'MASK_CONTACTS' | 'STAFF_REVIEW' | 'OFF',
  body: string,
): { body: string; held: boolean; removed: ContactKind[] } {
  if (mode === 'STAFF_REVIEW') return { body: `${HELD_SUPPLIER_MESSAGE_PREFIX}${body}`, held: true, removed: [] };
  if (mode === 'MASK_CONTACTS') {
    const m = maskContactDetails(body);
    return { body: m.text, held: false, removed: m.kinds };
  }
  return { body, held: false, removed: [] };
}

// ── Decline / close claims ───────────────────────────────────────────────────

type QuoteStatusCode = 'PENDING' | 'RESPONDED' | 'ACCEPTED' | 'DECLINED' | 'CLOSED';

/**
 * The guarded write of a decline or a close (lib/quotes/actions.ts): the
 * state it may change, so a concurrent acceptance or a newer offer wins.
 *  - decline: only the offer revision the buyer looked at, while it is open;
 *  - close: anything not closed and not accepted — an acceptance that committed
 *    first keeps its order (nothing canceled, no "closed" mail); an accepted
 *    quote whose order was canceled (checked by the caller) closes from ACCEPTED.
 */
export function statusClaimFilter(
  target: 'DECLINED' | 'CLOSED',
  current: string,
  offerRevision: number,
): { status: QuoteStatusCode | { notIn: QuoteStatusCode[] }; offerRevision?: number } {
  if (target === 'DECLINED') return { status: 'RESPONDED', offerRevision };
  if (current === 'ACCEPTED') return { status: 'ACCEPTED' };
  return { status: { notIn: ['CLOSED', 'ACCEPTED'] } };
}
