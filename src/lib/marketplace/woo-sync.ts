/**
 * WooCommerce supplier sync (Store API, read-only, no credentials).
 *
 * One run = fetch the WHOLE source catalogue first (any failed page aborts the
 * run before anything is written), then plan every item with the pure rules in
 * woo-sync-plan.ts, then — unless it is a dry run — apply. Every run is
 * recorded in ImportRun with per-item changes, so the owner can see exactly
 * what a sync did (or would do).
 *
 * Identity: (companyId, 'woo', Woo product id). Rows imported before this
 * existed (no externalId) are adopted by their old slug, only within the same
 * shop. A slug used by another shop never moves that product: the new item
 * gets a namespaced slug ("<shop>-<slug>").
 *
 * Owner rules (Settings → Import & suppliers, lib/catalog/import-settings.ts):
 * supplier claims / other prices / cross-sell tails are cleaned from the
 * texts; large price changes wait for review; brand and category come from
 * configurable whole-word rules and an item that matches none is held for
 * review (never a silent first-category fallback); the mass-archive safety
 * stop is proportional; timeouts, locks and report retention are settings.
 *
 * Photos are re-hosted in our media store (src/lib/media/localize.ts); a sync
 * never replaces our copy with the supplier's URL.
 */
import type { OrderStatus, Prisma, ProductCondition } from '@prisma/client';
import { prisma } from '@/lib/db';
import { cleanSupplierHtmlDetailed, stripHtml, type RemovedText, type SupplierRef } from '@/lib/marketplace/import-clean';
import { parseWooProduct, type WooStoreProduct } from '@/lib/marketplace/woo-parse';
import { netFromImportedPrice } from '@/lib/pricing/import-vat';
import { settingPercentBp } from '@/lib/settings';
import { getImportSettings, type ImportSettings } from '@/lib/catalog/import-settings';
import { conditionConflict, matchBrand, matchCategory } from '@/lib/catalog/import-rules';
import { illustrationForCategory } from '@/lib/catalog/illustration';

export type { WooStoreProduct } from '@/lib/marketplace/woo-parse';
import { localizeImageList, fetchPublic } from '@/lib/media/localize';
import { isOwnStoredImage, publicProductImages } from '@/lib/media/public-src';
import { getCatalogPolicy } from '@/lib/catalog/policy';
import {
  archiveLooksUnsafe,
  modeForNew,
  planExisting,
  planMissing,
  slugCandidates,
  statusForNew,
  targetQuantity,
  type FieldChange,
  type LocalState,
  type ShopSyncPolicy,
  type SkippedField,
} from '@/lib/marketplace/woo-sync-plan';

// ─── Lab2date-side helpers (creation only) ──────────────────────────────────

function brandSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** Find (or, on a real run, create) the Brand row for a brand name. Never the "Other" placeholder. */
async function brandIdFor(name: string, create: boolean, cache: Map<string, string | null>): Promise<string | null> {
  const slug = brandSlug(name);
  if (!slug || slug === 'other') return null;
  if (cache.has(slug)) return cache.get(slug) ?? null;
  const existing =
    (await prisma.brand.findUnique({ where: { slug }, select: { id: true } })) ??
    (await prisma.brand.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } }));
  const id = existing?.id ?? (create ? (await prisma.brand.create({ data: { slug, name: name.slice(0, 80) }, select: { id: true } })).id : null);
  cache.set(slug, id);
  return id;
}

/** The account that owns a shop's imported products (no login, placeholder address). */
export function importerSellerId(shopSlug: string): string {
  return `seed_user_seller_${shopSlug.replace(/[^a-z0-9]/g, '')}`;
}

async function ensureImporterSeller(co: { id: string; slug: string; name: string }): Promise<string> {
  const id = importerSellerId(co.slug);
  const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    await prisma.user.create({
      data: { id, email: `sales@${co.slug}.import`, name: `${co.name} Sales`, role: 'SELLER', companyId: co.id },
    });
  }
  return id;
}

/** "3 sentences removed from the texts: claim ×1, price ×1 — “All our products are tested…”". */
function removedNote(removed: Array<{ reason: string; text: string }> | undefined, applied: boolean): string | null {
  if (!removed?.length) return null;
  const label: Record<string, string> = { CLAIM: 'supplier claim', PRICE: 'other price', SUPPLIER: 'supplier mention', CROSS_SELL: 'cross-sell' };
  const by = new Map<string, number>();
  for (const r of removed) by.set(r.reason, (by.get(r.reason) ?? 0) + 1);
  const parts = [...by.entries()].map(([k, n]) => `${label[k] ?? k.toLowerCase()} ×${n}`).join(', ');
  const first = removed.find((r) => r.reason === 'CLAIM' || r.reason === 'PRICE') ?? removed[0];
  const quote = first.text.length > 90 ? `${first.text.slice(0, 87)}…` : first.text;
  return `${removed.length} sentence(s) ${applied ? 'removed from' : 'would be removed from'} the texts (${parts}), e.g. “${quote}”.`;
}

// ─── Fetching ───────────────────────────────────────────────────────────────

async function fetchAllProducts(base: string, timeoutMs: number): Promise<WooStoreProduct[]> {
  const api = `${base.replace(/\/+$/, '')}/wp-json/wc/store/v1/products`;
  const get = async (page: number) => {
    // Public addresses only, also after a redirect (SSRF guard).
    const res = await fetchPublic(`${api}?per_page=100&page=${page}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'lab2date-sync/2.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`source page ${page} answered HTTP ${res.status}`);
    const total = parseInt(res.headers.get('x-wp-total') ?? '', 10);
    const items = (await res.json()) as WooStoreProduct[];
    if (!Array.isArray(items)) throw new Error(`source page ${page} is not a product list`);
    return { items, total };
  };
  const first = await get(1);
  const total = Number.isFinite(first.total) ? first.total : first.items.length;
  const pages = Math.max(1, Math.ceil(total / 100));
  const all = [...first.items];
  for (let p = 2; p <= pages; p++) all.push(...(await get(p)).items);
  const unique = new Map(all.map((w) => [w.id, w]));
  if (unique.size < total) {
    // The caller adds "Nothing was changed." — said once.
    throw new Error(`the source listed ${total} products but only ${unique.size} could be read`);
  }
  return [...unique.values()];
}

// ─── Report ─────────────────────────────────────────────────────────────────

export type ItemAction = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'ARCHIVED' | 'REMOVED_AT_SOURCE' | 'FAILED';

export interface ReportItem {
  action: ItemAction;
  externalId: string | null;
  slug: string;
  title?: string;
  productId?: string;
  /** Currency of the price fields in `changes` (for the report). */
  currency?: string;
  changes?: FieldChange[];
  skipped?: SkippedField[];
  notes?: string[];
  /** Why a new item was held for review instead of being published. */
  review?: string[];
  error?: string;
}

export interface SyncCounts {
  sourceProducts: number;
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  removedAtSource: number;
  failed: number;
  priceChanges: number;
  /** Source price changes beyond the thresholds, waiting for admin review. */
  priceReviews: number;
  /** New items held for review (brand / category / condition / claims). */
  heldForReview: number;
  /** Items whose imported texts lost supplier claims, prices or cross-sells. */
  textsCleaned: number;
  stockChanges: number;
  lockedSkips: number;
  imagesDownloaded: number;
  imageFailures: number;
}

export interface SyncResult {
  ok: boolean;
  runId: string | null;
  status: 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
  dryRun: boolean;
  message: string;
  counts: SyncCounts;
  /** Things an admin must look at even when the run succeeded (safety stop, reviews). */
  attention: string[];
}

function preview(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v.length > 160) return `${v.slice(0, 157)}… (${v.length} chars)`;
  if (Array.isArray(v)) return v.length > 6 ? [...v.slice(0, 6).map(preview), `… +${v.length - 6}`] : v.map(preview);
  return v;
}

function previewChanges(c: FieldChange[]): FieldChange[] {
  return c.map((x) => ({ field: x.field, from: preview(x.from), to: preview(x.to) }));
}

const emptyCounts = (): SyncCounts => ({
  sourceProducts: 0, created: 0, updated: 0, unchanged: 0, archived: 0, removedAtSource: 0,
  failed: 0, priceChanges: 0, priceReviews: 0, heldForReview: 0, textsCleaned: 0, stockChanges: 0,
  lockedSkips: 0, imagesDownloaded: 0, imageFailures: 0,
});

export function summarize(c: SyncCounts, dryRun: boolean): string {
  const verb = dryRun ? 'would be' : '';
  const parts = [
    `${c.sourceProducts} at the source`,
    `${c.created} ${verb} created`.replace(/\s+/g, ' '),
    `${c.updated} ${verb} updated`.replace(/\s+/g, ' '),
    `${c.archived} ${verb} archived (removed at the source)`.replace(/\s+/g, ' '),
    `${c.unchanged} unchanged`,
  ];
  if (c.priceReviews) parts.push(`${c.priceReviews} price change(s) ${dryRun ? 'would wait' : 'waiting'} for your review`);
  if (c.heldForReview) parts.push(`${c.heldForReview} new item(s) ${dryRun ? 'would be' : ''} held for review`.replace(/\s+/g, ' '));
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.imageFailures) parts.push(`${c.imageFailures} photo(s) could not be copied`);
  return `${dryRun ? 'Dry run — nothing was changed. ' : ''}${parts.join(' · ')}.`;
}

// ─── Run ────────────────────────────────────────────────────────────────────

export interface SyncOptions {
  companyId: string;
  dryRun: boolean;
  trigger: 'ADMIN' | 'CRON' | 'CLI';
  actorEmail?: string | null;
  /** Only these source slugs (selective import from the preview). Never archives. */
  onlySourceSlugs?: string[] | null;
  /** An admin confirmed this once: archive even beyond the safety stop. */
  allowMassArchive?: boolean;
}

/** Orders whose units are no longer committed (stock was released). */
const RELEASED_ORDER_STATES: OrderStatus[] = ['CANCELED', 'REFUNDED'];

/** Active (not released, not consumed) holds of one listing. */
export interface HeldUnits {
  /** Holds no live order counts (an open offer, a cart, a hold left on a canceled order). */
  noOrder: number;
  /** Holds of a live order not paid yet (an accepted quote, a checkout awaiting payment) — its OrderItem counts them too. */
  liveOrder: number;
}

/** Sums active holds per listing (pure; `orderStatus` null = no order). */
export function heldUnitsByProduct(holds: Array<{ productId: string; qty: number; orderStatus: OrderStatus | null }>): Map<string, HeldUnits> {
  const out = new Map<string, HeldUnits>();
  for (const h of holds) {
    const cur = out.get(h.productId) ?? { noOrder: 0, liveOrder: 0 };
    if (h.orderStatus && !RELEASED_ORDER_STATES.includes(h.orderStatus)) cur.liveOrder += h.qty;
    else cur.noOrder += h.qty;
    out.set(h.productId, cur);
  }
  return out;
}

/**
 * What the stock plan subtracts from the source quantity of one listing (D32):
 *  - SUBTRACT_LOCAL_SALES: units sold here (OrderItems of live orders, which
 *    include the holds of unpaid orders) + holds no order counts yet;
 *  - SOURCE_IS_TRUTH: every active hold (open offers, accepted but unpaid
 *    quotes, checkouts awaiting payment) — the supplier only learns about a
 *    sale after the payment, and raising the quantity over a hold would sell
 *    the unit twice. A paid order's hold is consumed: the source is the truth
 *    again. An as-is shop with holds is therefore planned as "source minus held".
 */
export function syncStockInputs(
  mode: ShopSyncPolicy['syncStockMode'],
  soldUnits: number,
  held: HeldUnits,
): { committedUnits: number; syncStockMode: ShopSyncPolicy['syncStockMode'] } {
  if (mode === 'SUBTRACT_LOCAL_SALES') return { committedUnits: soldUnits + held.noOrder, syncStockMode: mode };
  const all = held.noOrder + held.liveOrder;
  return all > 0 ? { committedUnits: all, syncStockMode: 'SUBTRACT_LOCAL_SALES' } : { committedUnits: soldUnits, syncStockMode: mode };
}

/** The plan's "held at 0" note, worded for what the units really are (sold vs reserved). */
function heldAtZeroNote(mode: ShopSyncPolicy['syncStockMode'], soldUnits: number, held: HeldUnits): string {
  const subtract = mode === 'SUBTRACT_LOCAL_SALES';
  const parts = [
    subtract && soldUnits > 0 ? `${soldUnits} unit(s) already sold on lab2date` : '',
    held.noOrder > 0 ? `${held.noOrder} unit(s) reserved for an open offer` : '',
    !subtract && held.liveOrder > 0 ? `${held.liveOrder} unit(s) reserved for an order awaiting payment` : '',
  ].filter(Boolean);
  return `In stock at the source, but held at 0: ${parts.join(' and ')}.`;
}

export async function runWooSync(opts: SyncOptions): Promise<SyncResult> {
  const counts = emptyCounts();
  const attention: string[] = [];
  const co = await prisma.company.findUnique({ where: { id: opts.companyId } });
  if (!co) return { ok: false, runId: null, status: 'FAILED', dryRun: opts.dryRun, message: 'Shop not found.', counts, attention };
  if (!co.importSourceUrl) {
    return { ok: false, runId: null, status: 'FAILED', dryRun: opts.dryRun, message: 'This shop has no import URL. Edit the shop to set one.', counts, attention };
  }
  const [catalog, rules] = await Promise.all([getCatalogPolicy(), getImportSettings()]);
  const agreementOk = co.agreementStatus === 'SIGNED' || co.agreementStatus === 'OWN_SHOP';
  if (!opts.dryRun && catalog.importRequireSignedAgreement && !agreementOk) {
    const message =
      co.agreementStatus === 'TERMINATED'
        ? `Blocked: the supplier agreement with “${co.name}” is terminated. Record a new signed agreement on the shop's page before syncing again.`
        : `Blocked: “${co.name}” has no signed supplier agreement. Record the agreement (or mark it as your own shop) on the shop's Sync page first — or turn off “Import only from shops with an agreement” in Settings → Import & suppliers.`;
    const run = await prisma.importRun.create({
      data: { companyId: co.id, dryRun: false, trigger: opts.trigger, status: 'BLOCKED', actorEmail: opts.actorEmail ?? null, finishedAt: new Date(), error: message },
    });
    return { ok: false, runId: run.id, status: 'BLOCKED', dryRun: false, message, counts, attention };
  }
  const running = await prisma.importRun.findFirst({
    where: { companyId: co.id, status: 'RUNNING', startedAt: { gt: new Date(Date.now() - rules.runLockMinutes * 60_000) } },
    select: { id: true },
  });
  if (running) {
    return { ok: false, runId: running.id, status: 'FAILED', dryRun: opts.dryRun, message: 'Another sync of this shop is still running. Wait for it to finish.', counts, attention };
  }

  const run = await prisma.importRun.create({
    data: { companyId: co.id, dryRun: opts.dryRun, trigger: opts.trigger, status: 'RUNNING', actorEmail: opts.actorEmail ?? null },
  });
  const items: ReportItem[] = [];
  const now = new Date();
  const policy: ShopSyncPolicy = {
    syncPolicy: co.syncPolicy,
    syncStockMode: co.syncStockMode,
    autoPublishImports: co.autoPublishImports,
    archiveMissingAtSource: co.archiveMissingAtSource,
    importDefaultQuantity: co.importDefaultQuantity,
  };
  const supplier: SupplierRef = { name: co.name, urls: [co.importSourceUrl, co.website] };
  const warnings: string[] = [];

  try {
    // 1. Read the whole source first. Any failure: nothing is written.
    const raw = await fetchAllProducts(co.importSourceUrl, rules.sourceTimeoutMs);
    const only = opts.onlySourceSlugs?.length ? new Set(opts.onlySourceSlugs) : null;
    // A26: Product.priceCents is NET. A shop that exports prices incl. VAT is
    // converted here (Sync & settings → "Prices at the source include VAT").
    const importRateBp = co.importVatRateBp ?? settingPercentBp('TAX_STANDARD_RATE_PCT');
    const toNet = (src: ReturnType<typeof parseWooProduct>) =>
      co.importPricesIncludeVat ? { ...src, priceCents: netFromImportedPrice(src.priceCents, true, importRateBp) } : src;
    const sources = raw
      .map((w) => ({ w, src: toNet(parseWooProduct(w, supplier, { clean: rules.clean, backorderSellable: rules.backorderSellable })) }))
      .filter(({ src }) => !only || only.has(src.sourceSlug) || only.has(src.sourceSlug.slice(0, 90)));
    counts.sourceProducts = raw.length;
    if (raw.length === 0) throw new Error('the source returned no products — refusing to treat every item as removed');

    // 2. Everything this shop already has.
    const locals = await prisma.product.findMany({
      where: { companyId: co.id },
      select: {
        id: true, slug: true, title: true, summary: true, description: true, priceCents: true, currency: true,
        mode: true, quantity: true, status: true, sku: true, mpn: true, lockedFields: true, externalId: true,
        externalSource: true, sourceSlug: true, sourceUrl: true, sourceAvailability: true, sourceImageUrls: true,
        removedAtSourceAt: true, images: true, sellerId: true,
        pendingPriceCents: true, pendingPriceCurrency: true, priceOnHold: true,
      },
    });
    const committed = new Map<string, number>();
    let held = new Map<string, HeldUnits>();
    if (locals.length) {
      const ids = locals.map((l) => l.id);
      const rows = await prisma.orderItem.groupBy({
        by: ['productId'],
        where: { productId: { in: ids }, order: { status: { notIn: RELEASED_ORDER_STATES } } },
        _sum: { quantity: true },
      });
      for (const r of rows) if (r.productId) committed.set(r.productId, r._sum.quantity ?? 0);
      // Active holds, split by whether a live order already counts them (syncStockInputs).
      const holds = await prisma.stockReservation.findMany({
        where: { productId: { in: ids }, releasedAt: null, consumedAt: null },
        select: { productId: true, qty: true, order: { select: { status: true } } },
      });
      held = heldUnitsByProduct(holds.map((h) => ({ productId: h.productId, qty: h.qty, orderStatus: h.order?.status ?? null })));
    }
    const byExternal = new Map(locals.filter((l) => l.externalSource === 'woo' && l.externalId).map((l) => [l.externalId!, l]));
    const legacyBySlug = new Map(locals.filter((l) => !l.externalId).map((l) => [l.slug, l]));
    const matched = new Set<string>();
    const sellerId = await (opts.dryRun ? Promise.resolve(importerSellerId(co.slug)) : ensureImporterSeller(co));
    const categories = await prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, slug: true, name: true } });
    if (!categories.length) throw new Error('no categories exist yet — create one first');
    const catBySlug = new Map(categories.map((c) => [c.slug, c]));
    const fallbackCategory = (rules.fallbackCategorySlug && catBySlug.get(rules.fallbackCategorySlug)) || categories[0];
    const brandCache = new Map<string, string | null>();
    const takenSlugs = new Set<string>();
    const review = { dropBp: rules.priceDropReviewBp, riseBp: rules.priceRiseReviewBp, hold: rules.priceReviewHold };

    // 3. Plan (and apply) every source item.
    for (const { w, src } of sources) {
      try {
        let local = byExternal.get(src.externalId);
        let adopt = false;
        if (!local) {
          const legacy = legacyBySlug.get(src.sourceSlug.slice(0, 90));
          if (legacy && !matched.has(legacy.id)) {
            local = legacy;
            adopt = true;
          }
        }
        if (local) {
          matched.add(local.id);
          const sold = committed.get(local.id) ?? 0;
          const heldHere = held.get(local.id) ?? { noOrder: 0, liveOrder: 0 };
          const stock = syncStockInputs(policy.syncStockMode, sold, heldHere);
          const state: LocalState = { ...local, committedUnits: stock.committedUnits };
          const plan = planExisting(state, src, { ...policy, syncStockMode: stock.syncStockMode }, { adopt, review, now });
          if (heldHere.noOrder + heldHere.liveOrder > 0) plan.notes = plan.notes.map((n) => (n.startsWith('In stock at the source, but held at 0:') ? heldAtZeroNote(policy.syncStockMode, sold, heldHere) : n));
          const data: Prisma.ProductUpdateInput = { ...plan.data };
          // Product.sourceUrl is unique: never take it from another listing.
          if (typeof plan.data.sourceUrl === 'string') {
            const owner = await prisma.product.findUnique({ where: { sourceUrl: plan.data.sourceUrl }, select: { id: true } });
            if (owner && owner.id !== local.id) {
              delete data.sourceUrl;
              plan.changes = plan.changes.filter((c) => c.field !== 'sourceUrl');
              plan.notes.push('The source URL is already recorded on another listing (possible duplicate).');
            }
          }
          if (plan.priceReview && !plan.priceReview.alreadyQueued) counts.priceReviews++;
          // Texts are applied only with CONTENT_TOO: then say what the cleaner removed.
          if (policy.syncPolicy === 'CONTENT_TOO' && plan.changes.some((c) => c.field === 'description' || c.field === 'summary')) {
            const note = removedNote(src.removed, !opts.dryRun);
            if (note) {
              plan.notes.push(note);
              counts.textsCleaned++;
            }
          }
          // Photos: replace with the new source photos (policy allows), and in
          // every case re-host any photo that is still on a foreign server.
          const wantImages = plan.replaceImages ? src.imageUrls : local.images;
          const needsHosting = wantImages.some((u) => !isOwnStoredImage(u)) || plan.replaceImages;
          if (needsHosting) {
            if (opts.dryRun) {
              const remote = wantImages.filter((u) => !isOwnStoredImage(u)).length;
              if (remote) plan.notes.push(`${remote} photo(s) would be copied to our media store.`);
              if (plan.replaceImages) plan.changes.push({ field: 'images', from: `${local.images.length} photo(s)`, to: `${src.imageUrls.length} photo(s) from the source` });
            } else {
              const loc = await localizeImageList(wantImages);
              counts.imagesDownloaded += loc.downloaded;
              counts.imageFailures += loc.failures.length;
              for (const f of loc.failures) plan.notes.push(`Photo not copied (${f.error}); it stays hidden from buyers and is retried next time.`);
              if (loc.changed || plan.replaceImages) {
                data.images = loc.images;
                data.hasImages = publicProductImages(loc.images).length > 0;
                if (plan.replaceImages) plan.changes.push({ field: 'images', from: `${local.images.length} photo(s)`, to: `${loc.images.length} photo(s)` });
                else plan.notes.push(`${loc.images.length - loc.failures.length} photo(s) now served from our media store.`);
              }
            }
          }
          if (!opts.dryRun) {
            const { quantity, ...rest } = data;
            const guarded = typeof quantity === 'number';
            await prisma.product.update({ where: { id: local.id }, data: { ...(guarded ? rest : data), lastSyncedAt: now } });
            if (guarded) {
              // Guarded on the quantity this plan started from: a sale or a
              // reservation made while the run was busy (photos, other items)
              // is never overwritten — the next run re-plans from the new count.
              const w = await prisma.product.updateMany({ where: { id: local.id, quantity: local.quantity }, data: { quantity } });
              if (w.count !== 1) {
                delete data.quantity;
                plan.changes = plan.changes.filter((c) => c.field !== 'quantity');
                plan.notes.push('The stock changed here during the sync (a sale or a reservation): the quantity was left as it is and is checked again on the next run.');
              }
            }
          }
          if (plan.changes.some((c) => c.field === 'priceCents')) counts.priceChanges++;
          if (plan.changes.some((c) => c.field === 'quantity')) counts.stockChanges++;
          counts.lockedSkips += plan.skipped.filter((s) => s.reason === 'locked').length;
          const changed = plan.changes.length > 0 || Object.keys(data).length > 0;
          if (changed) {
            counts.updated++;
            items.push({
              action: 'UPDATED', externalId: src.externalId, slug: local.slug, title: local.title, productId: local.id,
              currency: src.currency || local.currency,
              changes: previewChanges(plan.changes), skipped: plan.skipped.length ? plan.skipped : undefined,
              notes: plan.notes.length ? plan.notes : undefined,
            });
          } else {
            counts.unchanged++;
            items.push({
              action: 'UNCHANGED', externalId: src.externalId, slug: local.slug, productId: local.id,
              title: plan.notes.length || plan.skipped.length ? local.title : undefined,
              currency: local.currency,
              skipped: plan.skipped.some((s) => s.reason === 'locked') ? plan.skipped : undefined,
              notes: plan.notes.length ? plan.notes : undefined,
            });
          }
          continue;
        }

        // New item.
        let slug = '';
        for (const cand of slugCandidates(src.sourceSlug, co.slug, src.externalId)) {
          if (takenSlugs.has(cand)) continue;
          const exists = await prisma.product.findUnique({ where: { slug: cand }, select: { id: true } });
          if (!exists) {
            slug = cand;
            break;
          }
        }
        if (!slug) slug = `${co.slug}-${src.externalId}-${Date.now().toString(36)}`.slice(0, 90);
        takenSlugs.add(slug);
        const notes: string[] = [];
        const reviewWhy: string[] = [];
        if (slug !== slugCandidates(src.sourceSlug, co.slug, src.externalId)[0]) {
          notes.push(`The source slug is already used by another listing; ${opts.dryRun ? 'would be created' : 'created'} as “${slug}”.`);
        }
        const dup = await prisma.product.findFirst({
          where: { title: { equals: src.title, mode: 'insensitive' }, companyId: { not: co.id }, status: { not: 'ARCHIVED' } },
          select: { slug: true, company: { select: { name: true } } },
        });
        if (dup && !src.placeholderTitle) notes.push(`Possible duplicate of “${dup.slug}” (${dup.company?.name ?? 'own inventory'}) — same title. Check it is not the same physical unit.`);

        // Brand and category from the owner's rules; nothing matched = review, never a guess.
        const hint = (w.categories ?? []).map((c) => c.name).join(' ');
        const brand = matchBrand((w.brands ?? [])[0]?.name, src.title, rules.brands);
        const brandId = brand.brand ? await brandIdFor(brand.brand, !opts.dryRun, brandCache) : null;
        if (!brand.brand) reviewWhy.push('brand not recognised (Settings → Import & suppliers → Brands)');
        else if (brand.candidates.length > 1) notes.push(`Brand: “${brand.brand}” chosen (named first); the title also names ${brand.candidates.filter((b) => b !== brand.brand).join(', ')} — check.`);
        const catSlug = matchCategory(src.title, hint, rules.categories, (s) => catBySlug.has(s));
        const category = catSlug ? catBySlug.get(catSlug)! : fallbackCategory;
        if (!catSlug) reviewWhy.push(`category not recognised — filed under “${category.name}” until you choose one`);
        // Condition: the shop's default, unless the item's own text says otherwise.
        let condition: ProductCondition = co.importCondition;
        const plainText = stripHtml(`${src.summary ?? ''} ${src.description ?? ''}`);
        const stated = conditionConflict(condition, src.title, plainText, rules.conditionWords);
        if (stated && rules.conditionTextAction === 'USE_TEXT') {
          notes.push(`Condition set to ${stated} (the text says so; the shop default is ${co.importCondition}).`);
          condition = stated;
        } else if (stated) {
          const msg = `the text says ${stated}, the shop default ${co.importCondition} was used`;
          if (rules.conditionTextAction === 'REVIEW') reviewWhy.push(`condition: ${msg}`);
          else notes.push(`Condition: ${msg}.`);
        }
        // Claims kept in REVIEW mode: hold for a person.
        if (rules.claimMode === 'REVIEW') {
          const found = [
            ...cleanSupplierHtmlDetailed(w.description, supplier, rules.detect).removed,
            ...cleanSupplierHtmlDetailed(w.short_description, supplier, rules.detect).removed,
          ].filter((r) => r.reason === 'CLAIM');
          if (found.length) reviewWhy.push(`supplier claims kept in the text (e.g. “${found[0].text.slice(0, 80)}”)`);
        }
        const cleanedNote = removedNote(src.removed, !opts.dryRun);
        if (cleanedNote) {
          notes.push(cleanedNote);
          counts.textsCleaned++;
        }
        let status = statusForNew(src, policy);
        const mappingReview = rules.unmappedAction === 'REVIEW' || reviewWhy.some((r) => !/^brand|^category/.test(r));
        if (status === 'PUBLISHED' && reviewWhy.length && mappingReview) {
          status = 'PENDING_REVIEW';
          counts.heldForReview++;
        }
        if (status !== 'PUBLISHED') {
          // The reasons are listed once, as the item's review line (ReportItem.review).
          if (src.placeholderTitle) notes.push('No name at the source — waiting for review.');
          else if (!reviewWhy.length) notes.push('Waiting for review (this shop does not auto-publish imports).');
        } else if (reviewWhy.length) {
          notes.push(`Published without: ${reviewWhy.join('; ')}.`);
        }
        const quantity = targetQuantity(src, policy, 0);
        const createdChanges: FieldChange[] = [
          { field: 'status', from: null, to: status },
          { field: 'priceCents', from: null, to: src.priceCents },
          { field: 'quantity', from: null, to: quantity },
          { field: 'condition', from: null, to: condition },
          { field: 'brand', from: null, to: brand.brand ?? '— (not recognised)' },
          { field: 'category', from: null, to: catSlug ? category.name : `${category.name} (no rule matched)` },
        ];
        if (src.availability === 'onbackorder') createdChanges.push({ field: 'sourceAvailability', from: null, to: 'onbackorder' });
        if (opts.dryRun) {
          items.push({
            action: 'CREATED', externalId: src.externalId, slug, title: src.title, currency: src.currency,
            changes: previewChanges([...createdChanges, { field: 'images', from: null, to: `${src.imageUrls.length} photo(s) to copy` }]),
            notes: notes.length ? notes : undefined,
            review: reviewWhy.length ? reviewWhy : undefined,
          });
          counts.created++;
          continue;
        }
        const loc = await localizeImageList(src.imageUrls);
        counts.imagesDownloaded += loc.downloaded;
        counts.imageFailures += loc.failures.length;
        for (const f of loc.failures) notes.push(`Photo not copied (${f.error}); hidden from buyers until a retry succeeds.`);
        const created = await prisma.product.create({
          data: {
            slug,
            title: src.title,
            summary: src.summary,
            description: src.description,
            condition,
            mode: modeForNew(src),
            status,
            priceCents: src.priceCents,
            currency: src.currency,
            quantity,
            images: loc.images,
            hasImages: publicProductImages(loc.images).length > 0,
            // A drawing only when one fits the category (never a balance for a motor).
            illustration: illustrationForCategory(catSlug),
            sku: src.sku,
            mpn: src.mpn,
            categoryId: category.id,
            brandId,
            sellerId,
            companyId: co.id,
            externalSource: 'woo',
            externalId: src.externalId,
            sourceSlug: src.sourceSlug,
            sourceUrl: src.permalink && !(await prisma.product.findUnique({ where: { sourceUrl: src.permalink }, select: { id: true } })) ? src.permalink : null,
            sourceImageUrls: src.imageUrls,
            sourceAvailability: src.availability,
            lastSyncedAt: now,
          },
          select: { id: true },
        });
        counts.created++;
        items.push({
          action: 'CREATED', externalId: src.externalId, slug, title: src.title, productId: created.id, currency: src.currency,
          changes: previewChanges(createdChanges),
          notes: notes.length ? notes : undefined,
          review: reviewWhy.length ? reviewWhy : undefined,
        });
      } catch (e) {
        counts.failed++;
        items.push({ action: 'FAILED', externalId: src.externalId, slug: src.sourceSlug, title: src.title, error: e instanceof Error ? e.message.slice(0, 300) : 'failed' });
      }
    }

    // 4. Items gone from the source (full runs only).
    if (!only) {
      const importer = importerSellerId(co.slug);
      const tracked = locals.filter((l) => l.externalSource === 'woo' || (!l.externalId && l.sellerId === importer));
      const missing = tracked.filter((l) => !matched.has(l.id));
      const missingLive = missing.filter((l) => l.status !== 'ARCHIVED').length;
      const overLimit = archiveLooksUnsafe(missingLive, tracked.length, { stopBp: rules.archiveStopBp, allow: rules.archiveStopAllow });
      const unsafe = overLimit && !opts.allowMassArchive;
      if (unsafe) {
        const w = `Safety stop: ${missingLive} of ${tracked.length} imported items are no longer at the source — more than ${rules.archiveStopBp / 100} % (and more than ${rules.archiveStopAllow}). Nothing was archived. Check the source; if they really are gone, run the sync again with “archive beyond the safety stop” (Settings → Import & suppliers sets the limits).`;
        warnings.push(w);
        attention.push(w);
      } else if (overLimit) {
        warnings.push(`${missingLive} of ${tracked.length} imported items were no longer at the source — beyond the safety stop, archived because ${opts.actorEmail ?? 'an admin'} confirmed it for this run.`);
      }
      for (const l of missing) {
        if (unsafe) {
          if (l.status !== 'ARCHIVED') {
            items.push({ action: 'REMOVED_AT_SOURCE', externalId: l.externalId, slug: l.slug, title: l.title, productId: l.id, notes: ['Not at the source — NOT archived (safety stop, see warning).'] });
            counts.removedAtSource++;
          }
          continue;
        }
        const plan = planMissing(l, policy, now);
        if (!plan.changes.length) continue;
        if (!opts.dryRun) await prisma.product.update({ where: { id: l.id }, data: plan.data as Prisma.ProductUpdateInput });
        if (plan.archived) counts.archived++;
        else counts.removedAtSource++;
        items.push({
          action: plan.archived ? 'ARCHIVED' : 'REMOVED_AT_SOURCE', externalId: l.externalId, slug: l.slug, title: l.title, productId: l.id,
          changes: previewChanges(plan.changes), notes: plan.notes.length ? plan.notes : undefined,
        });
      }
    }

    if (counts.priceReviews) {
      attention.push(`${counts.priceReviews} supplier price change(s) ${opts.dryRun ? 'would wait' : 'wait'} for your review (Admin → Catalog → Price review).`);
    }
    if (counts.heldForReview) {
      attention.push(`${counts.heldForReview} new item(s) ${opts.dryRun ? 'would be' : 'were'} held for review — brand, category, condition or claims need a person (see the run report).`);
    }
    const status = counts.failed > 0 && counts.failed === sources.length ? 'FAILED' : 'SUCCEEDED';
    const message = [summarize(counts, opts.dryRun), ...warnings].join(' ');
    await prisma.importRun.update({
      where: { id: run.id },
      data: { status, finishedAt: new Date(), counts: { ...counts, warnings } as unknown as Prisma.InputJsonValue, items: items as unknown as Prisma.InputJsonValue },
    });
    if (!opts.dryRun) {
      await prisma.company.update({ where: { id: co.id }, data: { lastImportedAt: now, suggestedByAi: false } });
    }
    // Keep the newest N run reports per shop (Settings → Import & suppliers).
    const old = await prisma.importRun.findMany({
      where: { companyId: co.id },
      orderBy: { startedAt: 'desc' },
      skip: rules.reportsKeep,
      select: { id: true },
    });
    if (old.length) await prisma.importRun.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
    await prisma.auditLog.create({
      data: {
        actorEmail: opts.actorEmail ?? (opts.trigger === 'CRON' ? 'system:cron' : opts.trigger === 'CLI' ? 'system:cli' : null),
        action: opts.dryRun ? 'company.sync.dryrun' : 'company.sync',
        target: co.slug,
        meta: `run=${run.id} created=${counts.created} updated=${counts.updated} archived=${counts.archived} unchanged=${counts.unchanged} failed=${counts.failed} priceReviews=${counts.priceReviews} held=${counts.heldForReview}${opts.allowMassArchive ? ' allowMassArchive=1' : ''}${warnings.length ? ' safetyStop=1' : ''}`,
      },
    }).catch(() => {});
    return { ok: status === 'SUCCEEDED', runId: run.id, status, dryRun: opts.dryRun, message, counts, attention };
  } catch (e) {
    const err = e instanceof Error ? e.message.slice(0, 500) : 'sync failed';
    const wrote = !opts.dryRun && (counts.created + counts.updated + counts.archived) > 0;
    const message = `Sync failed: ${err.replace(/[.\s]+$/, '')}.${wrote ? ` ${counts.created + counts.updated + counts.archived} item(s) were already written before the failure — see the run report.` : ' Nothing was changed.'}`;
    await prisma.importRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), error: message, counts: counts as unknown as Prisma.InputJsonValue, items: items as unknown as Prisma.InputJsonValue },
    }).catch(() => {});
    return { ok: false, runId: run.id, status: 'FAILED', dryRun: opts.dryRun, message, counts, attention };
  }
}

export type { ImportSettings };
