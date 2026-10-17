import * as React from 'react';
import type { ConditionGrade, ProductCondition } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { DEFAULT_WARRANTY_FALLBACK_TEXT, DEFAULT_WARRANTY_MONTHS_FORMAT } from '@/lib/catalog/warranty';
import { CATALOG_TEXT_DEFAULTS } from '@/lib/catalog/texts';

/**
 * Typed, defaulted view of the catalog settings (src/lib/catalog/settings-defs.ts).
 * Every claim defaults to "none": an empty string means "do not show".
 */
export interface CatalogPolicy {
  warrantyFallbackText: string;
  warrantyMonthsFormat: string;
  inspectionRequiresReport: boolean;
  inspectionNoneText: string;
  missingPhotoMode: 'PLACEHOLDER' | 'LABELLED_ILLUSTRATION';
  noPhotoLabel: string;
  illustrationLabel: string;
  shippingClaim: string;
  returnsClaim: string;
  requireConsentToPublish: boolean;
  /** Days to report an item that differs from its description (terms, FAQ, structured data). */
  returnWindowDays: number;
  /** The return window as advertised in structured data — null when not advertised. */
  seoReturnPolicyDays: number | null;
  importRequireSignedAgreement: boolean;
  sellAcquisitionModel: 'OUTRIGHT_PURCHASE' | 'CONSIGNMENT';
  sellLogisticsMode: 'SELLER_SHIPS' | 'WE_ARRANGE_PICKUP';
  sellValuationTurnaround: string;
  /** Buyer-facing product page texts (Settings → Catalog & claims). */
  texts: {
    soldTitle: string;
    soldText: string;
    unavailableTitle: string;
    unavailableText: string;
    backorderTitle: string;
    backorderText: string;
    backorderLeadTime: string;
    reservedText: string;
    priceReview: string;
    noDescription: string;
    askPhotosLabel: string;
    askPhotosMessage: string;
    reviewsEmpty: string;
  };
  productQuestionMinChars: number;
  sellerBoxShowListings: boolean;
  backorderSellable: boolean;
  placeholderBrands: string[];
  /** Legal identity of the seller of record (Settings → Company). */
  sellerLegalName: string;
  sellerKvk: string;
  sellerVat: string;
  siteName: string;
}

const PLACEHOLDER_BRANDS_DEFAULT = 'Other,Others,Generic,Unknown,Misc,Various,N/A,NA';

/** Pure: build the policy from an env-like map (unit-testable). */
export function catalogPolicyFrom(get: (key: string) => string): CatalogPolicy {
  const read = (k: string) => (get(k) ?? '').trim();
  const text = (k: string, d: string) => read(k) || d;
  const int = (k: string, d: number, min: number, max: number) => {
    const n = parseInt(read(k), 10);
    return Number.isInteger(n) && n >= min && n <= max ? n : d;
  };
  const b = (k: string, d: boolean) => {
    const v = read(k).toLowerCase();
    return v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : d;
  };
  const pick = <T extends string>(k: string, allowed: readonly T[], d: T): T =>
    (allowed as readonly string[]).includes(read(k)) ? (read(k) as T) : d;
  const site = read('SITE_NAME') || 'lab2date';
  const returnWindowDays = int('RETURN_WINDOW_DAYS', 7, 1, 365);
  const T = CATALOG_TEXT_DEFAULTS;
  return {
    warrantyFallbackText: read('WARRANTY_FALLBACK_TEXT') || DEFAULT_WARRANTY_FALLBACK_TEXT,
    warrantyMonthsFormat: read('WARRANTY_MONTHS_FORMAT').includes('{MONTHS}') ? read('WARRANTY_MONTHS_FORMAT') : DEFAULT_WARRANTY_MONTHS_FORMAT,
    inspectionRequiresReport: b('INSPECTION_CLAIM_REQUIRES_REPORT', true),
    inspectionNoneText: text('INSPECTION_NONE_TEXT', T.inspectionNone),
    missingPhotoMode: pick('MISSING_PHOTO_MODE', ['PLACEHOLDER', 'LABELLED_ILLUSTRATION'] as const, 'PLACEHOLDER'),
    noPhotoLabel: text('NO_PHOTO_LABEL', T.noPhotoLabel),
    illustrationLabel: text('ILLUSTRATION_LABEL', T.illustrationLabel),
    shippingClaim: read('TRUST_SHIPPING_CLAIM'),
    returnsClaim: read('TRUST_RETURNS_CLAIM'),
    requireConsentToPublish: b('REQUIRE_CONSENT_TO_PUBLISH', true),
    returnWindowDays,
    seoReturnPolicyDays: b('SEO_ADVERTISE_RETURN_POLICY', false) ? returnWindowDays : null,
    importRequireSignedAgreement: b('IMPORT_REQUIRE_SIGNED_AGREEMENT', true),
    sellAcquisitionModel: pick('SELL_ACQUISITION_MODEL', ['OUTRIGHT_PURCHASE', 'CONSIGNMENT'] as const, 'OUTRIGHT_PURCHASE'),
    sellLogisticsMode: pick('SELL_LOGISTICS_MODE', ['SELLER_SHIPS', 'WE_ARRANGE_PICKUP'] as const, 'SELLER_SHIPS'),
    sellValuationTurnaround: read('SELL_VALUATION_TURNAROUND'),
    texts: {
      soldTitle: text('PDP_SOLD_TITLE', T.soldTitle),
      soldText: text('PDP_SOLD_TEXT', T.soldText),
      unavailableTitle: text('PDP_UNAVAILABLE_TITLE', T.unavailableTitle),
      unavailableText: text('PDP_UNAVAILABLE_TEXT', T.unavailableText),
      backorderTitle: text('PDP_BACKORDER_TITLE', T.backorderTitle),
      backorderText: text('PDP_BACKORDER_TEXT', T.backorderText),
      backorderLeadTime: text('BACKORDER_LEAD_TIME_TEXT', T.backorderLeadTime),
      reservedText: text('PDP_RESERVED_TEXT', T.reservedText),
      priceReview: text('PRICE_REVIEW_BUYER_TEXT', T.priceReview),
      noDescription: text('PDP_NO_DESCRIPTION_TEXT', T.noDescription),
      askPhotosLabel: text('PDP_ASK_PHOTOS_LABEL', T.askPhotosLabel),
      askPhotosMessage: text('PDP_ASK_PHOTOS_MESSAGE', T.askPhotosMessage),
      reviewsEmpty: text('REVIEWS_EMPTY_TEXT', T.reviewsEmpty),
    },
    productQuestionMinChars: int('PRODUCT_QUESTION_MIN_CHARS', 10, 2, 200),
    sellerBoxShowListings: b('SELLER_BOX_SHOW_LISTINGS', true),
    backorderSellable: read('SYNC_BACKORDER_MODE') === 'SELLABLE',
    placeholderBrands: (read('PLACEHOLDER_BRAND_NAMES') || PLACEHOLDER_BRANDS_DEFAULT)
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    sellerLegalName: read('COMPANY_LEGAL_NAME') || site,
    sellerKvk: read('COMPANY_KVK'),
    sellerVat: read('COMPANY_VAT'),
    siteName: site,
  };
}

/** Current catalog policy (DB settings override .env; defaults otherwise). */
export async function getCatalogPolicy(): Promise<CatalogPolicy> {
  await ensureSettingsLoaded();
  return catalogPolicyFrom((k) => process.env[k] ?? '');
}

/** Fallback grade rows if the table is empty (fresh DB before migration data). */
const FALLBACK_GRADES: Record<ProductCondition, Pick<ConditionGrade, 'code' | 'label' | 'description' | 'schemaOrgCondition' | 'defaultWarrantyMonths' | 'warrantyScope'>> = {
  NEW: { code: 'NEW', label: 'New', description: null, schemaOrgCondition: 'NewCondition', defaultWarrantyMonths: null, warrantyScope: null },
  REFURBISHED: { code: 'REFURBISHED', label: 'Refurbished', description: null, schemaOrgCondition: 'RefurbishedCondition', defaultWarrantyMonths: null, warrantyScope: null },
  USED: { code: 'USED', label: 'Used', description: null, schemaOrgCondition: 'UsedCondition', defaultWarrantyMonths: null, warrantyScope: null },
};

export type GradeInfo = (typeof FALLBACK_GRADES)[ProductCondition];

// React's per-request cache() exists in the Next.js server runtime; CLI scripts
// (tsx, React 18 from node_modules) run without it, so fall back to no memo.
const perRequest: <F extends (...args: never[]) => unknown>(fn: F) => F =
  typeof (React as { cache?: unknown }).cache === 'function'
    ? ((React as unknown as { cache: <F>(fn: F) => F }).cache)
    : (fn) => fn;

/** Condition grades keyed by code; cached per request. */
export const getConditionGrades = perRequest(async (): Promise<Record<ProductCondition, GradeInfo>> => {
  const out = { ...FALLBACK_GRADES };
  try {
    const rows = await prisma.conditionGrade.findMany();
    for (const r of rows) out[r.code] = r;
  } catch {
    /* table missing (migration not applied yet) — fall back to labels only */
  }
  return out;
});
