/**
 * Parse one WooCommerce Store API product into the sync engine's SourceItem.
 * Pure (no DB / network) — unit-tested.
 */
import { cleanSupplierHtmlDetailed, stripHtml, wooPriceToCents, type SupplierRef } from '@/lib/marketplace/import-clean';
import { DEFAULT_CLEAN_RULES, type CleanRules } from '@/lib/catalog/import-rules';
import type { SourceItem } from '@/lib/marketplace/woo-sync-plan';

export interface WooStoreProduct {
  id: number;
  name: string;
  slug: string;
  type?: string;
  permalink?: string;
  sku?: string;
  short_description?: string;
  description?: string;
  prices?: { price?: string; currency_code?: string; currency_minor_unit?: number };
  images?: { src: string }[];
  categories?: { name: string }[];
  brands?: { name: string }[];
  attributes?: { name: string; terms?: { name: string }[] }[];
  is_in_stock?: boolean;
  is_on_backorder?: boolean;
  low_stock_remaining?: number | null;
  stock_availability?: { class?: string };
  add_to_cart?: { maximum?: number };
}

const MPN_ATTR = /^(mpn|part\s*(number|no\.?|#)|manufacturer\s*part\s*(number|no\.?)|onderdeelnummer|artikelnummer|p\/n)$/i;

export interface ParseOptions {
  /** Claim / price / cross-sell rules (Settings → Import & suppliers). */
  clean?: CleanRules;
  /** SYNC_BACKORDER_MODE = SELLABLE: a backorder can be bought (with a lead time). */
  backorderSellable?: boolean;
}

export function parseWooProduct(w: WooStoreProduct, supplier: SupplierRef, opts: ParseOptions = {}): SourceItem {
  const rules = opts.clean ?? DEFAULT_CLEAN_RULES;
  const name = stripHtml(w.name ?? '').slice(0, 200);
  const short = cleanSupplierHtmlDetailed(w.short_description, supplier, rules);
  const long = cleanSupplierHtmlDetailed(w.description, supplier, rules);
  const shortHtml = short.html;
  const longHtml = long.html;
  const variable = (w.type ?? 'simple') !== 'simple';
  const priceCents = variable ? null : wooPriceToCents(w.prices);
  const cls = (w.stock_availability?.class ?? '').toLowerCase();
  // A backorder means the supplier does not have the unit now: not available —
  // unless the owner sells backorders with a lead time (never "Sold").
  const backorder = !!w.is_on_backorder || cls === 'on-backorder';
  const inStock = w.is_in_stock !== false && cls !== 'out-of-stock' && (!backorder || !!opts.backorderSellable);
  // Store API: add_to_cart.maximum is the stock quantity when the shop manages
  // stock (capped at 9999 = "not managed"); low_stock_remaining when low.
  const max = w.add_to_cart?.maximum;
  const sourceQty =
    typeof w.low_stock_remaining === 'number'
      ? w.low_stock_remaining
      : typeof max === 'number' && max > 0 && max < 9999
        ? max
        : null;
  const mpnAttr = (w.attributes ?? []).find((a) => MPN_ATTR.test((a.name ?? '').trim()));
  return {
    externalId: String(w.id),
    sourceSlug: (w.slug || `${w.id}`).slice(0, 190),
    permalink: w.permalink || null,
    title: name || `Product ${w.id}`,
    placeholderTitle: !name,
    summary: stripHtml(shortHtml ?? '').slice(0, 280) || null,
    // Full technical text: the long description, else the short one.
    description: longHtml || shortHtml || null,
    priceCents,
    currency: w.prices?.currency_code || 'EUR',
    imageUrls: (w.images ?? []).map((i) => i.src).filter(Boolean),
    sku: (w.sku ?? '').trim() || null,
    mpn: mpnAttr?.terms?.[0]?.name?.trim() || null,
    inStock,
    sourceQty: inStock ? (backorder ? null : sourceQty) : 0,
    availability: backorder ? 'onbackorder' : inStock ? 'instock' : 'outofstock',
    removed: [...short.removed, ...long.removed].filter((r, i, all) => all.findIndex((x) => x.text === r.text) === i),
  };
}
