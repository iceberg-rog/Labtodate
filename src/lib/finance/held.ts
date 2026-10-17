/**
 * Money held for the buyer (no I/O, safe to import anywhere): what was
 * received minus every refund that is approved or already sent. The refund
 * ledger (lib/finance/refunds.ts) counts only SENT money as “refunded”
 * (Order.amountRefundedCents); a REQUESTED refund is money owed back, so it is
 * no longer “held” — cancel guards, open amounts, reminders and the account
 * erasure all use this one rule.
 */

/** Refunds that are owed or gone: they reduce what can still be refunded. */
export const LIVE_REFUND_STATUSES = ['REQUESTED', 'SENT', 'CONFIRMED'] as const;
/** Refunds whose money actually left: Order.amountRefundedCents and the money state. */
export const SENT_REFUND_STATUSES = ['SENT', 'CONFIRMED'] as const;

/** Prisma `select` for heldMoneyCents(): the order's live refunds. */
export const LIVE_REFUNDS_SELECT = { where: { status: { in: [...LIVE_REFUND_STATUSES] } }, select: { status: true, amountCents: true } };

export function heldMoneyCents(amountPaidCents: number, refunds: Array<{ status: string; amountCents: number }>): number {
  const committed = refunds.filter((r) => (LIVE_REFUND_STATUSES as readonly string[]).includes(r.status)).reduce((a, r) => a + r.amountCents, 0);
  return Math.max(0, amountPaidCents - committed);
}
