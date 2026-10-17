/**
 * DB integration tests for quotes / offers / payment (wave 2, s2b). Needs the
 * Postgres + MinIO of .env and a mail relay (the strict local sink). NOT for
 * production databases: it creates orders and documents that can never be
 * deleted afterwards (by design).
 *
 *   node --env-file=.env --import tsx --test scripts/test-quotes-payment.db.ts
 *
 * Covers: one unit held by one quote only (A09) and released once; the quote
 * order cancellation (voids the proforma with the reason, releases the unit,
 * closes the quote, refuses with a receipt in flight); the due-date sweep
 * (reminder once, overdue notice once, cancel only after due + grace, never
 * with a receipt / hold); credit limits.
 */
import { assertTestDatabase } from './db-test-guard';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { ensureSettingsLoaded } from '../src/lib/settings';
import { issueProforma } from '../src/lib/documents/issue';
import { setViesClient } from '../src/lib/tax/vies';
import { closePdfBrowser } from '../src/lib/documents/pdf';
import { holdUnitForQuote, releaseQuoteHold, quoteOrderTookStock, consumeQuoteHold } from '../src/lib/quotes/stock';
import { cancelQuoteOrder } from '../src/lib/quotes/cancel';
import { runPaymentDueSweep } from '../src/lib/orders/due-sweep';
import { paymentGraceDays, paymentReminderDays } from '../src/lib/quotes/policy';
import { creditStatusFor } from '../src/lib/credit/terms';

// Allow-list guard: local test databases only (scripts/db-test-guard.ts).
assertTestDatabase();

const RUN = randomBytes(3).toString('hex').toUpperCase();
const DAY = 86_400_000;
let buyer = '';
let seller = '';
let category = '';

async function ids() {
  if (buyer) return;
  const b = await prisma.user.findFirst({ where: { email: 'qa-buyer@labtodate.test' }, select: { id: true } });
  const s = await prisma.user.findFirst({ where: { email: 'qa-seller@labtodate.test' }, select: { id: true } });
  const c = await prisma.category.findFirst({ select: { id: true } });
  if (!b || !s || !c) throw new Error('QA accounts / a category are missing');
  buyer = b.id; seller = s.id; category = c.id;
}

async function product(qty = 1) {
  await ids();
  return prisma.product.create({
    data: { slug: `t-${RUN}-${randomBytes(3).toString('hex')}`, title: `Test HPLC ${RUN}`, description: 'test unit', priceCents: 100_000, currency: 'EUR', quantity: qty, status: 'DRAFT', mode: 'HYBRID', condition: 'USED', sellerId: seller, categoryId: category },
    select: { id: true, quantity: true },
  });
}

const details = {
  // Complete billing details incl. the VAT ID (required for EU buyers by default): a proforma needs them.
  billingAddress: { company: `QA Lab ${RUN} B.V.`, name: 'QA Buyer', vat: 'NL859876543B01', address: { line1: 'Teststraat 1', postal_code: '2611 AA', city: 'Delft', country: 'NL' } },
  shippingAddress: { name: 'QA Buyer', phone: '+31 10 000 0000', address: { line1: 'Teststraat 1', postal_code: '2611 AA', city: 'Delft', country: 'NL' } },
};

/** An accepted quote with an unpaid order, a held unit and an issued proforma. */
async function acceptedDeal(o: { dueAt: Date; createdAt?: Date; productId?: string | null; proof?: boolean; hold?: 'COMPLIANCE' | null }) {
  await ids();
  const sr = await prisma.sourcingRequest.create({
    data: {
      buyerEmail: 'qa-buyer@labtodate.test', buyerName: 'QA Buyer', description: `test quote ${RUN} — accepted`, status: 'ACCEPTED',
      quotedPriceCents: 100_000, quotedCurrency: 'EUR', quotedAt: new Date(), validUntilAt: new Date(Date.now() + 10 * DAY), submittedById: buyer, productId: o.productId ?? null,
      offerRevision: 1, offerSubtotalCents: 100_000, offerShippingCents: 0, offerVatTreatment: 'DOMESTIC_STANDARD', offerVatRateBp: 2100, offerVatCents: 21_000, offerTotalCents: 121_000,
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `L2D-Q${RUN}-${randomBytes(2).toString('hex').toUpperCase()}`, buyerId: buyer, status: 'PENDING_PAYMENT', sourcingRequestId: sr.id,
      subtotalCents: 100_000, shippingCents: 0, taxCents: 21_000, totalCents: 121_000, currency: 'EUR', vatTreatment: 'DOMESTIC_STANDARD', vatRateBp: 2100,
      dueAt: o.dueAt, ...(o.createdAt ? { createdAt: o.createdAt } : {}), ...details, ...(o.proof ? { paymentSubmittedAt: new Date(), paymentVerificationStatus: 'AWAITING_VERIFICATION' } : {}),
      ...(o.hold ? { holdReason: o.hold, holdNote: `${o.hold}: test hold`, holdAt: new Date(), openHolds: [o.hold] } : {}),
      items: { create: { productId: o.productId ?? null, titleSnapshot: `Test HPLC ${RUN}`, priceCentsSnapshot: 100_000, quantity: 1, vatRateBp: 2100, taxCents: 21_000 } },
    },
  });
  if (o.productId) {
    const h = await prisma.$transaction((tx) => holdUnitForQuote(tx, { quoteId: sr.id, productId: o.productId!, qty: 1, orderId: order.id }));
    assert.equal(h.ok, true, 'unit held');
  }
  const pf = o.hold
    ? await prisma.$transaction((tx) => issueProforma(order.id, { tx, dueDate: o.dueAt }))
    : await issueProforma(order.id, { dueDate: o.dueAt });
  assert.equal(pf.ok, true, pf.ok ? '' : pf.message);
  return { sr, order, proforma: pf.ok ? pf.document : null };
}

// No network in tests: VIES answers from a stub.
setViesClient({ check: async () => ({ status: 'VALID', name: 'QA LAB B.V.', consultationNumber: null }) });

after(async () => {
  setViesClient(null);
  await closePdfBrowser();
  await prisma.$disconnect();
});

test('A09: the last unit can be held by ONE quote only; release restocks exactly once', async () => {
  const p = await product(1);
  const [a, b] = await Promise.all(
    ['qa', 'qb'].map(async (k) => {
      const sr = await prisma.sourcingRequest.create({ data: { buyerEmail: 'qa-buyer@labtodate.test', buyerName: 'QA', description: `race ${k} ${RUN}`, status: 'RESPONDED', productId: p.id } });
      return prisma.$transaction((tx) => holdUnitForQuote(tx, { quoteId: sr.id, productId: p.id, qty: 1, expiresAt: new Date(Date.now() + DAY) })).then((r) => ({ sr, r }));
    }),
  );
  assert.equal([a.r.ok, b.r.ok].filter(Boolean).length, 1, 'exactly one hold wins');
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } }))!.quantity, 0, 'no longer buyable (Buy Now needs quantity ≥ 1)');
  const winner = a.r.ok ? a.sr : b.sr;
  const [x, y] = await Promise.all([releaseQuoteHold(winner.id, 'test'), releaseQuoteHold(winner.id, 'test')]);
  assert.equal(x + y, 1, 'released once');
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } }))!.quantity, 1);
});

test('cancelQuoteOrder: proforma void (with reason), unit back, quote closed; refused with a receipt in flight', async () => {
  await ensureSettingsLoaded();
  const p = await product(1);
  const deal = await acceptedDeal({ dueAt: new Date(Date.now() + 10 * DAY), productId: p.id });
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } }))!.quantity, 0);
  assert.equal(await quoteOrderTookStock(deal.order.id), true);
  const r = await cancelQuoteOrder(deal.order.id, { kind: 'BUYER', id: buyer, email: 'qa-buyer@labtodate.test' }, { reason: 'Ordered by mistake', lostReason: 'Canceled by the buyer: Ordered by mistake' });
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  const o = await prisma.order.findUnique({ where: { id: deal.order.id }, select: { status: true, financialStatus: true } });
  assert.equal(o!.status, 'CANCELED');
  assert.equal(o!.financialStatus, 'VOID');
  const pf = await prisma.fiscalDocument.findUnique({ where: { id: deal.proforma!.id } });
  assert.ok(pf!.voidedAt, 'proforma voided');
  assert.match(pf!.voidReason ?? '', /Ordered by mistake/);
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } }))!.quantity, 1, 'unit back on sale');
  const sr = await prisma.sourcingRequest.findUnique({ where: { id: deal.sr.id } });
  assert.equal(sr!.status, 'CLOSED');
  assert.match(sr!.lostReason ?? '', /Canceled by the buyer/);
  const again = await cancelQuoteOrder(deal.order.id, { kind: 'BUYER', id: buyer, email: 'qa-buyer@labtodate.test' }, { reason: 'x', lostReason: 'x' });
  assert.equal(again.ok, false);

  const withProof = await acceptedDeal({ dueAt: new Date(Date.now() + 10 * DAY), proof: true });
  const refused = await cancelQuoteOrder(withProof.order.id, { kind: 'BUYER', id: buyer, email: 'qa-buyer@labtodate.test' }, { reason: 'x', lostReason: 'x' });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.message, /receipt/);
  assert.equal((await prisma.order.findUnique({ where: { id: withProof.order.id } }))!.status, 'PENDING_PAYMENT');
});

test('due-date sweep: reminder once, overdue notice once, cancel only after due + grace; receipts and holds win', async () => {
  await ensureSettingsLoaded();
  const grace = paymentGraceDays();
  const steps = paymentReminderDays();
  const now = new Date();
  const soon = steps.length ? await acceptedDeal({ dueAt: new Date(now.getTime() + (Math.min(...steps) - 0.5) * DAY) }) : null;
  const overdue = await acceptedDeal({ dueAt: new Date(now.getTime() - 0.5 * DAY) });
  const p = await product(1);
  const lapsed = await acceptedDeal({ dueAt: new Date(now.getTime() - (grace + 2) * DAY), productId: p.id });
  const lapsedProof = await acceptedDeal({ dueAt: new Date(now.getTime() - (grace + 2) * DAY), proof: true });
  const lapsedHold = await acceptedDeal({ dueAt: new Date(now.getTime() - (grace + 2) * DAY), hold: 'COMPLIANCE' });
  const only = { orderIds: [soon?.order.id, overdue.order.id, lapsed.order.id, lapsedProof.order.id, lapsedHold.order.id].filter((x): x is string => !!x) };

  const r1 = await runPaymentDueSweep(now, only);
  const r2 = await runPaymentDueSweep(now, only);
  if (soon) {
    assert.equal(await prisma.reminderLog.count({ where: { subjectId: soon.order.id, kind: 'PAYMENT_DUE_SOON' } }) >= 1, true, 'reminder logged');
  }
  assert.equal(await prisma.reminderLog.count({ where: { subjectId: overdue.order.id, kind: 'PAYMENT_OVERDUE' } }), 1, 'overdue notice exactly once');
  assert.equal((await prisma.order.findUnique({ where: { id: overdue.order.id } }))!.status, 'PENDING_PAYMENT', 'still payable during grace');
  assert.equal((await prisma.order.findUnique({ where: { id: lapsed.order.id } }))!.status, 'CANCELED', 'canceled after grace');
  assert.equal((await prisma.sourcingRequest.findUnique({ where: { id: lapsed.sr.id } }))!.status, 'CLOSED');
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } }))!.quantity, 1, 'unit released');
  assert.equal(await prisma.reminderLog.count({ where: { subjectId: lapsed.order.id, kind: 'ORDER_AUTO_CANCELED' } }), 1);
  assert.equal((await prisma.order.findUnique({ where: { id: lapsedProof.order.id } }))!.status, 'PENDING_PAYMENT', 'a receipt in review wins');
  assert.equal((await prisma.order.findUnique({ where: { id: lapsedHold.order.id } }))!.status, 'PENDING_PAYMENT', 'a compliance hold wins');
  assert.equal(r2.canceled, 0, 'second sweep cancels nothing');
  assert.equal(r2.overdueNotices, 0, 'second sweep sends no second notice');
  assert.ok(r1.canceled >= 1);
});

test('credit terms: only an approved buyer, within the limit (open on-terms invoices count)', async () => {
  await ensureSettingsLoaded();
  await ids();
  const before = await prisma.billingProfile.findUnique({ where: { userId: buyer } });
  const profile = { legalName: `QA Credit ${RUN}`, address: { line1: 'Teststraat 1', postalCode: '2611 AA', city: 'Delft', country: 'NL' }, country: 'NL' };
  await prisma.billingProfile.upsert({ where: { userId: buyer }, update: { creditApproved: true, creditLimitCents: 100_000, creditTermDays: 30 }, create: { userId: buyer, ...profile, creditApproved: true, creditLimitCents: 100_000, creditTermDays: 30 } });
  try {
    const open = await prisma.order.create({
      data: { orderNumber: `L2D-C${RUN}`, buyerId: buyer, status: 'PROCESSING', financialStatus: 'INVOICED_ON_TERMS', paymentMethodManual: 'INVOICE', subtotalCents: 60_000, taxCents: 0, totalCents: 60_000, currency: 'EUR', items: { create: { titleSnapshot: 'x', priceCentsSnapshot: 60_000, quantity: 1 } } },
    });
    const s = await creditStatusFor(buyer, 50_000, 'EUR');
    assert.equal(s.outstandingCents >= 60_000, true);
    if (s.enabled) {
      assert.equal(s.eligible, false, 'over the available credit');
      assert.equal((await creditStatusFor(buyer, 30_000, 'EUR', { excludeOrderId: null })).eligible, s.availableCents >= 30_000);
      assert.equal((await creditStatusFor(buyer, 1000, 'USD')).eligible, false, 'EUR only');
    } else {
      assert.equal(s.eligible, false, 'switched off in Settings → nobody pays on invoice');
    }
    await prisma.order.update({ where: { id: open.id }, data: { financialStatus: 'PAID', amountPaidCents: 60_000 } });
  } finally {
    if (before) await prisma.billingProfile.update({ where: { userId: buyer }, data: { creditApproved: before.creditApproved, creditLimitCents: before.creditLimitCents, creditTermDays: before.creditTermDays } });
    else await prisma.billingProfile.delete({ where: { userId: buyer } });
  }
});

test('payment: a consumed hold is "sold" — not released by the hold-expiry sweep', async () => {
  const p = await product(1);
  const deal = await acceptedDeal({ dueAt: new Date(Date.now() + 5 * DAY), productId: p.id });
  await prisma.order.update({ where: { id: deal.order.id }, data: { status: 'PAID', paidAt: new Date() } });
  assert.equal(await consumeQuoteHold(deal.sr.id), 1);
  assert.equal(await releaseQuoteHold(deal.sr.id, 'should do nothing'), 0);
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } }))!.quantity, 0, 'sold unit stays out of stock');
  assert.equal(await quoteOrderTookStock(deal.order.id), true, 'a refund knows the unit was taken');
});
