import { orderDetailsProblems, type VatIdRule } from '@/lib/orders/details';

/**
 * Pure rules of the fulfilment / cancellation / returns & refunds area (wave 2,
 * s2c). No DB, no settings, no I/O — the callers pass the configured values in.
 * Unit tests: rules.test.ts.
 */

// ── text templates ───────────────────────────────────────────────────────────

/** Replace {KEY} placeholders (unknown keys are left as they are). */
export function fillTemplate(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{([A-Z_]+)\}/g, (m, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? m : String(v);
  });
}

// ── carriers ─────────────────────────────────────────────────────────────────

export interface Carrier {
  name: string;
  /** Tracking link with {TRACKING}; null = the carrier has no public tracking. */
  urlTemplate: string | null;
}

/** "Name | https://…{TRACKING}" per line (the link is optional). */
export function parseCarriers(text: string): Carrier[] {
  const out: Carrier[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, ...rest] = line.split('|');
    const n = name.trim();
    const url = rest.join('|').trim();
    if (!n) continue;
    if (out.some((c) => c.name.toLowerCase() === n.toLowerCase())) continue;
    out.push({ name: n.slice(0, 60), urlTemplate: url || null });
  }
  return out;
}

export function carriersProblem(v: string): string | null {
  const lines = v.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return 'add at least one carrier (one per line).';
  for (const l of lines) {
    const [name, ...rest] = l.split('|');
    if (!name.trim()) return `“${l}”: the carrier name is missing.`;
    if (name.trim().length > 60) return `“${name.trim()}”: at most 60 characters.`;
    const url = rest.join('|').trim();
    if (!url) continue;
    if (!/^https:\/\//i.test(url)) return `“${name.trim()}”: the tracking link must start with https://`;
    if (!url.includes('{TRACKING}')) return `“${name.trim()}”: the tracking link must contain {TRACKING} (where the number goes).`;
    try {
      new URL(url.replace('{TRACKING}', 'X'));
    } catch {
      return `“${name.trim()}”: the tracking link is not a valid URL.`;
    }
  }
  return null;
}

export function findCarrier(list: Carrier[], name: string | null | undefined): Carrier | undefined {
  const n = (name ?? '').trim().toLowerCase();
  if (!n) return undefined;
  return list.find((c) => c.name.toLowerCase() === n);
}

/** Tracking link for a number, or null (no template / no number). */
export function buildTrackingUrl(c: Carrier | undefined, tracking: string | null | undefined): string | null {
  const t = (tracking ?? '').trim();
  if (!c?.urlTemplate || !t) return null;
  return c.urlTemplate.split('{TRACKING}').join(encodeURIComponent(t));
}

/** Does recording a shipment with this carrier need a tracking number? */
export function trackingRequired(c: Carrier | undefined, requireSetting: boolean): boolean {
  return requireSetting && !!c?.urlTemplate;
}

// ── return reasons ───────────────────────────────────────────────────────────

export const RETURN_TYPES = ['RETURN', 'TRANSPORT_DAMAGE', 'NOT_AS_DESCRIBED', 'WARRANTY'] as const;
export type ReturnTypeCode = (typeof RETURN_TYPES)[number];
export interface ReturnReason {
  type: ReturnTypeCode;
  label: string;
}

export function parseReturnReasons(text: string): ReturnReason[] {
  const out: ReturnReason[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [t, ...rest] = line.split('|');
    const type = t.trim().toUpperCase() as ReturnTypeCode;
    const label = rest.join('|').trim();
    if (!RETURN_TYPES.includes(type) || !label) continue;
    out.push({ type, label: label.slice(0, 80) });
  }
  return out;
}

export function returnReasonsProblem(v: string): string | null {
  const lines = v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'add at least one reason.';
  for (const l of lines) {
    const [t, ...rest] = l.split('|');
    if (!RETURN_TYPES.includes(t.trim().toUpperCase() as ReturnTypeCode)) {
      return `“${l}”: start the line with RETURN, TRANSPORT_DAMAGE, NOT_AS_DESCRIBED or WARRANTY, then “|” and the text.`;
    }
    const label = rest.join('|').trim();
    if (!label) return `“${l}”: the text after “|” is missing.`;
    if (label.length > 80) return `“${label}”: at most 80 characters.`;
  }
  return null;
}

export const RETURN_TYPE_LABEL: Record<string, string> = {
  RETURN: 'Return',
  TRANSPORT_DAMAGE: 'Transport damage',
  NOT_AS_DESCRIBED: 'Not as described',
  WARRANTY: 'Warranty claim',
  WITHDRAWAL: 'Withdrawal',
  CANCELLATION: 'Cancellation',
};

// ── ship readiness (owner report 5) ──────────────────────────────────────────

/** Holds that stop a dispatch (paid or not): export screening, a changed
 *  destination under review, money under review (Stripe mismatch / dispute),
 *  fraud, a supplier that has not confirmed, freight not set, a paid unit
 *  that is no longer in stock. */
export const DISPATCH_BLOCKING_HOLDS = ['COMPLIANCE', 'ADDRESS_REVIEW', 'PAYMENT_REVIEW', 'FRAUD', 'SUPPLIER_CONFIRMATION', 'SHIPPING_PENDING', 'STOCK_SHORTAGE'] as const;

const HOLD_TEXT: Record<string, string> = {
  COMPLIANCE: 'the export-compliance review is not cleared',
  ADDRESS_REVIEW: 'the changed delivery address is under review',
  PAYMENT_REVIEW: 'the payment is under review (amount mismatch or card dispute)',
  FRAUD: 'the order is on a fraud hold',
  SUPPLIER_CONFIRMATION: 'the supplier has not confirmed the item',
  SHIPPING_PENDING: 'the shipping cost is not confirmed',
  STOCK_SHORTAGE: 'the unit is no longer in stock — decide refund, backorder or another unit',
};

export interface ReadinessInput {
  status: string;
  billingAddress: unknown;
  shippingAddress: unknown;
  customerType?: string | null;
  openHolds: string[];
  holdReason: string | null;
  /** Country policy of the delivery country (null = unknown / no country). */
  shipCountryMode?: 'ALLOW' | 'REVIEW' | 'BLOCK' | null;
  shipCountry?: string | null;
}

/**
 * Why this order can NOT be marked “processing” (ready to ship) or shipped.
 * Empty = it can. Every write path that moves an order towards the carrier
 * (single, bulk, row, quick view, shipment form) calls this on the server.
 */
export function shipBlockers(o: ReadinessInput, opts: { vatIdRule?: VatIdRule } = {}): string[] {
  const out: string[] = [];
  if (!['PAID', 'PROCESSING', 'SHIPPED'].includes(o.status)) {
    out.push(o.status === 'PENDING_PAYMENT'
      ? 'the order is not paid (or approved on invoice terms) yet'
      : `the order is ${o.status.toLowerCase().replace(/_/g, ' ')}`);
  }
  const missing = orderDetailsProblems(o, opts);
  if (missing.length) out.push(`billing / delivery details are incomplete (missing: ${missing.join(', ')})`);
  if (o.shipCountryMode === 'BLOCK') out.push(`we do not ship to ${o.shipCountry ?? 'the delivery country'} (Settings → Compliance & countries)`);
  const holds = Array.from(new Set([...o.openHolds, ...(o.holdReason ? [o.holdReason] : [])]));
  for (const h of holds) if ((DISPATCH_BLOCKING_HOLDS as readonly string[]).includes(h)) out.push(HOLD_TEXT[h]);
  return out;
}

// ── partial shipments ────────────────────────────────────────────────────────

export interface LineQty { id: string; quantity: number }
export interface ShippedQty { orderItemId: string; qty: number }

/** Units of each order line not shipped yet (never negative). */
export function remainingToShip(items: LineQty[], shipped: ShippedQty[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const done = shipped.filter((s) => s.orderItemId === it.id).reduce((a, s) => a + s.qty, 0);
    out[it.id] = Math.max(0, it.quantity - done);
  }
  return out;
}

export type ShipProgress = 'NONE' | 'PARTIAL' | 'ALL';
export function shipProgress(items: LineQty[], shipped: ShippedQty[]): ShipProgress {
  const rem = remainingToShip(items, shipped);
  const total = items.reduce((a, i) => a + i.quantity, 0);
  const left = Object.values(rem).reduce((a, n) => a + n, 0);
  if (total === 0 || left === total) return 'NONE';
  return left === 0 ? 'ALL' : 'PARTIAL';
}

/** Validate the lines of a new shipment against what is still to ship. */
export function shipmentLinesProblem(lines: ShippedQty[], remaining: Record<string, number>): string | null {
  const real = lines.filter((l) => l.qty > 0);
  if (!real.length) return 'choose at least one item (quantity above 0) for this shipment.';
  for (const l of real) {
    if (!Number.isInteger(l.qty)) return 'quantities must be whole numbers.';
    if (!(l.orderItemId in remaining)) return 'an item does not belong to this order.';
    if (l.qty > remaining[l.orderItemId]) return `only ${remaining[l.orderItemId]} unit(s) of an item are left to ship.`;
  }
  return null;
}

// ── money: refunds and credit notes ─────────────────────────────────────────

export interface MoneyState {
  totalCents: number;
  /** Money actually received (ledger), for legacy paid orders the total. */
  paidCents: number;
  /** Sum of issued credit notes (positive). */
  creditedCents: number;
  /** Sum of money refunds recorded (REQUESTED + SENT + CONFIRMED). */
  refundedCents: number;
  /** An invoice exists (credit notes need one). */
  invoiced: boolean;
}

export interface RefundCapacity {
  /** Gross amount that can still be credited / refunded in total. */
  maxCents: number;
  /** Part of that which is still an unpaid receivable (cancels the amount due). */
  receivableCents: number;
  /** Money we hold that can still be returned. */
  moneyCents: number;
}

/**
 * How much can still be credited, and how much of it is money vs. an unpaid
 * receivable. Prior credit notes that did not refund money reduced the
 * receivable. Without an invoice, only received money can be refunded.
 */
export function refundCapacity(m: MoneyState): RefundCapacity {
  const money = Math.max(0, m.paidCents - m.refundedCents);
  if (!m.invoiced) return { maxCents: money, receivableCents: 0, moneyCents: money };
  const creditLeft = Math.max(0, m.totalCents - m.creditedCents);
  const receivable = Math.max(0, m.totalCents - m.paidCents - Math.max(0, m.creditedCents - m.refundedCents));
  return { maxCents: Math.min(creditLeft, receivable + money), receivableCents: Math.min(receivable, creditLeft), moneyCents: Math.min(money, creditLeft) };
}

/**
 * Split a credit of `amountCents` into the part that cancels the unpaid
 * receivable (no money moves) and the part refunded as money. The receivable
 * goes first: a buyer who still owes money is not paid out while owing.
 */
export function settleCredit(m: MoneyState, amountCents: number): { receivableCents: number; refundCents: number } | { error: string } {
  const cap = refundCapacity(m);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { error: 'enter an amount above 0.' };
  if (amountCents > cap.maxCents) return { error: `at most ${(cap.maxCents / 100).toFixed(2)} can still be credited / refunded on this order.` };
  const receivableCents = Math.min(amountCents, cap.receivableCents);
  return { receivableCents, refundCents: amountCents - receivableCents };
}

/**
 * Money state of the order after a refund status change (only money actually
 * SENT counts). Everything received sent back → REFUNDED. Sending back only an
 * overpayment (more received than the invoice total) leaves the sale paid in
 * full → PAID, not “partly refunded”; PARTIALLY_REFUNDED means part of the sale
 * itself went back. Nothing received and the invoice credited in full → VOID.
 */
export function financialAfterRefunds(p: { paidCents: number; sentCents: number; totalCreditedCents: number; totalCents: number; current: string }): string {
  if (p.sentCents > 0 && p.sentCents >= p.paidCents && p.paidCents > 0) return 'REFUNDED';
  if (p.sentCents > 0) {
    const excessCents = Math.max(0, p.paidCents - p.totalCents);
    return p.sentCents <= excessCents ? 'PAID' : 'PARTIALLY_REFUNDED';
  }
  if (p.paidCents === 0 && p.totalCreditedCents >= p.totalCents && p.totalCents > 0) return 'VOID';
  return p.current;
}

// ── returns ──────────────────────────────────────────────────────────────────

export interface ReturnEligibilityInput {
  status: string;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  /** Warranty months per line as sold (OrderItem.warrantyMonthsSnapshot). */
  warrantyMonths: Array<number | null>;
  /** An RMA of this order is still open (not resolved / rejected / canceled). */
  openReturn: boolean;
}

export interface ReturnEligibility {
  canRequest: boolean;
  /** After the window, only WARRANTY reasons. */
  onlyWarranty: boolean;
  windowEndsAt: Date | null;
  warrantyEndsAt: Date | null;
  /** Why not (shown to the buyer), when canRequest is false. */
  reason: string | null;
}

const DAY = 86_400_000;
function addMonths(d: Date, m: number): Date {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x;
}

export function returnEligibility(
  o: ReturnEligibilityInput,
  cfg: { enabled: boolean; windowDays: number; warrantyAfterWindow: boolean },
  now: Date = new Date(),
): ReturnEligibility {
  const base = o.deliveredAt ?? o.shippedAt;
  const windowEndsAt = base ? new Date(base.getTime() + cfg.windowDays * DAY) : null;
  const months = Math.max(0, ...o.warrantyMonths.map((m) => m ?? 0));
  const warrantyEndsAt = base && months > 0 ? addMonths(base, months) : null;
  const no = (reason: string): ReturnEligibility => ({ canRequest: false, onlyWarranty: false, windowEndsAt, warrantyEndsAt, reason });
  if (!cfg.enabled) return no('Online return requests are switched off — please contact support.');
  // PROCESSING with a shipment date = partly shipped: the shipped items can already be reported.
  if (!['PROCESSING', 'SHIPPED', 'DELIVERED'].includes(o.status) || !base) return no('A problem can be reported once the order has shipped.');
  if (o.openReturn) return no('You already have an open request for this order — follow it below.');
  if (windowEndsAt && now <= windowEndsAt) return { canRequest: true, onlyWarranty: false, windowEndsAt, warrantyEndsAt, reason: null };
  if (cfg.warrantyAfterWindow && warrantyEndsAt && now <= warrantyEndsAt) {
    return { canRequest: true, onlyWarranty: true, windowEndsAt, warrantyEndsAt, reason: null };
  }
  return no(`The return window ended on ${windowEndsAt ? fmtDay(windowEndsAt) : '—'}${warrantyEndsAt ? ' and the warranty has ended' : ''} — please contact support if something is wrong.`);
}

export const OPEN_RETURN_STATUSES = ['REQUESTED', 'APPROVED', 'LABEL_SENT', 'IN_TRANSIT', 'RECEIVED', 'INSPECTED'] as const;

/** Where a return can be resolved from: inspected goods, or an approval when nothing comes back. */
export function resolvableReturnStatuses(noReturnNeeded: boolean): Array<'APPROVED' | 'LABEL_SENT' | 'INSPECTED'> {
  return noReturnNeeded ? ['APPROVED', 'LABEL_SENT', 'INSPECTED'] : ['INSPECTED'];
}

/** Staff-typed text that a template follows with its own full stop (“… it: {REASON}.”). */
export function withoutFinalStop(text: string): string {
  return text.trim().replace(/[\s.]+$/, '');
}

export const RETURN_STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Waiting for our review',
  APPROVED: 'Approved',
  DENIED: 'Not approved',
  LABEL_SENT: 'Approved — instructions sent',
  IN_TRANSIT: 'On its way back',
  RECEIVED: 'Received — being inspected',
  INSPECTED: 'Inspected',
  RESOLVED: 'Resolved',
  CANCELED: 'Withdrawn',
};

// ── refunds: honest wording ──────────────────────────────────────────────────

export const REFUND_STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Refund requested — transfer not yet sent',
  SENT: 'Refund sent',
  CONFIRMED: 'Refund completed',
  FAILED: 'Refund failed — being redone',
  CANCELED: 'Refund canceled',
};

// ── next steps (no dead ends) ────────────────────────────────────────────────

export type Who = 'buyer' | 'staff' | 'carrier' | 'none';
export interface NextStep {
  who: Who;
  text: string;
}

export interface NextStepInput {
  status: string;
  financialStatus: string;
  onTermsUnpaid: boolean;
  /** Pre-payment hold (shipping / VAT / compliance / address) open. */
  prePaymentHold: boolean;
  paymentVerificationStatus: string | null;
  paymentSubmitted: boolean;
  detailsMissing: string[];
  shipBlockers: string[];
  progress: ShipProgress;
  deliveredAt: Date | null;
  refunds: Array<{ status: string; amountLabel: string }>;
  returns: Array<{ status: string; rmaNumber: string; noReturnNeeded: boolean }>;
  returnWindowEndsAt: Date | null;
  returnsOpen: boolean;
  buyerCanCancel: boolean;
  invoiceIssued: boolean;
  /** The invoice on NET terms (when onTermsUnpaid): its number, due date and the amount still open. */
  invoiceNumber?: string | null;
  invoiceDueAt?: Date | null;
  amountDueLabel?: string | null;
  now?: Date;
}

const fmtDay = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** An invoice on NET terms that is still open: the buyer pays it (by its due date), staff chase it once overdue. */
function payInvoiceStep(i: NextStepInput, B: boolean): NextStep {
  const inv = i.invoiceNumber ? `invoice ${i.invoiceNumber}` : 'the invoice';
  const amount = i.amountDueLabel ? ` (${i.amountDueLabel})` : '';
  const due = i.invoiceDueAt ?? null;
  const overdue = i.financialStatus === 'OVERDUE' || (!!due && due.getTime() < (i.now ?? new Date()).getTime());
  if (B) {
    return { who: 'buyer', text: overdue ? `Pay ${inv}${amount} now — it was due ${due ? `on ${fmtDay(due)}` : 'already'}.` : `Pay ${inv}${amount} by ${due ? fmtDay(due) : 'the due date on the invoice'}.` };
  }
  const Inv = inv.charAt(0).toUpperCase() + inv.slice(1);
  return overdue
    ? { who: 'staff', text: `${Inv}${amount} on NET terms is overdue${due ? ` (due ${fmtDay(due)})` : ''} — chase the payment, or record it when it arrives.` }
    : { who: 'buyer', text: `${Inv}${amount} on NET terms is still unpaid — the buyer pays by ${due ? fmtDay(due) : 'the due date'}.` };
}

/**
 * What happens next on an order, and who does it — the same facts for both
 * sides, worded per audience. Never empty: a closed order says it is closed.
 */
export function orderNextSteps(i: NextStepInput, audience: 'buyer' | 'staff'): NextStep[] {
  const B = audience === 'buyer';
  const steps: NextStep[] = [];
  const pendingRefunds = i.refunds.filter((r) => r.status === 'REQUESTED');
  const sentRefunds = i.refunds.filter((r) => r.status === 'SENT');
  for (const r of pendingRefunds) {
    steps.push({ who: 'staff', text: B ? `We send your refund of ${r.amountLabel} by bank transfer — not sent yet; you get an email with the date and reference.` : `Send the refund of ${r.amountLabel} and record it (“Mark refund sent” with date and bank reference).` });
  }
  for (const r of sentRefunds) {
    steps.push({ who: B ? 'none' : 'staff', text: B ? `Your refund of ${r.amountLabel} was sent — it arrives in 1–3 business days.` : `Refund of ${r.amountLabel} sent — confirm it once the bank statement (or Stripe) shows it went out.` });
  }
  for (const r of i.returns) {
    const s = r.status;
    if (s === 'REQUESTED') steps.push({ who: 'staff', text: B ? `We review your request ${r.rmaNumber} and reply by email.` : `Review return ${r.rmaNumber}: approve (with instructions) or reject with a reason.` });
    else if ((s === 'APPROVED' || s === 'LABEL_SENT') && !r.noReturnNeeded) steps.push({ who: 'buyer', text: B ? `Send the item back as described in the instructions for ${r.rmaNumber}, then add the carrier and tracking number below.` : `Wait for the buyer to send ${r.rmaNumber} back, then record the receipt.` });
    else if ((s === 'APPROVED' || s === 'LABEL_SENT') && r.noReturnNeeded) steps.push({ who: 'staff', text: B ? `Nothing to send back for ${r.rmaNumber} — we settle it and email you.` : `Settle ${r.rmaNumber} (no goods come back): record the outcome.` });
    else if (s === 'IN_TRANSIT') steps.push({ who: 'staff', text: B ? `${r.rmaNumber} is on its way back to us — we email you when it arrives.` : `${r.rmaNumber} is on its way back — record the receipt when it arrives.` });
    else if (s === 'RECEIVED') steps.push({ who: 'staff', text: B ? `We received the goods for ${r.rmaNumber} and inspect them.` : `Inspect ${r.rmaNumber} (grade + restock decision).` });
    else if (s === 'INSPECTED') steps.push({ who: 'staff', text: B ? `Inspection of ${r.rmaNumber} is done — we settle it and email you.` : `Resolve ${r.rmaNumber}: refund / credit, repair, replacement or no action.` });
  }

  switch (i.status) {
    case 'PENDING_PAYMENT':
      if (i.prePaymentHold) steps.push({ who: 'staff', text: B ? 'We confirm the final total (shipping / VAT / export check) and email you — nothing is due yet.' : 'Resolve the open hold (Pricing, VAT & holds) — the buyer can not pay before that.' });
      else if (i.paymentSubmitted) steps.push({ who: 'staff', text: B ? 'We check your payment proof and email you when it is verified.' : 'Verify or reject the buyer’s payment proof.' });
      else if (i.detailsMissing.length) steps.push({ who: 'buyer', text: B ? `Add your billing and delivery details (${i.detailsMissing.join(', ')}), then pay.` : `The buyer must add billing / delivery details (${i.detailsMissing.join(', ')}) — or add them yourself — before payment.` });
      else steps.push({ who: 'buyer', text: B ? 'Pay by bank transfer (details on the payment page) and upload the receipt.' : 'Waiting for the buyer’s payment.' });
      steps.push({ who: B ? 'buyer' : 'staff', text: B ? (i.buyerCanCancel ? 'Changed your mind? You can cancel this order below — nothing is charged.' : 'To cancel, contact support.') : 'Cancel the order (with a reason) if it will not go ahead — the proforma is voided and the unit released.' });
      break;
    case 'PAID':
    case 'PROCESSING':
      if (i.progress === 'PARTIAL') steps.push({ who: 'staff', text: B ? 'Part of your order has shipped; we ship the rest and email you the tracking.' : 'Ship the remaining items (Shipments → Record a shipment).' });
      else if (i.shipBlockers.length) steps.push({ who: B && i.detailsMissing.length ? 'buyer' : 'staff', text: B ? (i.detailsMissing.length ? `Add your delivery details (${i.detailsMissing.join(', ')}) so we can ship.` : 'We prepare your order for dispatch.') : `Before shipping: ${i.shipBlockers.join('; ')}.` });
      else steps.push({ who: 'staff', text: B ? 'We prepare your order and email you the carrier and tracking number when it ships.' : i.status === 'PAID' ? 'Mark it “processing” while you prepare it, then record the shipment (carrier + tracking).' : 'Record the shipment (carrier + tracking) — the buyer is emailed.' });
      if (!B && i.progress === 'NONE') steps.push({ who: 'staff', text: i.onTermsUnpaid ? 'Not going ahead? Cancel it: the invoice is credited — the unpaid amount is no longer due (no money refunded for it); a part that was paid is refunded.' : 'Not going ahead? Cancel it before shipping: a credit note is issued and the refund is recorded.' });
      if (B && i.progress === 'NONE') steps.push({ who: 'buyer', text: 'Need to cancel? Contact us before it ships — after payment we cancel and refund it for you.' });
      if (i.onTermsUnpaid) steps.push(payInvoiceStep(i, B));
      break;
    case 'SHIPPED':
      steps.push({ who: 'carrier', text: B ? 'Your order is on its way. When it arrives, confirm receipt below.' : 'In transit. Record the delivery (or the buyer confirms receipt).' });
      if (B && i.returnsOpen) steps.push({ who: 'buyer', text: 'Something wrong on arrival? Report it below with photos.' });
      if (i.onTermsUnpaid) steps.push(payInvoiceStep(i, B));
      break;
    case 'DELIVERED':
      if (i.returnsOpen && i.returnWindowEndsAt) steps.push({ who: 'buyer', text: B ? `Something wrong? Report a problem or request a return until ${fmtDay(i.returnWindowEndsAt)}.` : `The buyer can report a problem until ${fmtDay(i.returnWindowEndsAt)}.` });
      // An unpaid invoice on NET terms is the buyer's open step — never “nothing more to do”.
      if (i.onTermsUnpaid) steps.push(payInvoiceStep(i, B));
      if (!steps.length) steps.push({ who: 'none', text: B ? 'Delivered — nothing more to do.' : 'Delivered — order complete.' });
      break;
    case 'CANCELED':
      if (!pendingRefunds.length && !sentRefunds.length) steps.push({ who: 'none', text: B ? 'This order is canceled — nothing is due.' : 'Canceled — nothing left to do.' });
      break;
    case 'REFUNDED':
      if (!pendingRefunds.length && !sentRefunds.length) steps.push({ who: 'none', text: B ? 'Refunded — nothing more to do.' : 'Refunded — order closed.' });
      break;
  }
  if (!B && ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(i.status) && !i.invoiceIssued && !i.onTermsUnpaid) {
    steps.push({ who: 'staff', text: 'The invoice is not issued yet — see Documents (issue / retry).' });
  }
  return steps.length ? steps : [{ who: 'none', text: B ? 'Nothing to do right now.' : 'Nothing to do right now.' }];
}
