/**
 * Per-shop pricing rule — labels and unit helpers for the admin forms. The
 * rule itself is applied by THE price resolver (lib/pricing/resolve.ts) on
 * every surface: product page, cards, search, cart, checkout, Stripe and the
 * order snapshot. HIDE_PRICE is quote-only (a hidden price is never charged).
 */
export type ShopPricingMode = 'PASS_THROUGH' | 'MARKUP_PERCENT' | 'FORCE_QUOTE' | 'HIDE_PRICE';

/** Convert UI percent (e.g. 5 or -2.5) to integer basis points for storage. */
export function pctToBp(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.round(percent * 100);
}

/** Convert basis points to UI percent. */
export function bpToPct(bp: number): number {
  return bp / 100;
}

export const PRICING_MODE_LABEL: Record<ShopPricingMode, string> = {
  PASS_THROUGH: 'Pass-through (show and charge the imported price)',
  MARKUP_PERCENT: 'Markup % (show and charge the imported price ± a percentage)',
  FORCE_QUOTE: 'Force quote-only (no prices, quotation for every item)',
  HIDE_PRICE: 'Hide price — quote only (price never shown or charged online)',
};
