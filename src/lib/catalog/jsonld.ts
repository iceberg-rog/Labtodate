/**
 * schema.org Product structured data that says only what is true:
 *  - availability from real stock (InStock / SoldOut / OutOfStock at the
 *    supplier / Discontinued when removed at the source), never a constant;
 *  - itemCondition from the admin-managed condition grade;
 *  - sku / mpn only when the listing has real ones (never the URL slug);
 *  - no placeholder brand ("Other", "Generic");
 *  - only our own photos, all of them, as absolute URLs (no stock photos);
 *  - price = the buyer-facing price after the shop's pricing rule
 *    (resolveOfferPrice), and no Offer at all for quote-only / hidden prices;
 *  - seller = the legal entity from Settings → Company;
 *  - a return policy only when the owner configured one.
 * Pure — unit-tested in jsonld.test.ts.
 */
import type { OfferPrice } from '@/lib/catalog/offer-price';
import { hasPriceText } from '@/lib/catalog/import-rules';

/** Default of Settings → Import & suppliers → “Brand names that are placeholders”. */
export const DEFAULT_PLACEHOLDER_BRANDS = ['other', 'others', 'generic', 'unknown', 'misc', 'various', 'n/a', 'na'];

/** "Other" / "Generic" are importer placeholders, not brands (list: PLACEHOLDER_BRAND_NAMES). */
export function isPlaceholderBrand(
  brand: { name?: string | null; slug?: string | null } | null | undefined,
  placeholders: readonly string[] = DEFAULT_PLACEHOLDER_BRANDS,
): boolean {
  if (!brand) return true;
  const n = (brand.name ?? '').trim().toLowerCase();
  const s = (brand.slug ?? '').trim().toLowerCase();
  const list = new Set([...placeholders.map((x) => x.toLowerCase()), '-', '—']);
  return (!n && !s) || list.has(n) || list.has(s);
}

export type SchemaAvailability = 'InStock' | 'BackOrder' | 'SoldOut' | 'OutOfStock' | 'Discontinued';

export function schemaAvailability(p: {
  quantity: number;
  sourceAvailability?: string | null;
  removedAtSourceAt?: Date | string | null;
}): SchemaAvailability {
  // A unit sellable while on backorder at the supplier (SYNC_BACKORDER_MODE = SELLABLE).
  if (p.quantity > 0) return p.sourceAvailability === 'onbackorder' ? 'BackOrder' : 'InStock';
  if (p.removedAtSourceAt) return 'Discontinued';
  // Not available at the supplier (out of stock, on backorder, removed) — never "SoldOut": it was not sold here.
  if (p.sourceAvailability === 'outofstock' || p.sourceAvailability === 'removed' || p.sourceAvailability === 'onbackorder') return 'OutOfStock';
  return 'SoldOut';
}

export function plainText(html: string | null | undefined, max = 5000): string | undefined {
  if (!html) return undefined;
  const t = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, max) : undefined;
}

/**
 * Plain text for public metadata (meta description, JSON-LD, link previews):
 * any sentence that states a price is left out, so search results never show
 * a price other than ours (supplier copy is also cleaned at import; this is
 * the last guard for texts written before that).
 */
export function publicPlainText(html: string | null | undefined, max = 5000): string | undefined {
  const t = plainText(html, 20_000);
  if (!t) return undefined;
  const kept = t
    .split(/(?<=[.!?])\s+|\s+(?=For sale:)/)
    .filter((sentence) => !hasPriceText(sentence))
    .join(' ')
    .trim();
  return kept ? kept.slice(0, max) : undefined;
}

export interface ProductJsonLdInput {
  baseUrl: string;
  product: {
    slug: string;
    title: string;
    summary: string | null;
    description: string | null;
    sku: string | null;
    mpn: string | null;
    quantity: number;
    sourceAvailability: string | null;
    removedAtSourceAt: Date | string | null;
  };
  /** Buyer-facing photo paths ("/media/…"). */
  images: string[];
  brand: { name: string; slug: string } | null;
  categoryName: string;
  schemaOrgCondition: string;
  offer: OfferPrice;
  sellerName: string;
  returnPolicyDays: number | null;
  rating: { average: number; count: number } | null;
}

export function buildProductJsonLd(i: ProductJsonLdInput): Record<string, unknown> {
  const abs = (p: string) => (/^https?:\/\//i.test(p) ? p : `${i.baseUrl}${p.startsWith('/') ? '' : '/'}${p}`);
  const url = `${i.baseUrl}/marketplace/${i.product.slug}`;
  const condition = `https://schema.org/${i.schemaOrgCondition || 'UsedCondition'}`;
  const availability = `https://schema.org/${schemaAvailability(i.product)}`;
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: i.product.title,
    url,
    category: i.categoryName,
    itemCondition: condition,
  };
  const description = publicPlainText(i.product.summary) ?? publicPlainText(i.product.description);
  if (description) ld.description = description;
  if (i.product.sku?.trim()) ld.sku = i.product.sku.trim();
  if (i.product.mpn?.trim()) ld.mpn = i.product.mpn.trim();
  if (i.brand && !isPlaceholderBrand(i.brand)) ld.brand = { '@type': 'Brand', name: i.brand.name };
  if (i.images.length) ld.image = i.images.map(abs);
  if (i.rating && i.rating.count > 0) {
    ld.aggregateRating = { '@type': 'AggregateRating', ratingValue: i.rating.average, reviewCount: i.rating.count };
  }
  const price = i.offer.priceCents;
  if (!i.offer.priceHidden && i.offer.mode !== 'QUOTE_ONLY' && price !== null && price > 0) {
    const offer: Record<string, unknown> = {
      '@type': 'Offer',
      url,
      priceCurrency: i.offer.currency,
      price: (price / 100).toFixed(2),
      availability,
      itemCondition: condition,
      seller: { '@type': 'Organization', name: i.sellerName },
    };
    if (i.returnPolicyDays) {
      offer.hasMerchantReturnPolicy = {
        '@type': 'MerchantReturnPolicy',
        returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
        merchantReturnDays: i.returnPolicyDays,
      };
    }
    ld.offers = offer;
  }
  return ld;
}
