import type { ProductMode } from '@prisma/client';
import { resolveSellPrice, type ShopPricingModeCode, type ProductModeCode } from '@/lib/pricing/resolve';

/**
 * The buyer-facing price of a listing after the shop's pricing rule
 * (markup / force-quote / hidden price) — the one number the product page,
 * the structured data and checkout agree on. A thin adapter over THE price
 * resolver (lib/pricing/resolve.ts); callers keep this signature.
 */
export interface OfferPrice {
  /** Price shown to (and charged to) the buyer, or null when there is no public price. */
  priceCents: number | null;
  currency: string;
  mode: ProductMode;
  priceHidden: boolean;
  /** A buyer can order it online at that price (not quote-only, price shown, > 0). */
  purchasable: boolean;
  appliedMarkupBp: number;
}

export function resolveOfferPrice(
  product: { priceCents: number | null; currency: string; mode: ProductMode; priceOnHold?: boolean | null },
  company: { pricingMode: string | null | undefined; pricingMarkupBp: number | null | undefined } | null | undefined,
): OfferPrice {
  const r = resolveSellPrice(
    { priceCents: product.priceCents, currency: product.currency, mode: product.mode as ProductModeCode, priceOnHold: product.priceOnHold },
    company ? { pricingMode: (company.pricingMode ?? 'PASS_THROUGH') as ShopPricingModeCode, pricingMarkupBp: company.pricingMarkupBp } : null,
  );
  return {
    priceCents: r.sellPriceCents,
    currency: r.currency,
    mode: r.mode as ProductMode,
    priceHidden: !r.priceVisible,
    purchasable: r.mode !== 'QUOTE_ONLY' && r.sellPriceCents != null && r.sellPriceCents > 0,
    appliedMarkupBp: r.appliedMarkupBp,
  };
}
