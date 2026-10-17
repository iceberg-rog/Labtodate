/**
 * ONE payment-due rule for every unpaid bank-transfer order (A25) — pure, so
 * the proforma, the payment page, the reminders and the auto-cancel sweep can
 * not disagree. Unit tests: payment-due.test.ts.
 *
 *  due date      = Order.dueAt (set when the proforma is issued: acceptance /
 *                  order date + payment term, restarted when a pre-payment
 *                  hold is released), printed on the proforma; legacy rows
 *                  without it fall back to the quote's old validUntilAt, then
 *                  to (payableSince ?? createdAt) + payment term — an order
 *                  that started on hold counts from when it became payable.
 *  reminders     = PAYMENT_REMINDER_DAYS_BEFORE days before the due date.
 *  overdue       = the day after the due date (one notice).
 *  auto-cancel   = only after due date + PAYMENT_GRACE_DAYS, and only when
 *                  AUTO_CANCEL_UNPAID is on; a receipt in review always wins.
 */

const DAY = 86_400_000;

export function endOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

export function addDaysEndOfDay(from: Date, days: number): Date {
  return endOfDayUtc(new Date(from.getTime() + days * DAY));
}

export function effectiveDueDate(
  o: { dueAt: Date | null; createdAt: Date; payableSince?: Date | null; legacyValidUntil?: Date | null },
  termDays: number,
): Date {
  return o.dueAt ?? o.legacyValidUntil ?? addDaysEndOfDay(o.payableSince ?? o.createdAt, termDays);
}

/** The moment after which an unpaid order is canceled (end of due day + grace days). */
export function cancelAfter(due: Date, graceDays: number): Date {
  return addDaysEndOfDay(due, Math.max(0, graceDays));
}

export type DuePhase =
  | 'OPEN'          // before the due date
  | 'OVERDUE'       // past the due date, inside the grace period (still payable)
  | 'CANCEL_DUE';   // past due + grace: the sweep cancels (when auto-cancel is on)

export function duePhase(now: Date, due: Date, graceDays: number): DuePhase {
  if (now.getTime() <= due.getTime()) return 'OPEN';
  return now.getTime() <= cancelAfter(due, graceDays).getTime() ? 'OVERDUE' : 'CANCEL_DUE';
}

/** Whole days left until the due date (0 on the due day itself). */
export function daysUntil(now: Date, due: Date): number {
  const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const b = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  return Math.round((b - a) / DAY);
}

/**
 * The reminder steps (days before due) that are due now and not yet sent.
 * When the sweep missed several (server down), only the most recent one is
 * mailed; the earlier ones are only recorded (`skip`) so they never fire late.
 */
export function remindersToSend(now: Date, due: Date, steps: number[], sent: number[]): { send: number | null; skip: number[] } {
  if (now.getTime() > due.getTime()) return { send: null, skip: [] };
  const left = daysUntil(now, due);
  const reached = steps.filter((k) => left <= k && !sent.includes(k)).sort((a, b) => a - b);
  if (!reached.length) return { send: null, skip: [] };
  return { send: reached[0], skip: reached.slice(1) };
}

/** "16 Oct 2026" (UTC) — the one date format for buyers (page, emails, PDF agree). */
export function fmtDueDate(d: Date | string): string {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
