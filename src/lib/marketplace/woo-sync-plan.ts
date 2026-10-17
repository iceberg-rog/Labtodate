/**
 * WooCommerce supplier sync — the pure decision rules (no DB, no network), so
 * they are unit-tested (woo-sync-plan.test.ts) and the dry-run report is
 * exactly what a real run would do.
 *
 * Field ownership:
 *  - The SOURCE owns: price (+ currency), availability, and its own bookkeeping
 *    (source URL/slug, source photo list, last-seen availability).
 *  - LAB2DATE owns: status (publish / archive decisions), category, brand,
 *    condition, warranty, inspection, buying mode, and — unless the shop's
 *    policy is CONTENT_TOO — title, summary, description and photos.
 *  - An admin can lock any of title / summary / description / images / price
 *    on a single product (Product.lockedFields); a sync never touches a locked
 *    field. Admin edits of an imported product lock the edited fields.
 *  - Status is never moved away from DRAFT / PENDING_REVIEW / ARCHIVED by a
 *    sync, and an item that comes back at the source is NOT re-published.
 */
import type { ImportSyncPolicy, ProductMode, ProductStatus, SyncStockMode } from '@prisma/client';

export const LOCKABLE_FIELDS = ['title', 'summary', 'description', 'images', 'price'] as const;
export type LockableField = (typeof LOCKABLE_FIELDS)[number];

export function isLockableField(f: string): f is LockableField {
  return (LOCKABLE_FIELDS as readonly string[]).includes(f);
}

/** One product as the source reports it (already parsed + cleaned). */
export interface SourceItem {
  externalId: string;
  /** The source's own slug as returned (may be percent-encoded). */
  sourceSlug: string;
  permalink: string | null;
  title: string;
  /** True when the source had no name (title is a placeholder). */
  placeholderTitle: boolean;
  summary: string | null;
  description: string | null;
  priceCents: number | null;
  currency: string;
  imageUrls: string[];
  sku: string | null;
  mpn: string | null;
  inStock: boolean;
  /** Exact stock at the source when it tells us; null = in stock, quantity unknown. */
  sourceQty: number | null;
  availability: 'instock' | 'outofstock' | 'onbackorder';
  /** Sentences the cleaner took out of the source texts (claims, prices, supplier copy). */
  removed?: { reason: string; text: string }[];
}

/** The parts of a local product the planner reads. */
export interface LocalState {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  description: string | null;
  priceCents: number | null;
  currency: string;
  mode: ProductMode;
  quantity: number;
  status: ProductStatus;
  sku: string | null;
  mpn: string | null;
  lockedFields: string[];
  externalId: string | null;
  externalSource: string | null;
  sourceSlug: string | null;
  sourceUrl: string | null;
  sourceAvailability: string | null;
  sourceImageUrls: string[];
  removedAtSourceAt: Date | null;
  /** 8f: a source price waiting for admin review (null = none). */
  pendingPriceCents?: number | null;
  pendingPriceCurrency?: string | null;
  priceOnHold?: boolean;
  /** Units of this product in lab2date orders that are not canceled/refunded. */
  committedUnits: number;
}

/** When a source price change waits for an admin instead of going live (Settings → Import & suppliers). */
export interface PriceReviewRule {
  /** Basis points: a drop larger than this is held (3000 = 30 %). */
  dropBp: number;
  riseBp: number;
  /** true = the listing cannot be bought while the change waits. */
  hold: boolean;
}

export const DEFAULT_PRICE_REVIEW: PriceReviewRule = { dropBp: 3000, riseBp: 5000, hold: true };

export interface ShopSyncPolicy {
  syncPolicy: ImportSyncPolicy;
  syncStockMode: SyncStockMode;
  autoPublishImports: boolean;
  archiveMissingAtSource: boolean;
  importDefaultQuantity: number;
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface SkippedField {
  field: string;
  reason: 'locked' | 'policy' | 'placeholder';
}

export interface ExistingPlan {
  /** Product fields to write (only those that change). */
  data: Record<string, unknown>;
  changes: FieldChange[];
  skipped: SkippedField[];
  /** The source photo list changed and the policy/locks allow replacing photos. */
  replaceImages: boolean;
  notes: string[];
  /** A price change this run sent to review (not applied). */
  priceReview: {
    fromCents: number;
    toCents: number;
    fromCurrency: string;
    toCurrency: string;
    changeBp: number;
    held: boolean;
    alreadyQueued: boolean;
  } | null;
}

/**
 * Units a buyer may order here, from what the source says:
 *  - out of stock / backorder / removed at the source → 0, always;
 *  - an exact source quantity → that, minus lab2date sales the supplier does
 *    not know about (SUBTRACT_LOCAL_SALES) or as-is (SOURCE_IS_TRUTH);
 *  - "in stock" without a number → keep the quantity we already have (the
 *    owner may know there are 2); only an item at 0 gets the shop default
 *    back, minus units already sold here.
 * `localQuantity` is undefined for a product that does not exist yet.
 */
export function targetQuantity(
  src: SourceItem,
  policy: ShopSyncPolicy,
  committedUnits: number,
  localQuantity?: number,
): number {
  if (!src.inStock) return 0;
  const subtract = policy.syncStockMode === 'SUBTRACT_LOCAL_SALES';
  const sold = Math.max(0, committedUnits);
  if (src.sourceQty !== null) return Math.max(0, subtract ? src.sourceQty - sold : src.sourceQty);
  if (localQuantity !== undefined && localQuantity > 0) return localQuantity;
  const base = Math.max(1, policy.importDefaultQuantity);
  return Math.max(0, subtract ? base - sold : base);
}

/** Status of a NEW product created by a sync. */
export function statusForNew(src: SourceItem, policy: ShopSyncPolicy): ProductStatus {
  if (src.placeholderTitle) return 'PENDING_REVIEW';
  return policy.autoPublishImports ? 'PUBLISHED' : 'PENDING_REVIEW';
}

/** Mode for a NEW product: buyable with a price, quote-only without. */
export function modeForNew(src: SourceItem): ProductMode {
  return src.priceCents ? 'HYBRID' : 'QUOTE_ONLY';
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Signed change in basis points (−9900 = −99 %). */
export function priceChangeBp(from: number, to: number): number {
  if (from <= 0) return Infinity;
  return Math.round(((to - from) / from) * 10000);
}

/** Does this source price change need an admin's approval before it goes live? */
export function needsPriceReview(
  from: { cents: number | null; currency: string },
  to: { cents: number | null; currency: string },
  rule: PriceReviewRule,
): boolean {
  if (from.cents === null || to.cents === null || from.cents <= 0) return false;
  if (from.currency !== to.currency) return true;
  const bp = priceChangeBp(from.cents, to.cents);
  return bp < 0 ? -bp > rule.dropBp : bp > rule.riseBp;
}

export function fmtAmount(cents: number, currency: string): string {
  return `${(cents / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/**
 * Decide what a sync writes to an existing product matched to `src`.
 * `adopt` = a legacy row (no externalId) matched by slug: record its source identity.
 */
export function planExisting(
  local: LocalState,
  src: SourceItem,
  policy: ShopSyncPolicy,
  opts: { adopt?: boolean; review?: PriceReviewRule; now?: Date } = {},
): ExistingPlan {
  const data: Record<string, unknown> = {};
  const changes: FieldChange[] = [];
  const skipped: SkippedField[] = [];
  const notes: string[] = [];
  let priceReview: ExistingPlan['priceReview'] = null;
  const locked = new Set(local.lockedFields);
  const set = (field: string, from: unknown, to: unknown, column = field) => {
    if (from === to) return;
    data[column] = to;
    changes.push({ field, from, to });
  };

  // ── Identity / bookkeeping (always) ──
  if (opts.adopt || local.externalId !== src.externalId) {
    set('externalSource', local.externalSource, 'woo');
    set('externalId', local.externalId, src.externalId);
  }
  set('sourceSlug', local.sourceSlug, src.sourceSlug);
  if (src.permalink) set('sourceUrl', local.sourceUrl, src.permalink);
  set('sourceAvailability', local.sourceAvailability, src.availability);
  if (local.removedAtSourceAt) {
    set('removedAtSourceAt', local.removedAtSourceAt, null);
    notes.push(
      local.status === 'ARCHIVED'
        ? 'Back at the source. It stays ARCHIVED — publish it yourself if it should be sold again.'
        : 'Back at the source.',
    );
  }

  // ── Price (source-owned unless locked; large changes wait for review) ──
  const rule = opts.review ?? DEFAULT_PRICE_REVIEW;
  const pendingCents = local.pendingPriceCents ?? null;
  const clearPending = (why: string | null) => {
    if (pendingCents === null && !local.priceOnHold) return;
    set('pendingPriceCents', pendingCents, null);
    set('pendingPriceCurrency', local.pendingPriceCurrency ?? null, null);
    data.pendingPriceAt = null;
    data.pendingPriceNote = null;
    if (local.priceOnHold) set('priceOnHold', true, false);
    if (why) notes.push(why);
  };
  const priceDiffers = local.priceCents !== src.priceCents || (src.priceCents !== null && local.currency !== src.currency);
  if (!priceDiffers) {
    if (!locked.has('price')) {
      clearPending(pendingCents !== null ? 'The source price is back to the current price: the change waiting for review was dropped.' : null);
    }
  } else if (locked.has('price')) {
    skipped.push({ field: 'price', reason: 'locked' });
  } else if (needsPriceReview({ cents: local.priceCents, currency: local.currency }, { cents: src.priceCents, currency: src.currency }, rule)) {
    const fromCents = local.priceCents as number;
    const toCents = src.priceCents as number;
    const sameCurrency = local.currency === src.currency;
    const changeBp = sameCurrency ? priceChangeBp(fromCents, toCents) : 0;
    const alreadyQueued = pendingCents === toCents && (local.pendingPriceCurrency ?? local.currency) === src.currency;
    priceReview = { fromCents, toCents, fromCurrency: local.currency, toCurrency: src.currency, changeBp, held: rule.hold || !!local.priceOnHold, alreadyQueued };
    const pct = `${changeBp > 0 ? '+' : '−'}${(Math.abs(changeBp) / 100).toFixed(Math.abs(changeBp) % 100 ? 1 : 0)} %`;
    const limit = `${((changeBp < 0 ? rule.dropBp : rule.riseBp) / 100).toFixed(0)} %`;
    const what = sameCurrency
      ? `${fmtAmount(fromCents, local.currency)} → ${fmtAmount(toCents, src.currency)} (${pct}, over the ${limit} review threshold)`
      : `the currency changed: ${fmtAmount(fromCents, local.currency)} → ${fmtAmount(toCents, src.currency)}`;
    if (!alreadyQueued) {
      set('pendingPriceCents', pendingCents, toCents);
      set('pendingPriceCurrency', local.pendingPriceCurrency ?? null, src.currency);
      data.pendingPriceAt = opts.now ?? new Date();
      data.pendingPriceNote = `Source price ${what}.`;
      if (rule.hold && !local.priceOnHold) set('priceOnHold', false, true);
    }
    notes.push(
      `${alreadyQueued ? 'Still waiting for price review' : 'Price change held for review'}: ${what}. ` +
        (priceReview.held
          ? 'The listing cannot be bought until you approve or reject the new price (Admin → Catalog → Price review).'
          : 'It is still sold at the current price until you decide (Admin → Catalog → Price review).'),
    );
  } else {
    set('priceCents', local.priceCents, src.priceCents);
    if (src.priceCents !== null) set('currency', local.currency, src.currency);
    // A unit without a price cannot be bought online; one that gets a price
    // again becomes buyable only if it was quote-only for lack of a price.
    if (src.priceCents === null && local.mode !== 'QUOTE_ONLY') set('mode', local.mode, 'QUOTE_ONLY');
    if (src.priceCents !== null && local.priceCents === null && local.mode === 'QUOTE_ONLY') set('mode', local.mode, 'HYBRID');
    clearPending(pendingCents !== null ? 'A newer source price within the review threshold replaced the change that was waiting for review.' : null);
  }

  // ── Availability (source-owned, never lockable) ──
  const qty = targetQuantity(src, policy, local.committedUnits, local.quantity);
  set('quantity', local.quantity, qty);
  if (src.inStock && qty === 0 && local.committedUnits > 0) {
    notes.push(`In stock at the source, but held at 0: ${local.committedUnits} unit(s) already sold on lab2date.`);
  }

  // ── Content (only with CONTENT_TOO, never over a lock or with a placeholder) ──
  const content: [LockableField, string | null, string | null][] = [
    ['title', local.title, src.title],
    ['summary', local.summary, src.summary],
    ['description', local.description, src.description],
  ];
  for (const [field, from, to] of content) {
    if ((from ?? '') === (to ?? '')) continue;
    if (policy.syncPolicy !== 'CONTENT_TOO') {
      skipped.push({ field, reason: 'policy' });
    } else if (locked.has(field)) {
      skipped.push({ field, reason: 'locked' });
    } else if (field === 'title' && src.placeholderTitle) {
      skipped.push({ field, reason: 'placeholder' });
    } else {
      set(field, from, to);
    }
  }
  let replaceImages = false;
  if (!sameList(local.sourceImageUrls, src.imageUrls)) {
    if (local.sourceImageUrls.length === 0) {
      // First sync of a legacy row: record provenance only (photos already ours).
      set('sourceImageUrls', local.sourceImageUrls, src.imageUrls);
    } else if (policy.syncPolicy !== 'CONTENT_TOO') {
      skipped.push({ field: 'images', reason: 'policy' });
      set('sourceImageUrls', local.sourceImageUrls, src.imageUrls);
    } else if (locked.has('images')) {
      skipped.push({ field: 'images', reason: 'locked' });
      set('sourceImageUrls', local.sourceImageUrls, src.imageUrls);
    } else {
      replaceImages = true;
      set('sourceImageUrls', local.sourceImageUrls, src.imageUrls);
    }
  }

  // ── Enrichment of empty identifiers (never overwrites a value) ──
  if (!local.sku && src.sku) set('sku', local.sku, src.sku);
  if (!local.mpn && src.mpn) set('mpn', local.mpn, src.mpn);

  // ── Status: a sync never changes it for an item present at the source ──
  if (local.status !== 'PUBLISHED') {
    notes.push(`Status ${local.status} kept (a sync never publishes or un-archives).`);
  }
  return { data, changes, skipped, replaceImages, notes, priceReview };
}

export interface MissingPlan {
  data: Record<string, unknown>;
  changes: FieldChange[];
  archived: boolean;
  notes: string[];
}

/** An imported product no longer present at its source. */
export function planMissing(
  local: Pick<LocalState, 'status' | 'quantity' | 'sourceAvailability' | 'removedAtSourceAt'>,
  policy: ShopSyncPolicy,
  now: Date,
): MissingPlan {
  const data: Record<string, unknown> = {};
  const changes: FieldChange[] = [];
  const notes: string[] = [];
  const set = (field: string, from: unknown, to: unknown) => {
    if (from === to) return;
    data[field] = to;
    changes.push({ field, from, to });
  };
  set('quantity', local.quantity, 0);
  set('sourceAvailability', local.sourceAvailability, 'removed');
  if (!local.removedAtSourceAt) set('removedAtSourceAt', null, now);
  let archived = false;
  if (policy.archiveMissingAtSource && local.status !== 'ARCHIVED') {
    set('status', local.status, 'ARCHIVED');
    archived = true;
  } else if (!policy.archiveMissingAtSource && local.status === 'PUBLISHED') {
    notes.push('Removed at the source: shown as not available (this shop keeps such items published).');
  }
  return { data, changes, archived, notes };
}

/** A clean lab2date slug from a source slug ("…-14-%c2%b5l-…" → "…-14-ul-…"). */
export function cleanSlug(raw: string, max = 90): string {
  let s = raw;
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(s);
      if (d === s) break;
      s = d;
    } catch {
      break;
    }
  }
  return s
    .replace(/[µμ]/g, 'u')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Slug candidates for a NEW product, most preferred first (namespaced on collision). */
export function slugCandidates(sourceSlug: string, shopSlug: string, externalId: string): string[] {
  const base = cleanSlug(sourceSlug) || `${shopSlug}-${externalId}`;
  const ns = cleanSlug(`${shopSlug}-${base}`);
  return Array.from(new Set([base, ns, cleanSlug(`${ns}-${externalId}`)]));
}

/** The mass-archive safety stop (Settings → Import & suppliers). */
export interface ArchiveStopRule {
  /** Basis points of the shop's tracked items (1000 = 10 %). */
  stopBp: number;
  /** Items that may always be archived in one run. */
  allow: number;
}

export const DEFAULT_ARCHIVE_STOP: ArchiveStopRule = { stopBp: 1000, allow: 3 };

/**
 * Refuse to archive when the source looks truncated (a broken or partial
 * source must not take a shop offline): more than `allow` items AND more than
 * `stopBp` of the shop's tracked items missing in one run. Proportional for
 * every shop size — no fixed floor that lets a small shop vanish.
 */
export function archiveLooksUnsafe(missing: number, trackedTotal: number, rule: ArchiveStopRule = DEFAULT_ARCHIVE_STOP): boolean {
  if (missing <= 0 || missing <= rule.allow) return false;
  return missing * 10000 > Math.max(0, trackedTotal) * rule.stopBp;
}
