/**
 * Inventory tests against a real Postgres. DESTRUCTIVE: wipes the database.
 * Refuses to run unless the database name ends in "_test".
 *
 *   DATABASE_URL=postgresql://.../lab2date_inv_test npx prisma migrate deploy
 *   DATABASE_URL=postgresql://.../lab2date_inv_test npm run test:inventory:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prisma } from '@/lib/db';
import { applyInventoryChanges, assignMissingSkus, type WriteContext } from '@/lib/inventory/write';
import { loadInventoryRows } from '@/lib/inventory/rows';
import { defaultInventorySettings, type InventorySettings } from '@/lib/inventory/settings';
import { buildXlsx } from '@/lib/inventory/export';
import { applyPreview, autoMapping, buildPreview, getStoredPreview, readUpload } from '@/lib/inventory/import';
import { reservedByProduct } from '@/lib/inventory/stock';
import ExcelJS from 'exceljs';

const url = process.env.DATABASE_URL ?? '';
const dbName = /\/([^/?]+)(\?|$)/.exec(url.replace(/^postgres(ql)?:\/\/[^/]+/, ''))?.[1] ?? '';
if (!dbName.endsWith('_test')) {
  throw new Error(`Refusing to run: DATABASE_URL must point at a database whose name ends in _test (got "${dbName}").`);
}

const settings = (over: Partial<InventorySettings> = {}): InventorySettings => ({ ...defaultInventorySettings(), ...over });
const ctx = (over: Partial<WriteContext> = {}): WriteContext => ({
  actorEmail: 'qa.inv.owner@labtodate.com',
  source: 'GRID',
  canCost: true,
  canApprove: true,
  settings: settings(),
  ...over,
});

let A = '';
let B = '';
let sellerId = '';
let buyerId = '';
let catId = '';

async function row(id: string) {
  const [r] = await loadInventoryRows({ ids: [id], canCost: true });
  return r;
}

before(async () => {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
  const seller = await prisma.user.create({ data: { id: 'u_owner', email: 'qa.inv.owner@labtodate.com', name: 'Owner', role: 'ADMIN', adminCaps: ['*'], emailVerified: true } });
  const buyer = await prisma.user.create({ data: { id: 'u_buyer', email: 'qa.inv.buyer@labtodate.com', name: 'Buyer', role: 'BUYER', emailVerified: true } });
  sellerId = seller.id;
  buyerId = buyer.id;
  for (const [slug, name] of [['pumps-fluidics', 'Pumps & Fluidics'], ['parts-modules-consumables', 'Parts, Modules & Consumables'], ['detectors', 'Detectors']]) {
    const c = await prisma.category.create({ data: { slug, name } });
    if (!catId) catId = c.id;
  }
  await prisma.brand.create({ data: { slug: 'agilent', name: 'Agilent' } });
  const a = await prisma.product.create({ data: { slug: 'pump-a', title: 'Agilent pump A', categoryId: catId, sellerId, mode: 'BUY_NOW', status: 'PUBLISHED', priceCents: 10000, quantity: 3, images: [] } });
  const b = await prisma.product.create({
    data: { slug: 'board-b', title: 'PerkinElmer board B', categoryId: catId, sellerId, mode: 'QUOTE_ONLY', status: 'PUBLISHED', priceCents: null, quantity: 1, images: [], specs: { 'Part number': 'N291-9044' } },
  });
  A = a.id;
  B = b.id;
});

after(async () => {
  await prisma.$disconnect();
});

test('first edit creates the private record, assigns a SKU and logs history', async () => {
  const r = await applyInventoryChanges(A, [{ field: 'onHand', value: '5', base: 3 }], ctx());
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  const p = await prisma.product.findUniqueOrThrow({ where: { id: A } });
  assert.equal(p.quantity, 5);
  assert.equal(r.row?.sku, 'LTD-00001');
  const ev = await prisma.inventoryEvent.findMany({ where: { productId: A }, orderBy: { field: 'asc' } });
  assert.deepEqual(ev.map((e) => [e.field, e.oldValue, e.newValue]), [['onHand', '3', '5'], ['sku', null, 'LTD-00001']]);
});

test('a stale base value is a conflict: nothing is overwritten', async () => {
  const r = await applyInventoryChanges(A, [{ field: 'onHand', value: 9, base: 3 }], ctx());
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].kind, 'conflict');
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: A } })).quantity, 5);
});

test('reserved = units in unshipped orders; On hand can not drop below it', async () => {
  // A buy-now checkout took 2 units (as reserveAndCreateOrder does).
  await prisma.product.update({ where: { id: A }, data: { quantity: { decrement: 2 } } });
  const order = await prisma.order.create({
    data: { orderNumber: 'LTD-T-1', buyerId, status: 'PENDING_PAYMENT', subtotalCents: 20000, totalCents: 20000, items: { create: [{ productId: A, titleSnapshot: 'A', priceCentsSnapshot: 10000, quantity: 2 }] } },
  });
  // An unpaid quote proforma does not reserve.
  const sr = await prisma.sourcingRequest.create({ data: { buyerName: 'Buyer', buyerEmail: 'qa.inv.buyer@labtodate.com', description: 'Quote for B', productId: B } });
  await prisma.order.create({
    data: { orderNumber: 'LTD-T-2', buyerId, sourcingRequestId: sr.id, status: 'PENDING_PAYMENT', subtotalCents: 1, totalCents: 1, items: { create: [{ productId: B, titleSnapshot: 'B', priceCentsSnapshot: 1, quantity: 1 }] } },
  });
  let r = await row(A);
  assert.deepEqual([r.onHand, r.reserved, r.available], [5, 2, 3]);
  assert.equal((await reservedByProduct(prisma, [B])).get(B) ?? 0, 0);
  const low = await applyInventoryChanges(A, [{ field: 'onHand', value: 1, base: 5 }], ctx());
  assert.equal(low.ok, false);
  assert.match(low.issues[0].message, /reserved/);
  const ok = await applyInventoryChanges(A, [{ field: 'onHand', value: 4, base: 5 }], ctx());
  assert.equal(ok.ok, true);
  r = await row(A);
  assert.deepEqual([r.onHand, r.reserved, r.available], [4, 2, 2]);
  // Shipping takes the units off the shelf.
  await prisma.order.update({ where: { id: order.id }, data: { status: 'SHIPPED' } });
  r = await row(A);
  assert.deepEqual([r.onHand, r.reserved, r.available], [2, 0, 2]);
});

test('a checkout between reading and saving makes the save a conflict (compare-and-set)', async () => {
  const before = await row(A);
  await prisma.product.update({ where: { id: A }, data: { quantity: { decrement: 1 } } }); // a sale without an order row yet
  const r = await applyInventoryChanges(A, [{ field: 'onHand', value: 10, base: before.onHand }], ctx());
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].kind, 'conflict');
  await prisma.product.update({ where: { id: A }, data: { quantity: { increment: 1 } } });
});

test('a quote-only price stays private; becoming buyable makes it public, and back', async () => {
  let r = await applyInventoryChanges(B, [{ field: 'priceCents', value: '250', base: null }], ctx());
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  let p = await prisma.product.findUniqueOrThrow({ where: { id: B }, include: { inventory: true } });
  assert.equal(p.priceCents, null, 'never on the public listing');
  assert.equal(p.inventory?.quotePriceCents, 25000);
  assert.equal(r.row?.priceCents, 25000);
  assert.equal(r.row?.priceInternal, true);
  r = await applyInventoryChanges(B, [{ field: 'mode', value: 'Buy now + quote', base: 'QUOTE_ONLY' }], ctx());
  assert.equal(r.ok, true);
  p = await prisma.product.findUniqueOrThrow({ where: { id: B }, include: { inventory: true } });
  assert.deepEqual([p.mode, p.priceCents, p.inventory?.quotePriceCents], ['HYBRID', 25000, null]);
  r = await applyInventoryChanges(B, [{ field: 'mode', value: 'QUOTE_ONLY', base: 'HYBRID' }], ctx());
  p = await prisma.product.findUniqueOrThrow({ where: { id: B }, include: { inventory: true } });
  assert.deepEqual([p.mode, p.priceCents, p.inventory?.quotePriceCents], ['QUOTE_ONLY', null, 25000]);
});

test('setting "switch to Buy now" makes a price on a quote-only item public', async () => {
  const r = await applyInventoryChanges(B, [{ field: 'priceCents', value: '300', base: 25000 }], ctx({ settings: settings({ INVENTORY_QUOTE_PRICE: 'buy_now' }) }));
  assert.equal(r.ok, true);
  assert.match(r.notes.join(' '), /Buy now \+ quote/);
  const p = await prisma.product.findUniqueOrThrow({ where: { id: B } });
  assert.deepEqual([p.mode, p.priceCents], ['HYBRID', 30000]);
  await applyInventoryChanges(B, [{ field: 'mode', value: 'QUOTE_ONLY' }], ctx());
});

test('permissions: cost and publishing need their capability', async () => {
  const c = await applyInventoryChanges(A, [{ field: 'costCents', value: '40' }], ctx({ canCost: false }));
  assert.equal(c.ok, false);
  assert.equal(c.row?.costCents, null, 'cost not revealed either');
  const s = await applyInventoryChanges(A, [{ field: 'status', value: 'Draft' }], ctx({ canApprove: false }));
  assert.equal(s.ok, false);
  const ok = await applyInventoryChanges(A, [{ field: 'costCents', value: '40' }, { field: 'supplier', value: 'Lab closing Utrecht' }], ctx());
  assert.equal(ok.ok, true);
  assert.equal((await row(A)).supplier, 'Lab closing Utrecht');
  assert.equal(await prisma.supplier.count(), 1);
});

test('language rule: Persian text refused, Persian digits accepted', async () => {
  const persian = String.fromCharCode(0x0633, 0x0644, 0x0627, 0x0645);
  const t = await applyInventoryChanges(A, [{ field: 'title', value: persian }], ctx());
  assert.equal(t.ok, false);
  const n = await applyInventoryChanges(A, [{ field: 'location', value: 'A-' + String.fromCharCode(0x06f0, 0x06f3) }], ctx());
  assert.equal(n.ok, true);
  assert.equal((await row(A)).location, 'A-03');
});

test('SKUs are unique; missing ones can be assigned in bulk', async () => {
  const dup = await applyInventoryChanges(B, [{ field: 'sku', value: 'ltd-00001' }], ctx());
  assert.equal(dup.ok, false);
  assert.match(dup.issues[0].message, /already used/);
  await prisma.productInventory.update({ where: { productId: B }, data: { sku: null } });
  const n = await assignMissingSkus([A, B], ctx());
  assert.equal(n, 1);
  assert.equal((await row(B)).sku, 'LTD-00002');
});

test('Excel round trip: an untouched cell never undoes a sale; a double change is a conflict', async () => {
  const rows = await loadInventoryRows({ scope: 'own', canCost: true });
  const xlsx = await buildXlsx(rows, { canCost: true, suppliers: ['Lab closing Utrecht'], categories: ['Pumps & Fluidics'], siteUrl: 'https://labtodate.com', exportedBy: 'qa' });
  // While the file is open in Excel: A sells one unit on the site, B gets a new location on the site.
  await prisma.product.update({ where: { id: A }, data: { quantity: { decrement: 1 } } });
  await applyInventoryChanges(B, [{ field: 'location', value: 'SITE-1' }], ctx());
  // In Excel: A's price changes (On hand untouched); B's location also changes.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Inventory')!;
  const headers = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
  const col = (h: string) => headers.indexOf(h);
  for (let r = 2; r <= ws.rowCount; r++) {
    const id = ws.getRow(r).getCell(col('ID (do not edit)')).value;
    if (id === A) ws.getRow(r).getCell(col('Selling price')).value = 120;
    if (id === B) ws.getRow(r).getCell(col('Location')).value = 'FILE-9';
  }
  const edited = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  const sheet = await readUpload('edited.xlsx', edited);
  const preview = await buildPreview('edited.xlsx', sheet, autoMapping(sheet.headers), ctx({ source: 'IMPORT' }));
  const la = preview.lines.find((l) => l.match?.id === A)!;
  const lb = preview.lines.find((l) => l.match?.id === B)!;
  assert.equal(la.status, 'update');
  assert.deepEqual(la.changes.map((c) => c.field), ['priceCents']); // On hand untouched in the file: the sale stays
  assert.equal(lb.status, 'conflict');
  const stored = getStoredPreview(preview.id, 'qa.inv.owner@labtodate.com')!;
  const qtyBefore = (await prisma.product.findUniqueOrThrow({ where: { id: A } })).quantity;
  const res = await applyPreview(stored, { useFileForConflicts: [], skipLines: [], sellerId }, ctx({ source: 'IMPORT', batchId: preview.id }));
  assert.equal(res.every((x) => x.ok), true, JSON.stringify(res));
  const a = await prisma.product.findUniqueOrThrow({ where: { id: A } });
  assert.deepEqual([a.priceCents, a.quantity], [12000, qtyBefore]);
  assert.equal((await row(B)).location, 'SITE-1', 'conflict kept the site value by default');
  assert.equal(await prisma.inventoryEvent.count({ where: { batchId: preview.id, source: 'IMPORT' } }), 1);
});

test('importing the real products.csv: 24 new drafts, then a re-import changes nothing', async () => {
  const file = 'C:/Users/norou/labtodate-products/products.csv';
  if (!fs.existsSync(file)) return;
  const bytes = fs.readFileSync(file);
  let sheet = await readUpload('products.csv', bytes);
  let preview = await buildPreview('products.csv', sheet, autoMapping(sheet.headers), ctx({ source: 'IMPORT' }));
  assert.equal(preview.counts.new, 24, JSON.stringify(preview.lines.filter((l) => l.status !== 'new').map((l) => [l.line, l.errors])));
  const res = await applyPreview(getStoredPreview(preview.id, 'qa.inv.owner@labtodate.com')!, { useFileForConflicts: [], skipLines: [], sellerId }, ctx({ source: 'IMPORT' }));
  assert.equal(res.filter((r) => r.ok).length, 24);
  const created = await loadInventoryRows({ ids: res.map((r) => r.productId!), canCost: true });
  assert.equal(created.every((r) => r.status === 'DRAFT' && r.mode === 'QUOTE_ONLY' && r.onHand === 1), true);
  assert.equal(created.find((r) => r.title.startsWith('PerkinElmer N291-9044'))?.mpn, 'N291-9044');
  assert.equal(created.every((r) => /^LTD-\d{5}$/.test(r.sku ?? '')), true);
  sheet = await readUpload('products.csv', bytes);
  preview = await buildPreview('products.csv', sheet, autoMapping(sheet.headers), ctx({ source: 'IMPORT' }));
  assert.equal(preview.counts.unchanged, 24, JSON.stringify(preview.counts));
});
