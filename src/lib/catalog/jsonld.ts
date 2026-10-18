/**
 * schema.org Product structured data that says only what is true:
 *  - availability from real stock (InStock / SoldOut / OutOfStock at the
 *    supplier / Discontinued when removed at the source / Reserved for
 *    another buyer's order), never a constant;
 *  - itemCondition from the admin-managed condition grade;
 *  - sku / mpn only when the listing has real ones (never the URL slug);
 *  - no placeholder brand (Settings → Import & suppliers list);
 *  - only our own photos, all of them, as absolute URLs (no stock photos);
 *  - an Offer exactly when the page shows a price, with the amount the page
 *    shows (PRICE_DISPLAY_MODE: incl. VAT in INCL mode) and a
 *    priceSpecification saying whether VAT is included;
 *  - seller = the legal entity from Settings → Company;
 *  - a return policy only when the owner advertises it AND the terms state it;
 *  - no Product node at all when there is neither an offer nor a rating
 *    (search engines reject a Product without one).
 * Plus the product page's meta description (per-product override → the
 * listing's own text → a description built from its facts).
 * Pure — unit-tested in tests/catalog/jsonld.test.ts.
 */
import type { OfferPrice } from '@/lib/catalog/offer-price';
import { hasPriceText } from '@/lib/catalog/import-rules';
import { decodeEntities } from '@/lib/marketplace/import-clean';
import { grossOf, type PriceDisplaySettings } from '@/lib/pricing/display';

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

export type SchemaAvailability = 'InStock' | 'BackOrder' | 'SoldOut' | 'OutOfStock' | 'Discontinued' | 'Reserved';

export function schemaAvailability(p: {
  quantity: number;
  sourceAvailability?: string | null;
  removedAtSourceAt?: Date | string | null;
  /** Held for another buyer's accepted offer / unpaid order: it comes back if that order is not completed. */
  reserved?: boolean;
}): SchemaAvailability {
  // A unit sellable while on backorder at the supplier (SYNC_BACKORDER_MODE = SELLABLE).
  if (p.quantity > 0) return p.sourceAvailability === 'onbackorder' ? 'BackOrder' : 'InStock';
  if (p.removedAtSourceAt) return 'Discontinued';
  // Not available at the supplier (out of stock, on backorder, removed) — never "SoldOut": it was not sold here.
  if (p.sourceAvailability === 'outofstock' || p.sourceAvailability === 'removed' || p.sourceAvailability === 'onbackorder') return 'OutOfStock';
  // Reserved is not sold (the page says "Reserved").
  if (p.reserved) return 'Reserved';
  return 'SoldOut';
}

export function plainText(html: string | null | undefined, max = 5000): string | undefined {
  if (!html) return undefined;
  // Tags out first, then every character reference decoded once ("&#8211;"
  // from old imports included), so no entity reaches a meta tag as text.
  const t = decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '), ' ')
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

/** Cut a text on a word boundary at about `max` characters, with "…" when cut. */
export function cutAtWord(text: string, max = 155): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  // One very long word: cut inside it rather than keeping almost nothing.
  const cut = space >= max * 0.6 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:.·–—-]+$/, '')}…`;
}

const comparable = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** `word` appears in `text` as a whole word (any case). */
function containsWord(text: string, word: string): boolean {
  const w = comparable(word);
  return !!w && ` ${comparable(text)} `.includes(` ${w} `);
}

/** The title already names the brand: in full, or by its first word ("Agilent 1200" for Agilent Technologies). */
function titleNamesBrand(title: string, brand: string): boolean {
  const first = comparable(brand).split(' ')[0] ?? '';
  return containsWord(title, brand) || (first.length >= 3 && containsWord(title, first));
}

/**
 * Fill the fact-based description template. The brand and the condition are
 * left out when the title already says them ("Agilent Agilent 1200 …"), and
 * the punctuation around an empty placeholder goes with it.
 */
export function fillMetaFormat(
  format: string,
  v: { condition: string; brand: string | null; title: string; category: string; year: number | null; site: string },
): string {
  const values: Record<string, string> = {
    CONDITION: v.condition && !containsWord(v.title, v.condition) ? v.condition : '',
    BRAND: v.brand && !titleNamesBrand(v.title, v.brand) ? v.brand : '',
    TITLE: v.title,
    CATEGORY: v.category,
    YEAR: v.year ? String(v.year) : '',
    SITE: v.site,
  };
  const filled = format
    .replace(/\{(CONDITION|BRAND|TITLE|CATEGORY|YEAR|SITE)\}/g, (_, k: string) => values[k])
    .replace(/\(\s*(?:[,;·–—-]\s*)+/g, '(')
    .replace(/(?:\s*[,;·–—-])+\s*\)/g, ')')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return filled.charAt(0).toUpperCase() + filled.slice(1);
}

/**
 * The product page's meta description: the admin's own search description
 * (Product.seoDescription) as written; else the listing's text (summary, then
 * description) cut at about 155 characters on a word boundary — unless it
 * only repeats the title; else a description built from the facts.
 */
export function productMetaDescription(p: {
  seoDescription?: string | null;
  summary: string | null;
  description: string | null;
  title: string;
  /** Already without placeholder brands. */
  brandName: string | null;
  conditionLabel: string;
  categoryName: string;
  yearMade: number | null;
  siteName: string;
  format: string;
}): string {
  const own = p.seoDescription?.replace(/\s+/g, ' ').trim();
  if (own) return own;
  const titleish = comparable(`${p.brandName ?? ''} ${p.title}`);
  for (const source of [p.summary, p.description]) {
    const text = publicPlainText(source);
    if (text && !titleish.includes(comparable(text))) return cutAtWord(text, 155);
  }
  return cutAtWord(
    fillMetaFormat(p.format, {
      condition: p.conditionLabel,
      brand: p.brandName,
      title: p.title,
      category: p.categoryName,
      year: p.yearMade,
      site: p.siteName,
    }),
    160,
  );
}

/** The return policy search engines may be told about (null = none is advertised). */
export interface SeoReturnPolicy {
  days: number;
  /** ISO country the policy applies to and goods are returned to. */
  country: string;
  /** Who pays the return shipping; null = decided per case (not stated). */
  fees: 'FREE' | 'CUSTOMER' | null;
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
    vatScheme?: 'STANDARD' | 'MARGIN' | null;
  };
  /** Held for another buyer's order (the page says "Reserved"). */
  reserved?: boolean;
  /** Buyer-facing photo paths ("/media/…"). */
  images: string[];
  brand: { name: string; slug: string } | null;
  /** Settings → Import & suppliers → “Brand names that are placeholders”. */
  placeholderBrands?: readonly string[];
  categoryName: string;
  schemaOrgCondition: string;
  offer: OfferPrice;
  /** The page shows a price (false while it is being confirmed, or for a sold unit whose price is hidden). */
  priceShown: boolean;
  /** How the page prints prices (Settings → Tax & VAT): the Offer carries the same amount. */
  display: Pick<PriceDisplaySettings, 'mode' | 'standardRateBp' | 'marginSchemeEnabled'>;
  sellerName: string;
  returnPolicy: SeoReturnPolicy | null;
  rating: { average: number; count: number } | null;
}

/** The Product node, or null when it would have neither an offer nor a rating. */
export function buildProductJsonLd(i: ProductJsonLdInput): Record<string, unknown> | null {
  const abs = (p: string) => (/^https?:\/\//i.test(p) ? p : `${i.baseUrl}${p.startsWith('/') ? '' : '/'}${p}`);
  const url = `${i.baseUrl}/marketplace/${i.product.slug}`;
  const condition = `https://schema.org/${i.schemaOrgCondition || 'UsedCondition'}`;
  const availability = `https://schema.org/${schemaAvailability({ ...i.product, reserved: i.reserved })}`;
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
  if (i.brand && !isPlaceholderBrand(i.brand, i.placeholderBrands)) ld.brand = { '@type': 'Brand', name: i.brand.name };
  if (i.images.length) ld.image = i.images.map(abs);
  if (i.rating && i.rating.count > 0) {
    ld.aggregateRating = { '@type': 'AggregateRating', ratingValue: i.rating.average, reviewCount: i.rating.count };
  }
  const net = i.offer.priceCents;
  // Whatever the buying mode: a price on the page is an offer at that price.
  if (i.priceShown && !i.offer.priceHidden && net !== null && net > 0) {
    // The main amount the page prints (PriceTag / priceParts): gross in INCL
    // mode, net otherwise; a margin-scheme price is final (VAT inside).
    const margin = i.product.vatScheme === 'MARGIN' && i.display.marginSchemeEnabled;
    const vatIncluded = margin || i.display.mode === 'INCL';
    const shown = !margin && i.display.mode === 'INCL' ? grossOf(net, i.display.standardRateBp) : net;
    const price = (shown / 100).toFixed(2);
    const offer: Record<string, unknown> = {
      '@type': 'Offer',
      url,
      priceCurrency: i.offer.currency,
      price,
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price,
        priceCurrency: i.offer.currency,
        valueAddedTaxIncluded: vatIncluded,
      },
      availability,
      itemCondition: condition,
      seller: { '@type': 'Organization', name: i.sellerName },
    };
    const rp = i.returnPolicy;
    if (rp && rp.days > 0) {
      offer.hasMerchantReturnPolicy = {
        '@type': 'MerchantReturnPolicy',
        applicableCountry: rp.country,
        returnPolicyCountry: rp.country,
        returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
        merchantReturnDays: rp.days,
        returnMethod: 'https://schema.org/ReturnByMail',
        ...(rp.fees
          ? { returnFees: rp.fees === 'FREE' ? 'https://schema.org/FreeReturn' : 'https://schema.org/ReturnFeesCustomerResponsibility' }
          : {}),
      };
    }
    ld.offers = offer;
  }
  return ld.offers || ld.aggregateRating ? ld : null;
}
