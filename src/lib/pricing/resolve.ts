/**
 * THE price resolver (A07 / A08 / B05 groundwork) — one pure function that
 * says, for a product as sold through its shop, what the buyer sees and pays:
 *
 *   basePriceCents  supplier / catalogue price (Product.priceCents)
 *   sellPriceCents  what is shown AND charged (shop markup + rounding applied),
 *                   null when the price is hidden or the item is quote-only
 *   buyable         may go into the cart / Buy Now
 *   quotable        may be requested as a quote
 *
 * Every surface (product page, cards, search, cart, checkout, Stripe lines,
 * the OrderItem snapshot, quote prefill) must use this — never priceCents
 * directly — so the page price, the cart, the order and the invoice agree.
 * Unit tests: src/lib/pricing/resolve.test.ts.
 */

export type ShopPricingModeCode = 'PASS_THROUGH' | 'MARKUP_PERCENT' | 'FORCE_QUOTE' | 'HIDE_PRICE';
export type ProductModeCode = 'BUY_NOW' | 'QUOTE_ONLY' | 'HYBRID';
export type PriceRounding = 'NONE' | 'WHOLE_EURO' | 'TEN_EURO' | 'CHARM_99';

export interface PriceProductInput {
  priceCents: number | null;
  currency: string;
  mode: ProductModeCode;
  status?: string | null;
  quantity?: number | null;
  /** 8f: a large supplier price change waits for admin review (not buyable, no public price). */
  priceOnHold?: boolean | null;
}

export interface PriceShopInput {
  pricingMode: ShopPricingModeCode | null | undefined;
  pricingMarkupBp: number | null | undefined;
}

export interface ResolvedPrice {
  basePriceCents: number | null;
  sellPriceCents: number | null;
  currency: string;
  appliedMarkupBp: number;
  /** Effective mode after the shop rule (FORCE_QUOTE / HIDE_PRICE → QUOTE_ONLY). */
  mode: ProductModeCode;
  priceVisible: boolean;
  buyable: boolean;
  quotable: boolean;
  soldOut: boolean;
  /** Why the item cannot be bought right now (empty when buyable). */
  reasons: string[];
}

/** Apply a rounding rule to a price in cents (never below 0). */
export function roundPrice(cents: number, rule: PriceRounding = 'NONE'): number {
  const c = Math.max(0, Math.round(cents));
  switch (rule) {
    case 'WHOLE_EURO': return Math.round(c / 100) * 100;
    case 'TEN_EURO': return Math.max(1000, Math.round(c / 1000) * 1000);
    case 'CHARM_99': return Math.max(99, Math.round(c / 100) * 100 - 1); // nearest x.99
    default: return c;
  }
}

export function resolveSellPrice(
  product: PriceProductInput,
  shop: PriceShopInput | null | undefined,
  opts: { rounding?: PriceRounding } = {},
): ResolvedPrice {
  const reasons: string[] = [];
  const base = product.priceCents != null && product.priceCents > 0 ? product.priceCents : null;
  let mode: ProductModeCode = product.mode;
  let priceVisible = base != null;
  let sell: number | null = base;
  let markup = 0;

  const rule = shop?.pricingMode ?? 'PASS_THROUGH';
  if (product.priceOnHold) {
    // The supplier changed the price beyond the review threshold: until an
    // admin approves a price, nothing is shown or charged (SQL twin: the
    // Product_display_price trigger of migration 8f).
    mode = 'QUOTE_ONLY';
    priceVisible = false;
    sell = null;
    reasons.push('The price is being confirmed — request a quote.');
  } else if (rule === 'FORCE_QUOTE') {
    mode = 'QUOTE_ONLY';
    priceVisible = false;
    sell = null;
    reasons.push('This shop sells on quotation only.');
  } else if (rule === 'HIDE_PRICE') {
    // A hidden price can never be charged blind: quote only (A07).
    mode = 'QUOTE_ONLY';
    priceVisible = false;
    sell = null;
    reasons.push('Price on request.');
  } else if (rule === 'MARKUP_PERCENT' && base != null) {
    const bp = Math.trunc(shop?.pricingMarkupBp ?? 0);
    if (bp !== 0) {
      // Integer arithmetic (base × (10000 + bp) is exact), rounded half up —
      // the SQL twin l2d_sell_price() (migration 7a) computes exactly this.
      sell = Math.max(0, Math.round((base * (10000 + bp)) / 10000));
      markup = bp;
    }
  }
  if (sell != null) sell = roundPrice(sell, opts.rounding ?? 'NONE');
  if (sell != null && sell <= 0) {
    sell = null;
    priceVisible = false;
    mode = 'QUOTE_ONLY';
    reasons.push('No valid price.');
  }
  if (base == null && mode !== 'QUOTE_ONLY') {
    mode = 'QUOTE_ONLY';
    reasons.push('No price set — available on quotation.');
  }
  if (product.mode === 'QUOTE_ONLY' && !reasons.length) reasons.push('Available on quotation.');

  const published = product.status == null || product.status === 'PUBLISHED';
  if (!published) reasons.push('Not available (not published).');
  const soldOut = product.quantity != null && product.quantity <= 0;
  if (soldOut) reasons.push('Sold out.');

  const buyable = published && !soldOut && mode !== 'QUOTE_ONLY' && sell != null;
  return {
    basePriceCents: base,
    sellPriceCents: priceVisible ? sell : null,
    currency: product.currency,
    appliedMarkupBp: markup,
    mode,
    priceVisible: priceVisible && sell != null,
    buyable,
    quotable: published,
    soldOut,
    reasons: buyable ? [] : reasons,
  };
}

/** Guard for cart / checkout server actions. */
export function assertBuyable(r: ResolvedPrice): { ok: true; priceCents: number } | { ok: false; message: string } {
  if (r.buyable && r.sellPriceCents != null) return { ok: true, priceCents: r.sellPriceCents };
  return { ok: false, message: r.reasons[0] ?? 'This item cannot be bought online — request a quote.' };
}
