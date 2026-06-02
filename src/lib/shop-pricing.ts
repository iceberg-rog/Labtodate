import type { ProductMode } from '@prisma/client';

export type ShopPricingMode = 'PASS_THROUGH' | 'MARKUP_PERCENT' | 'FORCE_QUOTE' | 'HIDE_PRICE';

export interface ShopPricingInput {
  pricingMode: ShopPricingMode | null | undefined;
  pricingMarkupBp: number | null | undefined;
}

export interface DisplayPrice {
  priceCents: number | null;
  currency: string;
  mode: ProductMode;
  priceHidden: boolean;
  appliedMarkupBp: number;
}

/**
 * Apply a Company's pricing rule to a raw product price. Pure function — call
 * at the moment a product is rendered to a buyer / card / cart.
 *
 * If `company` is null/undefined (admin own inventory, no shop) the input is
 * returned unchanged.
 */
export function applyShopPricing(
  base: { priceCents: number | null; currency: string; mode: ProductMode },
  company: ShopPricingInput | null | undefined,
): DisplayPrice {
  const out: DisplayPrice = {
    priceCents: base.priceCents,
    currency: base.currency,
    mode: base.mode,
    priceHidden: false,
    appliedMarkupBp: 0,
  };
  if (!company || !company.pricingMode || company.pricingMode === 'PASS_THROUGH') return out;

  if (company.pricingMode === 'FORCE_QUOTE') {
    out.mode = 'QUOTE_ONLY';
    out.priceCents = null;
    out.priceHidden = true;
    return out;
  }
  if (company.pricingMode === 'HIDE_PRICE') {
    out.priceHidden = true;
    out.priceCents = null;
    return out;
  }
  if (company.pricingMode === 'MARKUP_PERCENT' && out.priceCents !== null) {
    const bp = company.pricingMarkupBp ?? 0;
    if (bp !== 0) {
      out.priceCents = Math.max(0, Math.round(out.priceCents * (1 + bp / 10000)));
      out.appliedMarkupBp = bp;
    }
  }
  return out;
}

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
  PASS_THROUGH: 'Pass-through (show imported price)',
  MARKUP_PERCENT: 'Markup % (adjust imported price)',
  FORCE_QUOTE: 'Force quote-only (hide all prices)',
  HIDE_PRICE: 'Hide price (Buy-Now still allowed)',
};
