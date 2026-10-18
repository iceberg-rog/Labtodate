import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marginGoodsOf, marginVatByDocument, orderMarginOf, type MarginDocInput, type MarginItemInput } from './margin-vat';

const D = (s: string) => new Date(s);
const RATE = 2100;

// J5: a €6,500 second-hand unit bought for €4,200, €150 freight at 21%.
const unit = (purchaseCostCents: number | null, price = 650_000, quantity = 1): MarginItemInput => ({
  priceCentsSnapshot: price,
  quantity,
  product: { vatScheme: 'MARGIN', purchaseCostCents },
});

function mdoc(kind: 'INVOICE' | 'CREDIT_NOTE', id: string, issued: string, goods: number, p: { freight?: number; original?: string; treatment?: string } = {}): MarginDocInput {
  const freight = p.freight ?? 0;
  return {
    id,
    kind,
    vatTreatment: p.treatment ?? 'MARGIN_SCHEME',
    originalDocumentId: p.original ?? null,
    issueDate: D(issued),
    createdAt: D(issued),
    subtotalCents: goods + freight,
    snapshot: { vat: { rows: [...(freight ? [{ rateBp: RATE, baseCents: freight, taxCents: Math.round(freight * 0.21) }] : []), { rateBp: 0, baseCents: goods, taxCents: 0 }] } },
  };
}

test('margin VAT per unit as the invoice records it; a unit without a purchase cost is counted, not guessed', () => {
  // Margin €2,300 incl. VAT → 2,300 × 21/121 = €399.17.
  assert.deepEqual(orderMarginOf([unit(420_000)], RATE), { marginCents: 230_000, vatCents: 39_917, unitsWithoutCost: 0 });
  assert.deepEqual(
    orderMarginOf([unit(420_000), unit(null, 100_000, 2), unit(700_000), { priceCentsSnapshot: 50_000, quantity: 1, product: { vatScheme: 'STANDARD', purchaseCostCents: 10_000 } }], RATE),
    // A loss (sold below cost) owes no margin VAT; standard goods are not part of it.
    { marginCents: 230_000, vatCents: 39_917, unitsWithoutCost: 2 },
  );
});

test('the goods of a margin-scheme document: with a 0% goods row or none', () => {
  assert.equal(marginGoodsOf(mdoc('INVOICE', 'i', '2026-10-20T10:00:00Z', 650_000, { freight: 15_000 })), 650_000);
  assert.equal(marginGoodsOf({ subtotalCents: 665_000, snapshot: { vat: { rows: [{ rateBp: 2100, baseCents: 15_000, taxCents: 3_150 }] } } }), 650_000);
  assert.equal(marginGoodsOf({ subtotalCents: 665_000, snapshot: null }), 665_000);
});

test('invoice, part credit and the rest: the credit notes take back exactly the invoice margin VAT', () => {
  const docs = [
    mdoc('INVOICE', 'inv', '2026-10-20T10:00:00Z', 650_000, { freight: 15_000 }),
    // €500 off the price: the margin drops to €1,800 → €312.40 margin VAT.
    mdoc('CREDIT_NOTE', 'cn1', '2026-10-21T10:00:00Z', -50_000, { original: 'inv' }),
    mdoc('CREDIT_NOTE', 'cn2', '2026-10-22T10:00:00Z', -600_000, { freight: -15_000, original: 'inv' }),
  ];
  const m = marginVatByDocument(docs, [unit(420_000)], RATE);
  assert.deepEqual(m.get('inv'), { rateBp: RATE, baseCents: 190_083, vatCents: 39_917, unitsWithoutCost: 0 });
  assert.equal(m.get('cn1')?.vatCents, 31_240 - 39_917);
  assert.equal(m.get('cn2')?.vatCents, -31_240);
  assert.equal([...m.values()].reduce((s, v) => s + v.vatCents, 0), 0);
  assert.equal([...m.values()].reduce((s, v) => s + v.baseCents, 0), 0);
});

test('a corrected invoice owes the margin VAT again; documents under other rules owe none', () => {
  const docs = [
    mdoc('INVOICE', 'a', '2026-10-20T10:00:00Z', 650_000, { freight: 15_000 }),
    mdoc('CREDIT_NOTE', 'cn', '2026-10-20T11:00:00Z', -650_000, { freight: -15_000, original: 'a' }),
    mdoc('INVOICE', 'b', '2026-10-20T11:00:01Z', 650_000, { freight: 15_000, original: 'a' }),
  ];
  const m = marginVatByDocument(docs, [unit(420_000)], RATE);
  assert.deepEqual(['a', 'cn', 'b'].map((id) => m.get(id)?.vatCents), [39_917, -39_917, 39_917]);
  assert.equal(marginVatByDocument(docs.map((d) => ({ ...d, vatTreatment: 'DOMESTIC_STANDARD' })), [unit(420_000)], RATE).size, 0);
  assert.equal(marginVatByDocument(docs, [unit(null)], RATE).get('a')?.unitsWithoutCost, 1);
});
