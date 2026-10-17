import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRICE_REVIEW,
  needsPriceReview,
  archiveLooksUnsafe,
  cleanSlug,
  planExisting,
  planMissing,
  slugCandidates,
  statusForNew,
  targetQuantity,
  type LocalState,
  type ShopSyncPolicy,
  type SourceItem,
} from '../../src/lib/marketplace/woo-sync-plan';
import { parseWooProduct } from '../../src/lib/marketplace/woo-parse';

const policy = (over: Partial<ShopSyncPolicy> = {}): ShopSyncPolicy => ({
  syncPolicy: 'PRICE_STOCK_ONLY',
  syncStockMode: 'SUBTRACT_LOCAL_SALES',
  autoPublishImports: false,
  archiveMissingAtSource: true,
  importDefaultQuantity: 1,
  ...over,
});

const src = (over: Partial<SourceItem> = {}): SourceItem => ({
  externalId: '4937',
  sourceSlug: 'agilent-g3170-65015-sideboard',
  permalink: 'https://shop.example/p/4937',
  title: 'Agilent G3170-65015 Sideboard',
  placeholderTitle: false,
  summary: 'Sideboard PCA',
  description: '<p>Sideboard PCA</p>',
  priceCents: 50000,
  currency: 'EUR',
  imageUrls: ['https://shop.example/a.jpg'],
  sku: null,
  mpn: null,
  inStock: true,
  sourceQty: null,
  availability: 'instock',
  ...over,
});

const local = (over: Partial<LocalState> = {}): LocalState => ({
  id: 'p1',
  slug: 'agilent-g3170-65015-sideboard',
  title: 'Agilent G3170-65015 Sideboard',
  summary: 'Sideboard PCA',
  description: '<p>Sideboard PCA</p>',
  priceCents: 50000,
  currency: 'EUR',
  mode: 'HYBRID',
  quantity: 1,
  status: 'PUBLISHED',
  sku: null,
  mpn: null,
  lockedFields: [],
  externalId: '4937',
  externalSource: 'woo',
  sourceSlug: 'agilent-g3170-65015-sideboard',
  sourceUrl: 'https://shop.example/p/4937',
  sourceAvailability: 'instock',
  sourceImageUrls: ['https://shop.example/a.jpg'],
  removedAtSourceAt: null,
  committedUnits: 0,
  ...over,
});

test('sold at the source → not available here', () => {
  const plan = planExisting(local(), src({ inStock: false, sourceQty: 0, availability: 'outofstock' }), policy());
  assert.equal(plan.data.quantity, 0);
  assert.equal(plan.data.sourceAvailability, 'outofstock');
});

test('stock: lab2date sales the supplier does not know about are subtracted', () => {
  assert.equal(targetQuantity(src(), policy(), 1), 0);
  assert.equal(targetQuantity(src({ sourceQty: 3 }), policy(), 1), 2);
  assert.equal(targetQuantity(src({ sourceQty: 3 }), policy({ syncStockMode: 'SOURCE_IS_TRUTH' }), 1), 3);
  assert.equal(targetQuantity(src(), policy({ importDefaultQuantity: 4 }), 0), 4);
  // "in stock" without a number: keep what we know (owner set 2), never invent
  assert.equal(targetQuantity(src(), policy(), 0, 2), 2);
  assert.equal(targetQuantity(src(), policy(), 1, 0), 0, 'sold here, still listed there → held at 0');
  assert.equal(targetQuantity(src(), policy(), 0, 0), 1, 'back in stock at the source → shop default');
  assert.equal(targetQuantity(src({ inStock: false, sourceQty: 0 }), policy(), 0, 5), 0);
  const plan = planExisting(local({ quantity: 0, committedUnits: 1 }), src(), policy());
  assert.equal(plan.data.quantity, undefined, 'stays at 0, not re-listed');
  assert.ok(plan.notes.some((n) => n.includes('already sold on lab2date')));
});

test('price follows the source unless the admin locked it', () => {
  const moved = planExisting(local(), src({ priceCents: 61000 }), policy());
  assert.equal(moved.data.priceCents, 61000, '+22 % is within the default 50 % rise threshold');
  assert.equal(moved.priceReview, null);
  const locked = planExisting(local({ lockedFields: ['price'], priceCents: 70000 }), src({ priceCents: 61000 }), policy());
  assert.equal(locked.data.priceCents, undefined);
  assert.deepEqual(locked.skipped, [{ field: 'price', reason: 'locked' }]);
});

test('price disappears at the source → quote-only; price back → buyable again', () => {
  const gone = planExisting(local(), src({ priceCents: null }), policy());
  assert.equal(gone.data.priceCents, null);
  assert.equal(gone.data.mode, 'QUOTE_ONLY');
  const back = planExisting(local({ priceCents: null, mode: 'QUOTE_ONLY' }), src(), policy());
  assert.equal(back.data.mode, 'HYBRID');
});

test('PRICE_STOCK_ONLY never touches curated content', () => {
  const plan = planExisting(local({ title: 'Curated title' }), src({ title: 'Supplier rename', imageUrls: ['https://shop.example/new.jpg'] }), policy());
  assert.equal(plan.data.title, undefined);
  assert.equal(plan.replaceImages, false);
  assert.ok(plan.skipped.some((s) => s.field === 'title' && s.reason === 'policy'));
  assert.ok(plan.skipped.some((s) => s.field === 'images' && s.reason === 'policy'));
});

test('CONTENT_TOO updates content but never a locked field', () => {
  const p = policy({ syncPolicy: 'CONTENT_TOO' });
  const plan = planExisting(local({ lockedFields: ['title'] }), src({ title: 'Supplier rename', summary: 'New summary' }), p);
  assert.equal(plan.data.title, undefined);
  assert.equal(plan.data.summary, 'New summary');
  assert.ok(plan.skipped.some((s) => s.field === 'title' && s.reason === 'locked'));
  const imgs = planExisting(local(), src({ imageUrls: ['https://shop.example/new.jpg'] }), p);
  assert.equal(imgs.replaceImages, true);
  const placeholder = planExisting(local(), src({ title: 'Product 4937', placeholderTitle: true }), p);
  assert.equal(placeholder.data.title, undefined);
});

test('a sync never publishes, un-archives or re-publishes', () => {
  for (const status of ['DRAFT', 'PENDING_REVIEW', 'ARCHIVED'] as const) {
    const plan = planExisting(local({ status }), src(), policy());
    assert.equal(plan.data.status, undefined);
  }
  const back = planExisting(local({ status: 'ARCHIVED', removedAtSourceAt: new Date(), quantity: 0 }), src(), policy());
  assert.equal(back.data.status, undefined);
  assert.equal(back.data.removedAtSourceAt, null);
  assert.ok(back.notes.some((n) => n.includes('stays ARCHIVED')));
});

test('legacy row matched by slug records its source identity', () => {
  const plan = planExisting(local({ externalId: null, externalSource: null }), src(), policy(), { adopt: true });
  assert.equal(plan.data.externalId, '4937');
  assert.equal(plan.data.externalSource, 'woo');
});

test('empty identifiers are enriched, never overwritten', () => {
  assert.equal(planExisting(local(), src({ sku: 'S-1' }), policy()).data.sku, 'S-1');
  assert.equal(planExisting(local({ sku: 'MINE' }), src({ sku: 'S-1' }), policy()).data.sku, undefined);
});

test('removed at the source → archived (or kept as not available per shop policy)', () => {
  const now = new Date('2026-10-03T10:00:00Z');
  const a = planMissing({ status: 'PUBLISHED', quantity: 1, sourceAvailability: 'instock', removedAtSourceAt: null }, policy(), now);
  assert.equal(a.archived, true);
  assert.equal(a.data.status, 'ARCHIVED');
  assert.equal(a.data.quantity, 0);
  assert.equal(a.data.removedAtSourceAt, now);
  const keep = planMissing({ status: 'PUBLISHED', quantity: 1, sourceAvailability: 'instock', removedAtSourceAt: null }, policy({ archiveMissingAtSource: false }), now);
  assert.equal(keep.archived, false);
  assert.equal(keep.data.status, undefined);
  assert.equal(keep.data.quantity, 0);
});

test('new imports wait for review unless the shop auto-publishes', () => {
  assert.equal(statusForNew(src(), policy()), 'PENDING_REVIEW');
  assert.equal(statusForNew(src(), policy({ autoPublishImports: true })), 'PUBLISHED');
  assert.equal(statusForNew(src({ placeholderTitle: true }), policy({ autoPublishImports: true })), 'PENDING_REVIEW');
});

test('clean, namespaced slugs', () => {
  assert.equal(cleanSlug('agilent-g1314-60086-flow-cell-14-%c2%b5l-for-vwd'), 'agilent-g1314-60086-flow-cell-14-ul-for-vwd');
  assert.equal(cleanSlug('Thermo%20Fisher_Orbitrap!!'), 'thermo-fisher-orbitrap');
  const c = slugCandidates('agilent-pump', 'lab2parts', '77');
  assert.deepEqual(c, ['agilent-pump', 'lab2parts-agilent-pump', 'lab2parts-agilent-pump-77']);
});

test('mass-archive safety stop is proportional and configurable', () => {
  assert.equal(archiveLooksUnsafe(0, 800), false);
  assert.equal(archiveLooksUnsafe(30, 800), false);
  assert.equal(archiveLooksUnsafe(300, 800), true);
  assert.equal(archiveLooksUnsafe(21, 40), true);
  // The verifier's case: 7 of a 10-item shop gone in one run → stop (no 20-item floor).
  assert.equal(archiveLooksUnsafe(7, 10), true);
  assert.equal(archiveLooksUnsafe(2, 10), false, 'a couple of sold units always pass');
  // lab2nl (241 items): 72 missing used to pass the old max(20, 30 %) rule.
  assert.equal(archiveLooksUnsafe(72, 241), true);
  assert.equal(archiveLooksUnsafe(20, 241), false);
  // Owner settings: 50 % / allow 0.
  assert.equal(archiveLooksUnsafe(4, 10, { stopBp: 5000, allow: 0 }), false);
  assert.equal(archiveLooksUnsafe(6, 10, { stopBp: 5000, allow: 0 }), true);
  assert.equal(archiveLooksUnsafe(1, 1, { stopBp: 5000, allow: 0 }), true);
});

test('a large supplier price change waits for review instead of going live', () => {
  // EUR 12,500 → EUR 125 (−99 %): not applied, queued, listing held.
  const crash = planExisting(local({ priceCents: 1_250_000 }), src({ priceCents: 12_500 }), policy(), { now: new Date('2026-10-03T08:00:00Z') });
  assert.equal(crash.data.priceCents, undefined, 'the live price is not changed');
  assert.equal(crash.data.pendingPriceCents, 12_500);
  assert.equal(crash.data.pendingPriceCurrency, 'EUR');
  assert.equal(crash.data.priceOnHold, true);
  assert.ok(crash.data.pendingPriceAt instanceof Date);
  assert.ok(crash.priceReview && crash.priceReview.changeBp === -9900 && crash.priceReview.held);
  assert.ok(crash.notes.some((n) => /held for review/.test(n) && /−99 %/.test(n) && /cannot be bought/.test(n)), crash.notes.join(' | '));
  // A rise beyond the threshold too.
  const rise = planExisting(local({ priceCents: 10_000 }), src({ priceCents: 20_000 }), policy());
  assert.equal(rise.data.pendingPriceCents, 20_000);
  assert.equal(rise.data.priceCents, undefined);
  // Configurable: 10 % drop threshold, keep selling meanwhile.
  const keep = planExisting(local({ priceCents: 10_000 }), src({ priceCents: 8_500 }), policy(), { review: { dropBp: 1000, riseBp: 1000, hold: false } });
  assert.equal(keep.data.pendingPriceCents, 8_500);
  assert.equal(keep.data.priceOnHold, undefined, 'not held: still sold at the current price');
  assert.ok(keep.notes.some((n) => /still sold at the current price/.test(n)));
  // A currency switch always needs a person.
  const cur = planExisting(local({ priceCents: 10_000 }), src({ priceCents: 10_000, currency: 'USD' }), policy());
  assert.equal(cur.data.pendingPriceCurrency, 'USD');
  assert.equal(cur.data.currency, undefined);
  // The same change seen again is not queued twice.
  const again = planExisting(local({ priceCents: 1_250_000, pendingPriceCents: 12_500, pendingPriceCurrency: 'EUR', priceOnHold: true }), src({ priceCents: 12_500 }), policy());
  assert.equal(Object.keys(again.data).filter((k) => k.startsWith('pending') || k === 'priceOnHold').length, 0);
  assert.ok(again.priceReview?.alreadyQueued);
  // The source goes back to our price → the pending change and the hold are dropped.
  const back = planExisting(local({ priceCents: 1_250_000, pendingPriceCents: 12_500, pendingPriceCurrency: 'EUR', priceOnHold: true }), src({ priceCents: 1_250_000 }), policy());
  assert.equal(back.data.pendingPriceCents, null);
  assert.equal(back.data.priceOnHold, false);
  // A locked price is never queued.
  const locked = planExisting(local({ priceCents: 1_250_000, lockedFields: ['price'] }), src({ priceCents: 12_500 }), policy());
  assert.equal(locked.data.pendingPriceCents, undefined);
  assert.equal(needsPriceReview({ cents: 10_000, currency: 'EUR' }, { cents: 7_000, currency: 'EUR' }, DEFAULT_PRICE_REVIEW), false, '−30 % is not more than 30 %');
  assert.equal(needsPriceReview({ cents: 10_000, currency: 'EUR' }, { cents: 6_999, currency: 'EUR' }, DEFAULT_PRICE_REVIEW), true);
  assert.equal(needsPriceReview({ cents: null, currency: 'EUR' }, { cents: 6_999, currency: 'EUR' }, DEFAULT_PRICE_REVIEW), false, 'a first price is not a change');
});

test('imported texts lose supplier claims, other prices and cross-sell tails — and keep the technical text', () => {
  const supplier = { name: 'V1 Mock Shop', urls: ['http://127.0.0.1:4677'] };
  const base = { id: 9101, name: 'Agilent G7111B pump', slug: 'g7111b', prices: { price: '450000', currency_code: 'EUR', currency_minor_unit: 2 } };
  const a = parseWooProduct({
    ...base,
    short_description: '<p>Quaternary pump, complete with degasser.</p>',
    description: '<p>Agilent G7111B quaternary pump. All our products are tested by our own engineers and delivered with warranty for 3 months. Visit our webshop V1 Mock Shop for more.</p><p>Prices from: 17.500 euro (please ask for official quote)</p><p>Also available:</p><ul><li>Agilent 1260 DAD</li></ul>',
  }, supplier);
  assert.equal(a.description, '<p>Agilent G7111B quaternary pump.</p>', 'only the sales sentences go');
  assert.equal(a.summary, 'Quaternary pump, complete with degasser.');
  const reasons = (a.removed ?? []).map((r) => r.reason).sort();
  assert.deepEqual(reasons, ['CLAIM', 'CROSS_SELL', 'CROSS_SELL', 'PRICE', 'SUPPLIER']);
  // A short description that is only a claim leaves no summary, and nothing else.
  const b = parseWooProduct({ ...base, short_description: '<p>Comes with 6 month warranty.</p>', description: '<p><b>All our products are tested by our own engineers and delivered with warranty for 3 months.</b></p>' }, supplier);
  assert.equal(b.description, null);
  assert.equal(b.summary, null);
  // The owner can switch claim removal off (REVIEW mode): the text stays.
  const kept = parseWooProduct({ ...base, description: '<p>Pump. Comes with 6 month warranty.</p>' }, supplier, { clean: { claims: null, tails: null, stripPrices: true } });
  assert.equal(kept.description, '<p>Pump. Comes with 6 month warranty.</p>');
  // A one-word claim inside a technical sentence loses only that word.
  const c = parseWooProduct({ ...base, description: '<h4>For sale: used Agilent G2597-65256 DEI pulser assembly, 1G, tested, for liquid chromatography</h4>' }, supplier);
  assert.equal(c.description, '<h4>For sale: used Agilent G2597-65256 DEI pulser assembly, 1G, for liquid chromatography</h4>');
  // A price in the short description never reaches the summary (meta description, JSON-LD).
  const d = parseWooProduct({ ...base, short_description: '<p>Agilent /HP 7694 Headspace sampler € 4,500.00</p><p>For sale: Agilent G1888 Headspace sampler</p>' }, supplier);
  assert.equal(d.summary, 'For sale: Agilent G1888 Headspace sampler');
});

test('Woo Store API parsing: stock, backorder, variable products, MPN attribute', () => {
  const supplier = { name: 'Lab2Parts', urls: ['https://lab2parts.com'] };
  const base = {
    id: 9, name: 'Agilent <b>G1311B</b>', slug: 'agilent-g1311b', permalink: 'https://lab2parts.com/p/9',
    short_description: '<p>Quaternary pump</p>', description: '<p>Full spec sheet</p>',
    prices: { price: '125000', currency_code: 'EUR', currency_minor_unit: 2 },
    images: [{ src: 'https://lab2parts.com/a.jpg' }],
    is_in_stock: true, low_stock_remaining: null, stock_availability: { class: 'in-stock' }, add_to_cart: { maximum: 9999 },
    attributes: [{ name: 'Part number', terms: [{ name: 'G1311-60001' }] }],
  };
  const a = parseWooProduct(base, supplier);
  assert.equal(a.title, 'Agilent G1311B');
  assert.equal(a.priceCents, 125000);
  assert.equal(a.inStock, true);
  assert.equal(a.sourceQty, null, '9999 = stock not managed');
  assert.equal(a.mpn, 'G1311-60001');
  assert.equal(a.description, '<p>Full spec sheet</p>', 'long description kept');
  assert.equal(parseWooProduct({ ...base, add_to_cart: { maximum: 3 } }, supplier).sourceQty, 3);
  const out = parseWooProduct({ ...base, is_in_stock: false, stock_availability: { class: 'out-of-stock' } }, supplier);
  assert.equal(out.inStock, false);
  assert.equal(out.availability, 'outofstock');
  const back = parseWooProduct({ ...base, is_on_backorder: true, stock_availability: { class: 'on-backorder' } }, supplier);
  assert.equal(back.inStock, false);
  assert.equal(back.availability, 'onbackorder');
  // SYNC_BACKORDER_MODE = SELLABLE: buyable, still marked as a backorder.
  const sellable = parseWooProduct({ ...base, is_on_backorder: true, stock_availability: { class: 'on-backorder' } }, supplier, { backorderSellable: true });
  assert.equal(sellable.inStock, true);
  assert.equal(sellable.availability, 'onbackorder');
  assert.equal(sellable.sourceQty, null);
  assert.equal(parseWooProduct({ ...base, type: 'variable' }, supplier).priceCents, null);
  const unnamed = parseWooProduct({ ...base, name: '' }, supplier);
  assert.equal(unnamed.placeholderTitle, true);
  assert.equal(unnamed.title, 'Product 9');
});
