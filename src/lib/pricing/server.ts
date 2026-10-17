import type { Prisma } from '@prisma/client';
import { ensureSettingsLoaded, settingBool, settingEnum, settingPercentBp, settingString } from '@/lib/settings';
import { effectiveDisplayMode, type PriceDisplaySettings } from './display';
import { resolveSellPrice, type ResolvedPrice, type ShopPricingModeCode, type ProductModeCode } from './resolve';

/**
 * Server helpers around the ONE price resolver (lib/pricing/resolve.ts):
 * every server surface selects SELL_PRICE_SELECT and calls sellPriceOf(), so
 * the product page, cart, checkout, Stripe and the order snapshot charge the
 * same number. Public lists/filters read Product.displayPriceCents, which a
 * DB trigger keeps equal to resolveSellPrice(...).sellPriceCents (migration 7a).
 */

export const SELL_PRICE_SELECT = {
  priceCents: true,
  currency: true,
  mode: true,
  status: true,
  quantity: true,
  priceOnHold: true,
  company: { select: { pricingMode: true, pricingMarkupBp: true } },
} satisfies Prisma.ProductSelect;

export type SellPriceInput = {
  priceCents: number | null;
  currency: string;
  mode: string;
  status?: string | null;
  quantity?: number | null;
  /** Required on purpose: every caller must select it (SELL_PRICE_SELECT does). */
  priceOnHold: boolean;
  company?: { pricingMode: string; pricingMarkupBp: number } | null;
};

export function sellPriceOf(p: SellPriceInput): ResolvedPrice {
  return resolveSellPrice(
    { priceCents: p.priceCents, currency: p.currency, mode: p.mode as ProductModeCode, status: p.status, quantity: p.quantity, priceOnHold: p.priceOnHold },
    p.company ? { pricingMode: p.company.pricingMode as ShopPricingModeCode, pricingMarkupBp: p.company.pricingMarkupBp } : null,
  );
}

/** Price display settings (Settings → Tax & VAT / Sales channel). */
export async function loadPriceDisplay(): Promise<PriceDisplaySettings> {
  await ensureSettingsLoaded();
  return {
    mode: effectiveDisplayMode(settingEnum('PRICE_DISPLAY_MODE'), settingEnum('SALES_MODE')),
    standardRateBp: settingPercentBp('TAX_STANDARD_RATE_PCT'),
    labelExcl: settingString('PRICE_LABEL_EXCL_VAT') || 'excl. VAT',
    labelIncl: settingString('PRICE_LABEL_INCL_VAT') || 'incl. VAT',
    labelMargin: settingString('PRICE_LABEL_MARGIN') || 'margin scheme, no VAT shown',
    note: settingString('PRICE_VAT_NOTE'),
    marginSchemeEnabled: settingBool('TAX_MARGIN_SCHEME_ENABLED'),
  };
}
