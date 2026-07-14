/**
 * Effective orphan-sweep TTL (minutes). Fail-safe:
 *  - a hard FLOOR of 25h (> Stripe's 24h checkout-session max) always wins, so the
 *    sweep can never cancel/restock an order whose (possibly unpersisted) Stripe
 *    session could still be payable;
 *  - a missing / non-numeric / non-finite / non-positive config falls back to the
 *    7d default — never NaN (which would make an invalid Date).
 */
export const ORPHAN_TTL_FLOOR_MIN = 25 * 60;
export const ORPHAN_TTL_DEFAULT_MIN = 10080; // 7d

export function orphanSweepTtlMinutes(raw: string | undefined): number {
  const n = Number(raw);
  const configured = Number.isFinite(n) && n > 0 ? n : ORPHAN_TTL_DEFAULT_MIN;
  return Math.max(ORPHAN_TTL_FLOOR_MIN, configured);
}
