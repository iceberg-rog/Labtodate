/**
 * DB test (local / test databases only): the public sell price kept by the
 * migration-7a triggers (Product.displayPriceCents) equals THE price resolver
 * (src/lib/pricing/resolve.ts) for every shop rule, on product writes AND on
 * shop-rule changes. Run: npm run test:checkout-db
 */
import { assertTestDatabase } from './db-test-guard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { resolveSellPrice, type ShopPricingModeCode } from '../src/lib/pricing/resolve';

// Allow-list guard: local test databases only (scripts/db-test-guard.ts).
assertTestDatabase();
const prisma = new PrismaClient();

const MODES: ShopPricingModeCode[] = ['PASS_THROUGH', 'MARKUP_PERCENT', 'FORCE_QUOTE', 'HIDE_PRICE'];
const PRICES = [null, 0, 1, 99, 1005, 12345, 999999, 2_000_000];
const MARKUPS = [0, 1, 1000, 1250, -2500, -9000, 333];

test('displayPriceCents trigger == resolveSellPrice (product writes and shop-rule changes)', async () => {
  const cat = await prisma.category.findFirst({ select: { id: true } });
  const seller = await prisma.user.findFirst({ where: { role: { in: ['SELLER', 'ADMIN'] } }, select: { id: true } });
  assert.ok(cat && seller, 'needs a category and a seller in the DB');
  const tag = `t7a-${Date.now().toString(36)}`;
  const co = await prisma.company.create({ data: { slug: tag, name: `Test ${tag}` } });
  const created: string[] = [];
  try {
    let n = 0;
    for (const price of PRICES) {
      const p = await prisma.product.create({
        data: { slug: `${tag}-${n++}`, title: 'trigger test', priceCents: price, categoryId: cat!.id, sellerId: seller!.id, companyId: co.id, status: 'DRAFT' },
        select: { id: true },
      });
      created.push(p.id);
    }
    let checked = 0;
    for (const mode of MODES) {
      for (const markup of MARKUPS) {
        await prisma.company.update({ where: { id: co.id }, data: { pricingMode: mode, pricingMarkupBp: markup } });
        const rows = await prisma.product.findMany({ where: { companyId: co.id }, select: { priceCents: true, displayPriceCents: true } });
        for (const r of rows) {
          const expected = resolveSellPrice({ priceCents: r.priceCents, currency: 'EUR', mode: 'HYBRID' }, { pricingMode: mode, pricingMarkupBp: markup }).sellPriceCents;
          assert.equal(r.displayPriceCents, expected, `${mode} ${markup}bp price ${r.priceCents}`);
          checked++;
        }
      }
    }
    // A product price change recomputes too; a direct write of the column is overwritten.
    await prisma.company.update({ where: { id: co.id }, data: { pricingMode: 'MARKUP_PERCENT', pricingMarkupBp: 1000 } });
    await prisma.product.update({ where: { id: created[4] }, data: { priceCents: 2000 } });
    assert.equal((await prisma.product.findUnique({ where: { id: created[4] }, select: { displayPriceCents: true } }))?.displayPriceCents, 2200);
    await prisma.product.update({ where: { id: created[4] }, data: { displayPriceCents: 1 } });
    assert.equal((await prisma.product.findUnique({ where: { id: created[4] }, select: { displayPriceCents: true } }))?.displayPriceCents, 2200);
    // 8f: a price on hold for review has no public price, whatever the rule —
    // also after a shop-rule change — and gets it back when the hold ends.
    await prisma.product.update({ where: { id: created[4] }, data: { priceOnHold: true } });
    assert.equal((await prisma.product.findUnique({ where: { id: created[4] }, select: { displayPriceCents: true } }))?.displayPriceCents, null);
    await prisma.company.update({ where: { id: co.id }, data: { pricingMode: 'PASS_THROUGH', pricingMarkupBp: 0 } });
    assert.equal((await prisma.product.findUnique({ where: { id: created[4] }, select: { displayPriceCents: true } }))?.displayPriceCents, null);
    assert.equal(resolveSellPrice({ priceCents: 2000, currency: 'EUR', mode: 'HYBRID', priceOnHold: true }, { pricingMode: 'PASS_THROUGH', pricingMarkupBp: 0 }).sellPriceCents, null);
    await prisma.product.update({ where: { id: created[4] }, data: { priceOnHold: false } });
    assert.equal((await prisma.product.findUnique({ where: { id: created[4] }, select: { displayPriceCents: true } }))?.displayPriceCents, 2000);
    await prisma.company.update({ where: { id: co.id }, data: { pricingMode: 'MARKUP_PERCENT', pricingMarkupBp: 1000 } });
    // Moving a product to a shop without a rule → pass-through.
    await prisma.product.update({ where: { id: created[4] }, data: { companyId: null } });
    assert.equal((await prisma.product.findUnique({ where: { id: created[4] }, select: { displayPriceCents: true } }))?.displayPriceCents, 2000);
    assert.ok(checked > 200);
  } finally {
    await prisma.product.deleteMany({ where: { id: { in: created } } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => null);
    await prisma.$disconnect();
  }
});
