/**
 * Inventory unit tests (no database). Run: npm run test:inventory
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, hasArabicScript, normalizeDigits, parseMoneyToCents, parseWholeNumber, formatCents } from '@/lib/inventory/text';
import { COLUMNS, isLow, marginOf, matchEnum, type InventoryRow } from '@/lib/inventory/fields';
import { copyText, parseTsv, sortIds, toTsv, matchesQuickFilter, matchesSearch } from '@/components/admin/inventory/grid-utils';
import { autoMapping, guessTarget, parseCsv, readUpload } from '@/lib/inventory/import';
import { buildCsv, buildXlsx, baseValues } from '@/lib/inventory/export';
import { defaultInventorySettings, parseSettingValue, validateSettingInput, inventorySettingDef } from '@/lib/inventory/settings';
import { parseFieldValue, sameValue } from '@/lib/inventory/write';
import { publicStockFor, liveWhereFor } from '@/lib/inventory/public';
import { orderReservesUnits } from '@/lib/inventory/stock';
import { orderHoldsStock } from '@/lib/orders/checkout-tx';
import { partNumberFromSpecs } from '@/lib/inventory/rows';
import { applyShopPricing } from '@/lib/shop-pricing';
import { unitsHeld } from '@/lib/inventory/units';

const fa = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d))); // Persian digits
const ar = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d))); // Arabic-Indic digits
const persianWord = String.fromCharCode(0x0633, 0x0644, 0x0627, 0x0645); // a Persian word (salam)

const row = (over: Partial<InventoryRow> = {}): InventoryRow => ({
  id: 'p1',
  slug: 'agilent-pump',
  image: null,
  sku: 'LTD-00001',
  mpn: 'G1312-60010',
  mpnFromSpecs: false,
  title: 'Agilent pump',
  brand: 'Agilent',
  category: 'Pumps & Fluidics',
  condition: 'USED',
  supplier: 'Lab closing Utrecht',
  costCents: 4000,
  onHand: 4,
  reserved: 1,
  available: 3,
  priceCents: 10000,
  priceInternal: false,
  currency: 'EUR',
  location: 'A-03-2',
  notes: null,
  lowStockAt: null,
  status: 'PUBLISHED',
  mode: 'BUY_NOW',
  shop: null,
  updatedAt: new Date(0).toISOString(),
  ...over,
});

test('Persian and Arabic digits become 0-9', () => {
  assert.equal(normalizeDigits(fa('1234')), '1234');
  assert.equal(normalizeDigits(ar('56')), '56');
  assert.equal(parseWholeNumber(fa('4')), 4);
  assert.equal(parseMoneyToCents(`${fa('12')}.${fa('50')}`), 1250);
  assert.equal(cleanText(`  A-${fa('03')}  `), 'A-03');
});

test('Persian/Arabic letters are detected, Latin and digits are not', () => {
  assert.equal(hasArabicScript(persianWord), true);
  assert.equal(hasArabicScript(normalizeDigits(fa('42'))), false);
  assert.equal(hasArabicScript('Agilent G1312-60010 Rev. A, Müller GmbH'), false);
});

test('money parsing accepts the usual ways people type amounts', () => {
  assert.equal(parseMoneyToCents('1250'), 125000);
  assert.equal(parseMoneyToCents('1250.5'), 125050);
  assert.equal(parseMoneyToCents('1,250.50'), 125050);
  assert.equal(parseMoneyToCents('1.250,50'), 125050);
  assert.equal(parseMoneyToCents('1250,50'), 125050);
  assert.equal(parseMoneyToCents('1,250'), 125000);
  assert.equal(parseMoneyToCents('€ 99'), 9900);
  assert.equal(parseMoneyToCents('99 EUR'), 9900);
  assert.equal(parseMoneyToCents(12.5), 1250);
  assert.equal(parseMoneyToCents(''), null);
  assert.ok(Number.isNaN(parseMoneyToCents('abc')));
  assert.ok(Number.isNaN(parseMoneyToCents('1.2.3,4')));
  assert.ok(Number.isNaN(parseMoneyToCents('10.123')) === false); // "10.123" = 10123 (thousands)
  assert.equal(formatCents(123456789), '1,234,567.89');
  assert.equal(formatCents(-5), '-0.05');
});

test('whole numbers', () => {
  assert.equal(parseWholeNumber('4'), 4);
  assert.equal(parseWholeNumber('4.0'), 4);
  assert.equal(parseWholeNumber(' '), null);
  assert.ok(Number.isNaN(parseWholeNumber('4.5')));
  assert.ok(Number.isNaN(parseWholeNumber('four')));
});

test('enum values match by code, label or common words', () => {
  assert.equal(matchEnum('condition', 'used'), 'USED');
  assert.equal(matchEnum('condition', 'Refurbished'), 'REFURBISHED');
  assert.equal(matchEnum('mode', 'Quote only'), 'QUOTE_ONLY');
  assert.equal(matchEnum('mode', 'Buy now + quote'), 'HYBRID');
  assert.equal(matchEnum('status', 'On site'), 'PUBLISHED');
  assert.equal(matchEnum('status', 'draft'), 'DRAFT');
  assert.equal(matchEnum('status', 'whatever'), undefined);
});

test('margin and low stock', () => {
  assert.deepEqual(marginOf(row()), { cents: 6000, pct: 60 });
  assert.deepEqual(marginOf(row({ costCents: null })), { cents: null, pct: null });
  assert.deepEqual(marginOf(row({ priceCents: 3000 })), { cents: -1000, pct: -33.3 });
  assert.equal(isLow(row({ available: 0 }), 0), true);
  assert.equal(isLow(row({ available: 3 }), 0), false);
  assert.equal(isLow(row({ available: 3, lowStockAt: 3 }), 0), true);
});

test('field parsing applies the language rule from settings', () => {
  const s = defaultInventorySettings();
  assert.deepEqual(parseFieldValue('onHand', fa('4'), s), { ok: true, value: 4 });
  assert.equal(parseFieldValue('onHand', '', s).ok, false);
  assert.equal(parseFieldValue('onHand', '-1', s).ok, false);
  assert.deepEqual(parseFieldValue('priceCents', '1.250,00', s), { ok: true, value: 125000 });
  assert.equal(parseFieldValue('title', persianWord, s).ok, false);
  assert.equal(parseFieldValue('notes', persianWord, s).ok, false); // default "all"
  const pub = { ...s, INVENTORY_LATIN_ONLY: 'public' as const };
  assert.equal(parseFieldValue('notes', persianWord, pub).ok, true);
  assert.equal(parseFieldValue('title', persianWord, pub).ok, false);
  const off = { ...s, INVENTORY_LATIN_ONLY: 'off' as const };
  assert.equal(parseFieldValue('title', `Pump ${persianWord}`, off).ok, true);
  assert.deepEqual(parseFieldValue('mode', 'quote only', s), { ok: true, value: 'QUOTE_ONLY' });
  assert.deepEqual(parseFieldValue('supplier', '', s), { ok: true, value: null });
  assert.equal(parseFieldValue('title', '', s).ok, false);
  assert.equal(sameValue('supplier', 'Acme', 'acme '), true);
  assert.equal(sameValue('priceCents', 100, '100'), true);
  assert.equal(sameValue('notes', null, ''), true);
});

test('settings: stored values are validated, bad ones fall back to the default', () => {
  const zero = inventorySettingDef('INVENTORY_ZERO_STOCK')!;
  assert.equal(parseSettingValue(zero, 'hide'), 'hide');
  assert.equal(parseSettingValue(zero, 'nonsense'), undefined);
  const digits = inventorySettingDef('INVENTORY_SKU_DIGITS')!;
  assert.deepEqual(validateSettingInput(digits, '5'), { value: '5' });
  assert.ok('error' in validateSettingInput(digits, '0'));
  const prefix = inventorySettingDef('INVENTORY_SKU_PREFIX')!;
  assert.ok('error' in validateSettingInput(prefix, 'LTD /'));
  const mail = inventorySettingDef('INVENTORY_LOW_STOCK_EMAIL_TO')!;
  assert.ok('error' in validateSettingInput(mail, 'not-an-email'));
  assert.equal(defaultInventorySettings().INVENTORY_ZERO_STOCK, 'label');
});

test('public stock rules follow the settings', () => {
  const s = defaultInventorySettings();
  assert.deepEqual(liveWhereFor({ INVENTORY_ZERO_STOCK: 'label' }), { status: 'PUBLISHED' });
  assert.deepEqual(liveWhereFor({ INVENTORY_ZERO_STOCK: 'hide' }), { status: 'PUBLISHED', quantity: { gt: 0 } });
  assert.equal(publicStockFor(0, s).inStock, false);
  assert.equal(publicStockFor(0, s).hidePage, false);
  assert.equal(publicStockFor(0, { ...s, INVENTORY_ZERO_STOCK: 'unpublish' }).hidePage, true);
  assert.equal(publicStockFor(2, s).qtyText, null);
  assert.equal(publicStockFor(2, { ...s, INVENTORY_PUBLIC_QTY: 'low', INVENTORY_PUBLIC_LOW_AT: 3 }).qtyText, 'Only 2 left');
  assert.equal(publicStockFor(5, { ...s, INVENTORY_PUBLIC_QTY: 'low', INVENTORY_PUBLIC_LOW_AT: 3 }).qtyText, null);
  assert.equal(publicStockFor(5, { ...s, INVENTORY_PUBLIC_QTY: 'exact' }).qtyText, '5 in stock');
  assert.equal(publicStockFor(0, { ...s, INVENTORY_OOS_LABEL: 'Sold out' }).outLabel, 'Sold out');
});

test('a quote-only listing never shows a price', () => {
  const d = applyShopPricing({ priceCents: 50000, currency: 'EUR', mode: 'QUOTE_ONLY' }, null);
  assert.equal(d.priceCents, null);
  assert.equal(d.priceHidden, true);
  assert.equal(applyShopPricing({ priceCents: 50000, currency: 'EUR', mode: 'BUY_NOW' }, null).priceCents, 50000);
});

test('"reserved" counts exactly the orders that took stock and have not shipped', () => {
  const statuses = ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELED', 'REFUNDED'];
  for (const sourcingRequestId of [null, 'quote1']) {
    for (const status of statuses) {
      const o = { sourcingRequestId, status };
      const reserved = orderReservesUnits(o);
      // Reserved implies the order holds stock (never count a unit that is still on Product.quantity).
      if (reserved) assert.equal(orderHoldsStock(o), true, `${status}/${sourcingRequestId}`);
      // A held, unshipped unit is reserved (otherwise On hand would drop before shipping).
      if (orderHoldsStock(o) && ['PENDING_PAYMENT', 'PAID', 'PROCESSING'].includes(status) && !(sourcingRequestId && status === 'PENDING_PAYMENT')) {
        assert.equal(reserved, true, `${status}/${sourcingRequestId}`);
      }
    }
  }
  assert.equal(orderReservesUnits({ sourcingRequestId: 'q', status: 'PENDING_PAYMENT' }), false); // unpaid proforma
});

test('Excel clipboard: TSV with quotes, tabs and newlines round-trips', () => {
  const cells = [['A', 'two\nlines', 'tab\there'], ['say "hi"', '', '3']];
  assert.deepEqual(parseTsv(toTsv(cells)), cells);
  assert.deepEqual(parseTsv('1\t2\r\n3\t4\r\n'), [['1', '2'], ['3', '4']]);
  assert.equal(copyText(row(), 'priceCents'), '100.00');
  assert.equal(copyText(row(), 'condition'), 'Used');
  assert.equal(copyText(row(), 'margin'), '60.00');
});

test('sorting keeps empty values last and ties stable; filters and search', () => {
  const rows = [row({ id: 'a', priceCents: 300 }), row({ id: 'b', priceCents: null }), row({ id: 'c', priceCents: 100 }), row({ id: 'd', priceCents: 300 })];
  const map = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual(sortIds(['a', 'b', 'c', 'd'], map, { key: 'priceCents', dir: 'asc' }), ['c', 'a', 'd', 'b']);
  assert.deepEqual(sortIds(['a', 'b', 'c', 'd'], map, { key: 'priceCents', dir: 'desc' }), ['a', 'd', 'c', 'b']);
  const opts = { lowDefault: 0, minMarginPct: 20, canCost: true };
  assert.equal(matchesQuickFilter(row({ available: 0 }), 'out', opts), true);
  assert.equal(matchesQuickFilter(row({ costCents: null }), 'nocost', opts), true);
  assert.equal(matchesQuickFilter(row({ costCents: null }), 'nocost', { ...opts, canCost: false }), false);
  assert.equal(matchesQuickFilter(row({ priceCents: 4500 }), 'lowmargin', opts), true); // 11 % < 20 %
  assert.equal(matchesSearch(row(), 'a-03 agilent'), true);
  assert.equal(matchesSearch(row(), 'waters'), false);
});

test('column mapping recognises our export, products.csv and other spreadsheets', () => {
  assert.deepEqual(autoMapping(['photos', 'title', 'category', 'brand', 'condition', 'mode', 'price_eur', 'quantity', 'year', 'summary', 'description', 'specs']), [
    'ignore', 'title', 'category', 'brand', 'condition', 'mode', 'priceCents', 'onHand', 'year', 'summary', 'description', 'specs',
  ]);
  assert.equal(guessTarget('Purchase cost'), 'costCents');
  assert.equal(guessTarget('Supplier price'), 'costCents');
  assert.equal(guessTarget('ID (do not edit)'), 'id');
  assert.equal(guessTarget('Shelf / bin'), 'location');
  assert.equal(guessTarget('Reserved'), 'ignore');
  assert.equal(guessTarget('Something else'), 'ignore');
  // A second column for the same field is ignored, not merged.
  assert.deepEqual(autoMapping(['Qty', 'Quantity']), ['onHand', 'ignore']);
});

test('CSV reading: delimiter detection, quotes, BOM', () => {
  const bom = String.fromCharCode(0xfeff);
  assert.deepEqual(parseCsv(`${bom}a;b\r\n"x;y";2\r\n`), [['a', 'b'], ['x;y', '2']]);
  assert.deepEqual(parseCsv('a,b\n"he said ""no""",1'), [['a', 'b'], ['he said "no"', '1']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('part number from the listing specs', () => {
  assert.equal(partNumberFromSpecs({ 'Part number': 'N291-9044', Board: 'INTFC BD' }), 'N291-9044');
  assert.equal(partNumberFromSpecs({ Display: 'Hantronix' }), null);
  assert.equal(partNumberFromSpecs(null), null);
});

test('Excel export -> import keeps every value and the hidden base copy', async () => {
  const rows = [row(), row({ id: 'p2', slug: 'b', sku: null, title: 'Waters panel', costCents: null, priceCents: null, mode: 'QUOTE_ONLY', priceInternal: true, notes: 'line1' })];
  const buf = await buildXlsx(rows, { canCost: true, suppliers: ['Lab closing Utrecht'], categories: ['Pumps & Fluidics'], siteUrl: 'https://labtodate.com', exportedBy: 'qa@labtodate.com' });
  const sheet = await readUpload('x.xlsx', buf);
  assert.equal(sheet.format, 'xlsx');
  assert.equal(sheet.headers[0], 'SKU');
  assert.equal(sheet.headers[sheet.headers.length - 1], 'ID (do not edit)');
  assert.equal(sheet.rows.length, 2);
  const at = (h: string) => sheet.headers.indexOf(h);
  assert.equal(sheet.rows[0][at('Purchase cost')], 40);
  assert.equal(sheet.rows[0][at('Selling price')], 100);
  assert.equal(sheet.rows[0][at('Available')], 3); // formula result
  assert.equal(sheet.rows[0][at('Condition')], 'Used');
  assert.equal(sheet.rows[1][at('Sale mode')], 'Quote only');
  assert.deepEqual(sheet.base?.get('p1'), baseValues(rows[0], true));
  const mapping = autoMapping(sheet.headers);
  assert.equal(mapping[at('ID (do not edit)')], 'id');
  assert.equal(mapping[at('Reserved')], 'ignore');
  assert.equal(mapping[at('Margin')], 'ignore');
});

test('export without the cost permission has no cost or margin columns', async () => {
  const buf = await buildXlsx([row()], { canCost: false, suppliers: [], categories: [], siteUrl: 'https://labtodate.com', exportedBy: null });
  const sheet = await readUpload('x.xlsx', buf);
  for (const h of ['Purchase cost', 'Margin', 'Margin %']) assert.equal(sheet.headers.includes(h), false, h);
  assert.equal('costCents' in (sheet.base?.get('p1') ?? {}), false);
  const csv = buildCsv([row()], { canCost: false, siteUrl: 'https://labtodate.com' });
  assert.equal(/Purchase cost|Margin/.test(csv), false);
});

test('CSV export -> import round trip', async () => {
  const csv = buildCsv([row({ title: 'Pump, "big"' })], { canCost: true, siteUrl: 'https://labtodate.com' });
  const sheet = await readUpload('x.csv', Buffer.from(csv, 'utf8'));
  assert.equal(sheet.rows[0][sheet.headers.indexOf('Name')], 'Pump, "big"');
  assert.equal(sheet.rows[0][sheet.headers.indexOf('Selling price')], '100.00');
  assert.equal(COLUMNS.filter((c) => c.editable).every((c) => sheet.headers.includes(c.header)), true);
});

test('a cancel or refund gives back what the line took', () => {
  assert.equal(unitsHeld({ quantity: 2, stockTaken: 1 }), 1);
  assert.equal(unitsHeld({ quantity: 2, stockTaken: 0 }), 0);
  assert.equal(unitsHeld({ quantity: 2, stockTaken: null }), 2); // older lines: as before
  assert.equal(unitsHeld({ quantity: 2 }), 2);
});
