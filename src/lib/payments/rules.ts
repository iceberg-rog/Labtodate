/**
 * Pure rules for booking money on an order — verifying a buyer's receipt,
 * marking an order paid by hand — plus a few admin input checks that live
 * next to them. No I/O (no Prisma, no settings): the server actions
 * (./actions.ts, the buyer payment action) pass in what they read.
 * Unit tests: rules.test.ts.
 */

// ── amounts typed from a bank statement ─────────────────────────────────────

export type AmountParse = { ok: true; cents: number } | { ok: false; message: string };

/**
 * An amount as staff type it from a bank statement. Accepted: 1210 · 1210.5 ·
 * 1210,50 · 1.210,50 (Dutch) · 1,210.50 (English) · 1.234.567 · 1,234,567.
 * A single separator followed by exactly three digits ("1.210", "1,210") is
 * refused: it is €1,210.00 to a Dutch reader and €1.21 to an English one.
 */
export function parseAmountInput(raw: string): AmountParse {
  const shown = raw.trim();
  const v = shown.replace(/[\s€$£]/g, '').replace(/^[a-z]{3}|[a-z]{3}$/gi, '');
  if (!v) return { ok: false, message: 'Enter the amount received, e.g. 1210.00.' };
  let norm: string | null = null;
  if (/^\d+$/.test(v)) norm = v;
  else if (/^\d+[.,]\d{1,2}$/.test(v)) norm = v.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(v)) norm = v.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(v)) norm = v.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3}){2,}$/.test(v)) norm = v.replace(/\./g, '');
  else if (/^\d{1,3}(,\d{3}){2,}$/.test(v)) norm = v.replace(/,/g, '');
  else if (/^\d{1,3}[.,]\d{3}$/.test(v)) {
    const whole = v.replace(/[.,]/, '');
    const decimal = Number(v.replace(',', '.')).toFixed(2);
    return { ok: false, message: `“${shown}” is ambiguous: ${whole}.00 or ${decimal}? Enter the amount with cents, e.g. ${whole}.00.` };
  }
  if (norm === null) return { ok: false, message: `“${shown}” is not an amount — enter it like 1210.00 (at most 2 decimals).` };
  const [whole, frac = ''] = norm.split('.');
  const cents = Number(whole) * 100 + Number(`${frac}00`.slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0) return { ok: false, message: 'The amount received must be more than 0.' };
  return { ok: true, cents };
}

// ── value dates ─────────────────────────────────────────────────────────────

/** The calendar day (YYYY-MM-DD) of `d` in `timeZone`. */
export function dayInZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** A value date (stored as YYYY-MM-DDT12:00Z) as printed: "16 Oct 2026" — a day, never a time. */
export function fmtValueDay(d: Date | string): string {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const longDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export interface ReceivedInput {
  amount: string;
  /** YYYY-MM-DD from the date picker ('' = not given). */
  date: string;
  bankRef: string;
  /** PAYMENT_REQUIRE_AMOUNT_ON_VERIFY: amount and value date must be typed. */
  required: boolean;
  /** What is still open on the order (the amount used when none is typed). */
  openCents: number;
  /** The order date: money is not received before the order existed. */
  orderCreatedAt: Date;
  /** Staff ticked “the value date is before the order date — confirmed”. */
  confirmEarlierDate: boolean;
  now: Date;
  /** Business time zone (the order date is that day there). */
  timeZone: string;
}

export type Received =
  | { ok: true; amountCents: number; receivedAt: Date; bankRef: string | null }
  | { ok: false; message: string; confirm?: 'EARLIER_DATE' };

/** What staff read from the bank statement: amount, value date, the bank's reference. */
export function readReceived(i: ReceivedInput): Received {
  const amount = i.amount.trim();
  const date = i.date.trim();
  const bankRef = i.bankRef.trim().slice(0, 120) || null;
  if (i.required && (!amount || !date)) {
    return { ok: false, message: 'Enter the amount received and the value date from the bank statement — the invoice prints them, and a short payment is never booked as paid in full.' };
  }
  let amountCents = i.openCents;
  if (amount) {
    const p = parseAmountInput(amount);
    if (!p.ok) return { ok: false, message: p.message };
    amountCents = p.cents;
  }
  let receivedAt = i.now;
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T12:00:00Z`).getTime())) return { ok: false, message: 'Choose the value date.' };
    receivedAt = new Date(`${date}T12:00:00Z`);
    if (receivedAt.getTime() > i.now.getTime() + 86_400_000) return { ok: false, message: 'The value date can not be in the future.' };
    if (receivedAt.getTime() < i.now.getTime() - 400 * 86_400_000) return { ok: false, message: 'The value date is more than a year ago — check it.' };
    const orderDay = dayInZone(i.orderCreatedAt, i.timeZone);
    if (date < orderDay && !i.confirmEarlierDate) {
      return {
        ok: false,
        confirm: 'EARLIER_DATE',
        message: `The value date ${longDay(date)} is before the order date (${longDay(orderDay)}), and the invoice would say it was paid then. Check the bank statement; if the date is right, tick “Value date before the order date — confirmed” and book it again.`,
      };
    }
  }
  return { ok: true, amountCents, receivedAt, bankRef };
}

/**
 * A receipt for much less than is open is usually a typing mistake (1.210 for
 * 1,210.00): below `pct` % of the open amount (PAYMENT_LOW_AMOUNT_CONFIRM_PCT)
 * staff confirm it first. 0 = never ask.
 */
export function lowAmountNeedsConfirm(amountCents: number, openCents: number, pct: number): boolean {
  return pct > 0 && openCents > 0 && amountCents * 100 < openCents * pct;
}

// ── when can money be booked by hand ────────────────────────────────────────

/** Verification states in which “mark as paid” is refused: the buyer's own step decides. */
export const MANUAL_PAY_BLOCKING_VERIFICATION = ['AWAITING_VERIFICATION', 'TERMS_REQUESTED'] as const;
/** Hold that means money already came in and did not match (Stripe). */
export const PAYMENT_REVIEW_HOLD = 'PAYMENT_REVIEW';

/**
 * Why an unpaid order can NOT be marked paid by hand, or null when it can.
 * `holdMessage` is prePaymentHoldMessage(order) (lib/documents/issue.ts): an
 * order on a pre-payment hold (export compliance, VAT, address, freight) has
 * no payment request, so no money is booked on it either.
 */
export function manualPaymentBlocker(o: {
  holdMessage: string | null;
  holdReason: string | null;
  openHolds: readonly string[];
  paymentVerificationStatus: string | null;
}): string | null {
  if (o.paymentVerificationStatus === 'AWAITING_VERIFICATION') {
    return 'The buyer uploaded a payment receipt that waits for review — verify or reject the buyer’s receipt (Verify payment on the order page) instead of marking the order paid.';
  }
  if (o.paymentVerificationStatus === 'TERMS_REQUESTED') {
    return 'The buyer asked to pay on invoice — approve or decline that request on the order page first.';
  }
  return bookingHoldBlocker(o, 'MARK_PAID');
}

/**
 * Why no money is booked on an unpaid order because of its holds — by “mark
 * as paid” or by verifying the buyer's receipt — or null. A pre-payment hold
 * (export compliance, VAT, address, freight; `holdMessage`) means there is no
 * payment request yet; a payment review means earlier money did not match.
 */
export function bookingHoldBlocker(
  o: { holdMessage: string | null; holdReason: string | null; openHolds: readonly string[] },
  action: 'MARK_PAID' | 'VERIFY',
): string | null {
  if (o.holdMessage) {
    return action === 'VERIFY'
      ? `${o.holdMessage} The receipt can not be verified until that hold is cleared (Pricing, VAT & holds on the order page) — or reject the receipt.`
      : `${o.holdMessage} It can not be marked paid until that hold is cleared (Pricing, VAT & holds on the order page).`;
  }
  if (o.holdReason === PAYMENT_REVIEW_HOLD || o.openHolds.includes(PAYMENT_REVIEW_HOLD)) {
    return 'A payment on this order is under review (it did not match the order) — resolve that review before booking another payment.';
  }
  return null;
}

// ── holds after payment ─────────────────────────────────────────────────────

/** Hold of a paid order whose unit is gone: no invoice, no dispatch until staff decide. */
export const STOCK_SHORTAGE_HOLD = 'STOCK_SHORTAGE';

/**
 * The order's hold fields with `code` released: the other holds stay, the
 * primary hold (holdReason) stays unless it was `code` — then the first hold
 * of `priority` still open (or any other) — and `code`'s note goes.
 */
export function withoutHold(
  o: { openHolds: readonly string[]; holdReason: string | null; holdNote: string | null },
  code: string,
  priority: readonly string[],
): { openHolds: string[]; holdReason: string | null; holdNote: string | null } {
  const rest = Array.from(new Set([...o.openHolds, ...(o.holdReason ? [o.holdReason] : [])])).filter((h) => h !== code);
  const holdReason = o.holdReason && o.holdReason !== code ? o.holdReason : priority.find((h) => rest.includes(h)) ?? rest[0] ?? null;
  const holdNote = (o.holdNote ?? '').split(' | ').filter((p) => p && !p.startsWith(`${code}:`)).join(' | ') || null;
  return { openHolds: rest, holdReason, holdNote };
}

/**
 * Where on the admin order page an open hold is resolved, or null when no
 * control exists for it there (yet): the quick view only points to real ones.
 */
export function holdResolvedAt(code: string, o: { unpaid: boolean; checkoutOrder: boolean }): string | null {
  switch (code) {
    case 'COMPLIANCE':
    case 'ADDRESS_REVIEW':
    case 'PAYMENT_REVIEW':
      return 'Pricing, VAT & holds';
    case 'SHIPPING_PENDING':
      return o.unpaid && o.checkoutOrder ? 'Pricing, VAT & holds' : null;
    case 'VAT_REVIEW':
      return o.unpaid ? (o.checkoutOrder ? 'Pricing, VAT & holds' : null) : 'Invoice decisions & corrections';
    case 'INVOICE_PENDING':
      return o.unpaid ? null : 'Invoice decisions & corrections';
    case STOCK_SHORTAGE_HOLD:
      return o.unpaid ? null : 'Stock shortage';
    default:
      return null;
  }
}

/** “the €200.00 still due (of €2,480.50)” on a rest payment, else just the total. */
export function receiptAmountLabel(openCents: number, totalCents: number, fmt: (cents: number) => string): string {
  return openCents > 0 && openCents < totalCents ? `the ${fmt(openCents)} still due (of ${fmt(totalCents)})` : fmt(totalCents);
}

// ── receipts of an order ────────────────────────────────────────────────────

/** The object key of a stored receipt from its URL or key (order-proofs/…), else null. */
export function proofKeyOf(urlOrKey: string | null | undefined): string | null {
  const m = (urlOrKey ?? '').match(/order-proofs\/[^?#]+/);
  return m ? m[0] : null;
}

export type ReceiptStatus = 'AWAITING' | 'REJECTED' | 'PART' | 'VERIFIED' | 'BOOKED' | 'REPLACED' | 'ON_FILE';

export interface ReceiptRow {
  key: string;
  fileName: string | null;
  /** Upload (or attach) time; null for receipts stored before receipts were kept. */
  at: Date | null;
  by: 'BUYER' | 'STAFF';
  status: ReceiptStatus;
  amountCents: number | null;
  reason: string | null;
}

/**
 * Every receipt of an order, oldest first, with what became of it — from the
 * PaymentProof events (SUBMITTED / REJECTED / PART / MANUAL), the payments
 * ledger (Payment.proofKey) and, for older orders, Order.paymentProofUrl.
 */
export function receiptHistory(input: {
  proofs: Array<{ key: string; kind: string; fileName: string | null; amountCents: number | null; rejectedReason: string | null; createdAt: Date }>;
  payments: Array<{ proofKey: string | null; amountCents: number }>;
  currentProofUrl: string | null;
  verificationStatus: string | null;
}): ReceiptRow[] {
  const rows = new Map<string, ReceiptRow>();
  const row = (key: string): ReceiptRow => {
    let r = rows.get(key);
    if (!r) {
      r = { key, fileName: null, at: null, by: 'BUYER', status: 'ON_FILE', amountCents: null, reason: null };
      rows.set(key, r);
    }
    return r;
  };
  const RANK: Record<ReceiptStatus, number> = { ON_FILE: 0, REPLACED: 1, AWAITING: 2, VERIFIED: 3, BOOKED: 4, PART: 5, REJECTED: 6 };
  const raise = (r: ReceiptRow, s: ReceiptStatus) => {
    if (RANK[s] > RANK[r.status]) r.status = s;
  };
  for (const p of [...input.proofs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = proofKeyOf(p.key);
    if (!key) continue;
    const r = row(key);
    r.fileName ??= p.fileName;
    if (p.kind === 'SUBMITTED' || p.kind === 'MANUAL') r.at ??= p.createdAt;
    if (p.kind === 'MANUAL') {
      r.by = 'STAFF';
      r.amountCents = p.amountCents;
      raise(r, 'BOOKED');
    } else if (p.kind === 'REJECTED') {
      r.reason = p.rejectedReason;
      raise(r, 'REJECTED');
    } else if (p.kind === 'PART') {
      r.amountCents = p.amountCents;
      raise(r, 'PART');
    }
  }
  for (const pay of input.payments) {
    const key = proofKeyOf(pay.proofKey);
    if (!key) continue;
    const r = row(key);
    if (r.amountCents == null) r.amountCents = pay.amountCents;
    raise(r, 'VERIFIED');
  }
  const current = proofKeyOf(input.currentProofUrl);
  if (current) {
    const r = row(current);
    if (input.verificationStatus === 'AWAITING_VERIFICATION') raise(r, 'AWAITING');
    else if (input.verificationStatus === 'VERIFIED') raise(r, 'VERIFIED');
  }
  // A buyer upload nobody decided on, while a newer one exists: it was replaced.
  for (const r of rows.values()) if (r.status === 'ON_FILE' && r.key !== current && r.by === 'BUYER' && r.at) r.status = 'REPLACED';
  return [...rows.values()].sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
}

// ── small admin input checks ────────────────────────────────────────────────

/**
 * Announcement / notification link: a page of this site ("/…", but never
 * "//host" or "/\host", which browsers open as another site) or an https://
 * address. Spaces and control characters are refused too: browsers drop tabs
 * and line breaks, so "/<tab>/evil.com" would become "//evil.com".
 */
export function announcementLinkProblem(href: string): string | null {
  const bad = 'The link must be a page on this site (one “/” followed by the path, e.g. /marketplace) or an https:// address.';
  if (/[\s\\\x00-\x1f\x7f]/.test(href)) return bad;
  if (/^\/(?![/\\])/.test(href)) return null;
  if (/^https:\/\/[^/?#]/i.test(href)) {
    try {
      return new URL(href).protocol === 'https:' ? null : bad;
    } catch {
      return bad;
    }
  }
  return bad;
}

/** Text cut on a word boundary with “…” (never mid-word). */
export function briefText(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max + 1);
  const at = head.lastIndexOf(' ');
  const cut = at >= Math.floor(max * 0.6) ? head.slice(0, at) : t.slice(0, max);
  return `${cut.replace(/[\s·,;:—–-]+$/, '')}…`;
}

// ── change-history values of the country and shipping tables ───────────────

export function countryPolicyValue(c: { name: string; mode: string; isEu: boolean; vatStandardRateBp: number | null; note?: string | null } | null): string | null {
  if (!c) return null;
  const vat = c.vatStandardRateBp != null ? `VAT ${(c.vatStandardRateBp / 100).toString()}%` : 'no VAT rate';
  return `${c.name}: ${c.mode.toLowerCase()} · ${c.isEu ? 'EU member' : 'not EU'} · ${vat}${c.note ? ` · ${c.note}` : ''}`;
}

export function shippingZoneValue(z: { name: string; countries: string[]; active: boolean; sortOrder: number } | null): string | null {
  if (!z) return null;
  return `${z.name}: ${z.countries.join(', ')}${z.active ? '' : ' (inactive)'} · order ${z.sortOrder}`;
}

export function shippingRateValue(
  r: { name: string; shippingClass: string; basis: string; amountCents: number; freeAboveCents: number | null; handlingCents: number; minKg: number | null; maxKg: number | null; active: boolean } | null,
): string | null {
  if (!r) return null;
  const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
  const kg = r.minKg != null || r.maxKg != null ? ` · ${r.minKg ?? 0}–${r.maxKg ?? '∞'} kg` : '';
  return `${r.name}: ${r.shippingClass.toLowerCase()} ${r.basis.toLowerCase().replace('_', ' ')} ${eur(r.amountCents)}${r.handlingCents ? ` + ${eur(r.handlingCents)} handling` : ''}${r.freeAboveCents != null ? ` · free above ${eur(r.freeAboveCents)}` : ''}${kg}${r.active ? '' : ' (inactive)'}`;
}
