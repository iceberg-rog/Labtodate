/**
 * DB integration tests for fulfilment, cancellation, returns & refunds (wave 2,
 * s2c). Needs the Postgres + MinIO of .env and a mail relay (the strict local
 * sink). NOT for production databases: it creates orders, shipments, refunds
 * and documents that can never be deleted afterwards (by design).
 *
 *   node --require ./scripts/react-cache-shim.cjs --env-file=.env --import tsx --test scripts/test-fulfilment.db.ts
 *
 * Covers: owner report 5 (no shipment without complete details), partial
 * shipments, tracking rule, delivery; owner report 6 (cancel a paid order before
 * shipping: credit note + refund REQUESTED + restock, the money state stays
 * PAID until the transfer is recorded; unpaid NET invoice: credit note that
 * cancels the receivable, NO refund); the refund ledger (REQUESTED → SENT →
 * CONFIRMED, exactly once); A10 (a refund never restocks; a shipped order needs
 * an RMA or a justification); the RMA (photos rule, approve → receive → inspect
 * with restock → resolve with a partial refund + credit note).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { ensureSettingsLoaded } from '../src/lib/settings';
import { issueInvoice } from '../src/lib/documents/issue';
import { closePdfBrowser } from '../src/lib/documents/pdf';
import { recordPayment } from '../src/lib/payments/ledger';
import { cancelPaidOrder } from '../src/lib/fulfilment/cancel';
import { confirmRefund, createRefund, markRefundSent } from '../src/lib/finance/refunds';
import { markDelivered, recordShipment } from '../src/lib/fulfilment/shipments';
import { approveReturn, createReturnRequest, inspectReturn, receiveReturn, resolveReturn } from '../src/lib/fulfilment/returns';
import type { DocumentSnapshot } from '../src/lib/documents/snapshot';
import { creditOutstandingCents } from '../src/lib/credit/terms';

if (/labtodate\.com|prod/i.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run against a production-looking DATABASE_URL.');

const RUN = randomBytes(3).toString('hex').toUpperCase();
const STAFF = { id: null, email: 'qa-admin@labtodate.test' };
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

async function product(qty: number) {
  await ids();
  return prisma.product.create({
    data: { slug: `f-${RUN}-${randomBytes(3).toString('hex')}`, title: `Test centrifuge ${RUN}`, description: 'test unit', priceCents: 100_000, currency: 'EUR', quantity: qty, status: 'DRAFT', mode: 'HYBRID', condition: 'USED', sellerId: seller, categoryId: category },
    select: { id: true },
  });
}

const bill = { company: `QA Lab ${RUN} B.V.`, name: 'QA Buyer', vat: 'NL859876543B01', address: { line1: 'Teststraat 1', postal_code: '2611 AA', city: 'Delft', country: 'NL' } };
const ship = { name: 'QA Buyer', phone: '+31 10 000 0000', address: { line1: 'Teststraat 1', postal_code: '2611 AA', city: 'Delft', country: 'NL' } };

/** A paid checkout order (2 lines, unit already taken from stock) with its invoice. */
async function paidOrder(o: { lines?: number; onTerms?: boolean; shippingAddress?: unknown } = {}) {
  await ids();
  const n = o.lines ?? 1;
  const products = await Promise.all(Array.from({ length: n }, () => product(0)));
  const order = await prisma.order.create({
    data: {
      orderNumber: `L2D-F${RUN}-${randomBytes(2).toString('hex').toUpperCase()}`, buyerId: buyer,
      status: o.onTerms ? 'PROCESSING' : 'PAID', financialStatus: o.onTerms ? 'INVOICED_ON_TERMS' : 'PAID', paidAt: o.onTerms ? null : new Date(),
      paymentMethodManual: o.onTerms ? 'INVOICE' : 'BANK_TRANSFER', paymentTerms: o.onTerms ? { kind: 'NET', netDays: 30 } : undefined,
      subtotalCents: 100_000 * n, shippingCents: 0, taxCents: 21_000 * n, totalCents: 121_000 * n, currency: 'EUR',
      vatTreatment: 'DOMESTIC_STANDARD', vatRateBp: 2100, shippingVatRateBp: 2100, customerType: 'BUSINESS',
      billingAddress: bill, shippingAddress: (o.shippingAddress ?? ship) as object,
      items: { create: products.map((p, i) => ({ productId: p.id, titleSnapshot: `Test centrifuge ${RUN} #${i + 1}`, priceCentsSnapshot: 100_000, quantity: 1, vatRateBp: 2100, taxCents: 21_000 })) },
    },
    include: { items: true },
  });
  if (!o.onTerms) await prisma.$transaction((tx) => recordPayment(tx, { orderId: order.id, amountCents: order.totalCents, currency: 'EUR', method: 'BANK_TRANSFER', reference: order.orderNumber, note: 'test' }));
  const inv = await issueInvoice(order.id);
  assert.equal(inv.ok, true, inv.ok ? '' : inv.message);
  return { order, products };
}

after(async () => {
  await closePdfBrowser();
  await prisma.$disconnect();
});

test('owner report 6: a paid order canceled before shipping — credit note (to be refunded), refund REQUESTED, money state stays PAID until sent, unit back once', async () => {
  await ensureSettingsLoaded();
  const { order, products } = await paidOrder();
  const r = await cancelPaidOrder({ orderId: order.id, reason: 'Item failed pre-dispatch inspection', method: 'BANK_TRANSFER' }, STAFF);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /transfer is NOT sent yet/);
  const o = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true, financialStatus: true, amountRefundedCents: true } });
  assert.equal(o!.status, 'CANCELED');
  assert.equal(o!.financialStatus, 'PAID', 'the money is still owed back — not VOID, not REFUNDED');
  assert.equal(o!.amountRefundedCents, 0);
  const refund = await prisma.refund.findFirst({ where: { orderId: order.id }, include: { creditNote: true } });
  assert.equal(refund!.status, 'REQUESTED');
  assert.equal(refund!.amountCents, 121_000);
  const snap = refund!.creditNote!.snapshot as unknown as DocumentSnapshot;
  assert.equal(refund!.creditNote!.totalCents, -121_000);
  assert.equal(snap.payment?.kind, 'CREDIT');
  // One credit-note core (lib/finance/refunds.ts → documents/issue.ts): the settlement says what happens to the money.
  assert.deepEqual((snap.payment as { settlement?: unknown }).settlement, { kind: 'REFUND', refundCents: 121_000, cancelledCents: 0 });
  assert.match(snap.terms.join(' '), /will be refunded to you by bank transfer/, 'never “is refunded” before the money was sent');
  assert.doesNotMatch(snap.terms.join(' '), /\bis refunded\b/);
  assert.equal((await prisma.product.findUnique({ where: { id: products[0].id } }))!.quantity, 1, 'never shipped → back on sale (Settings default)');
  const again = await cancelPaidOrder({ orderId: order.id, reason: 'again', method: 'BANK_TRANSFER' }, STAFF);
  assert.equal(again.ok, false, 'a second cancel changes nothing');
  assert.equal((await prisma.product.findUnique({ where: { id: products[0].id } }))!.quantity, 1, 'restocked once');

  // Ledger: REQUESTED → SENT (once) → CONFIRMED.
  const sent = await markRefundSent({ refundId: refund!.id, sentAt: new Date(), bankRef: `TEST-${RUN}` }, STAFF);
  assert.equal(sent.ok, true, sent.message);
  const twice = await markRefundSent({ refundId: refund!.id, sentAt: new Date(), bankRef: `TEST-${RUN}` }, STAFF);
  assert.equal(twice.ok, false);
  const o2 = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true, financialStatus: true, amountRefundedCents: true } });
  assert.equal(o2!.financialStatus, 'REFUNDED');
  assert.equal(o2!.amountRefundedCents, 121_000);
  assert.equal(o2!.status, 'CANCELED', 'stays canceled (fulfilment) — refunded (money)');
  assert.equal((await confirmRefund(refund!.id, STAFF)).ok, true);
  assert.equal((await prisma.refund.findUnique({ where: { id: refund!.id } }))!.status, 'CONFIRMED');
});

test('fiscal finding: canceling an unpaid NET-terms order cancels the receivable — credit note says no payment is due, NO money refund', async () => {
  await ensureSettingsLoaded();
  const { order } = await paidOrder({ onTerms: true });
  const r = await cancelPaidOrder({ orderId: order.id, reason: 'Budget withdrawn', method: null }, STAFF);
  assert.equal(r.ok, true, r.message);
  assert.equal(await prisma.refund.count({ where: { orderId: order.id } }), 0, 'no money refund row');
  const o = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true, financialStatus: true } });
  assert.equal(o!.status, 'CANCELED');
  assert.equal(o!.financialStatus, 'VOID');
  const cn = await prisma.fiscalDocument.findFirst({ where: { orderId: order.id, kind: 'CREDIT_NOTE' } });
  const snap = cn!.snapshot as unknown as DocumentSnapshot;
  assert.deepEqual((snap.payment as { settlement?: unknown }).settlement, { kind: 'NOT_PAID', refundCents: 0, cancelledCents: 121_000 });
  assert.match(snap.terms.join(' '), /no money is refunded/);
});

test('integration (s2c + s2e): a PART-paid NET-terms order canceled — credit note refunds only the paid part, the rest is no longer due; nothing stays open on terms', async () => {
  await ensureSettingsLoaded();
  const { order } = await paidOrder({ onTerms: true });
  await prisma.$transaction((tx) => recordPayment(tx, { orderId: order.id, amountCents: 50_000, currency: 'EUR', method: 'BANK_TRANSFER', reference: order.orderNumber, note: 'part payment (test)' }));
  await prisma.order.update({ where: { id: order.id }, data: { financialStatus: 'PARTIALLY_PAID' } });
  const exposureBefore = await creditOutstandingCents(buyer);
  const r = await cancelPaidOrder({ orderId: order.id, reason: 'Budget withdrawn after a part payment', method: 'BANK_TRANSFER' }, STAFF);
  assert.equal(r.ok, true, r.message);
  const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amountCents, 50_000, 'only the money received goes back');
  assert.equal(refunds[0].status, 'REQUESTED');
  const cn = await prisma.fiscalDocument.findFirst({ where: { orderId: order.id, kind: 'CREDIT_NOTE' } });
  assert.equal(cn!.totalCents, -121_000, 'the invoice is credited in full');
  const snap = cn!.snapshot as unknown as DocumentSnapshot;
  assert.deepEqual((snap.payment as { settlement?: unknown }).settlement, { kind: 'PART_REFUND', refundCents: 50_000, cancelledCents: 71_000 });
  assert.match(snap.terms.join(' '), /will be refunded to you by bank transfer; the remaining .* had not been paid and is no longer due/);
  const o = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true, financialStatus: true, amountRefundedCents: true } });
  assert.equal(o!.status, 'CANCELED');
  assert.equal(o!.financialStatus, 'PAID', 'settled: nothing due any more, the €500 is owed back (not “partly paid on terms”)');
  assert.equal(o!.amountRefundedCents, 0);
  assert.equal(exposureBefore - (await creditOutstandingCents(buyer)), 71_000, 'the canceled order no longer counts against the credit limit');
  const sent = await markRefundSent({ refundId: refunds[0].id, sentAt: new Date(), bankRef: `TEST-P-${RUN}` }, STAFF);
  assert.equal(sent.ok, true, sent.message);
  const o2 = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true, financialStatus: true, amountRefundedCents: true } });
  assert.deepEqual(o2, { status: 'CANCELED', financialStatus: 'REFUNDED', amountRefundedCents: 50_000 });
});

test('owner report 5 + B12: no shipment without complete details; partial shipments; tracking rule; delivery', async () => {
  await ensureSettingsLoaded();
  const bad = await paidOrder({ shippingAddress: { name: 'QA', address: { line1: 'Teststraat 1', city: 'Delft', country: 'NL' } } });
  const refused = await recordShipment({ orderId: bad.order.id, lines: 'ALL', carrier: 'Own transport', trackingNumber: null, parcels: 1, grossKg: null, insuredValueCents: null, shippedAt: new Date(), note: null }, STAFF);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /incomplete.*(delivery phone|complete delivery address)/);
  assert.equal(await prisma.shipment.count({ where: { orderId: bad.order.id } }), 0);

  const { order } = await paidOrder({ lines: 2 });
  const noTracking = await recordShipment({ orderId: order.id, lines: 'ALL', carrier: 'PostNL', trackingNumber: null, parcels: 1, grossKg: null, insuredValueCents: null, shippedAt: new Date(), note: null }, STAFF);
  assert.equal(noTracking.ok, false, 'PostNL has tracking → number required');
  const first = await recordShipment({ orderId: order.id, lines: [{ orderItemId: order.items[0].id, qty: 1 }, { orderItemId: order.items[1].id, qty: 0 }], carrier: 'PostNL', trackingNumber: '3SABC123', parcels: 1, grossKg: 12.5, insuredValueCents: 'DEFAULT', shippedAt: new Date(), note: null }, STAFF);
  assert.equal(first.ok, true, first.message);
  assert.equal(first.ok && first.progress, 'PARTIAL');
  let o = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
  assert.equal(o!.status, 'PROCESSING', 'partly shipped stays processing');
  const s1 = await prisma.shipment.findFirst({ where: { orderId: order.id, seq: 1 } });
  assert.equal(s1!.trackingUrl, 'https://jouw.postnl.nl/track-and-trace/3SABC123');
  assert.equal(s1!.insuredValueCents, 100_000, 'insured with the goods value by default');
  const tooMany = await recordShipment({ orderId: order.id, lines: [{ orderItemId: order.items[0].id, qty: 1 }], carrier: 'Own transport', trackingNumber: null, parcels: 1, grossKg: null, insuredValueCents: null, shippedAt: new Date(), note: null }, STAFF);
  assert.equal(tooMany.ok, false, 'that line has shipped already');
  const second = await recordShipment({ orderId: order.id, lines: 'ALL', carrier: 'Own transport', trackingNumber: null, parcels: 1, grossKg: null, insuredValueCents: null, shippedAt: new Date(), note: null }, STAFF);
  assert.equal(second.ok, true, second.message);
  o = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
  assert.equal(o!.status, 'SHIPPED');
  const cancel = await cancelPaidOrder({ orderId: order.id, reason: 'too late', method: 'BANK_TRANSFER' }, STAFF);
  assert.equal(cancel.ok, false, 'shipped → return, not cancel');
  const d1 = await markDelivered({ orderId: order.id, shipmentId: s1!.id, deliveredAt: new Date(), by: 'STAFF' }, STAFF);
  assert.equal(d1.ok && d1.orderDelivered, false, 'one of two shipments delivered');
  const d2 = await markDelivered({ orderId: order.id, deliveredAt: new Date(), by: 'BUYER' }, { id: buyer, email: 'qa-buyer@labtodate.test' });
  assert.equal(d2.ok && d2.orderDelivered, true);
  o = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
  assert.equal(o!.status, 'DELIVERED');
});

test('A10 + B14: refund after shipping needs an RMA or a justification and never restocks; RMA restocks only at inspection', async () => {
  await ensureSettingsLoaded();
  const { order, products } = await paidOrder();
  const shipped = await recordShipment({ orderId: order.id, lines: 'ALL', carrier: 'Own transport', trackingNumber: null, parcels: 1, grossKg: null, insuredValueCents: null, shippedAt: new Date(), note: null }, STAFF);
  assert.equal(shipped.ok, true);
  await markDelivered({ orderId: order.id, deliveredAt: new Date(), by: 'STAFF' }, STAFF);

  const noReason = await createRefund({ orderId: order.id, amountCents: 10_000, reason: 'Price adjustment', method: 'BANK_TRANSFER' }, STAFF);
  assert.equal(noReason.ok, false, 'shipped, no RMA, no justification');
  const goodwill = await createRefund({ orderId: order.id, amountCents: 12_100, reason: 'Price adjustment / goodwill', method: 'BANK_TRANSFER', justification: 'Cosmetic scratch on the lid, buyer keeps the unit' }, STAFF);
  assert.equal(goodwill.ok, true, goodwill.ok ? '' : goodwill.message);
  assert.equal((await prisma.product.findUnique({ where: { id: products[0].id } }))!.quantity, 0, 'a refund never restocks');
  const cn = await prisma.fiscalDocument.findFirst({ where: { orderId: order.id, kind: 'CREDIT_NOTE' } });
  assert.equal(cn!.totalCents, -12_100);

  // Buyer RMA: photos required for transport damage.
  const noPhoto = await createReturnRequest({ orderId: order.id, reasonLabel: 'Damaged in transport', description: 'The housing is cracked on one side.', lines: [{ orderItemId: order.items[0].id, qty: 1 }], files: [], openedBy: 'BUYER' }, { id: buyer, email: 'qa-buyer@labtodate.test' });
  assert.equal(noPhoto.ok, false);
  const rma = await createReturnRequest({ orderId: order.id, reasonLabel: 'Does not work / defect', description: 'The rotor does not reach speed; error E12 after 2 minutes.', lines: [{ orderItemId: order.items[0].id, qty: 1 }], files: [], openedBy: 'BUYER' }, { id: buyer, email: 'qa-buyer@labtodate.test' });
  assert.equal(rma.ok, true, rma.message);
  const rr = await prisma.returnRequest.findFirst({ where: { orderId: order.id } });
  assert.equal(rr!.type, 'WARRANTY');
  const dup = await createReturnRequest({ orderId: order.id, reasonLabel: 'Does not work / defect', description: 'Second request for the same order.', lines: [{ orderItemId: order.items[0].id, qty: 1 }], files: [], openedBy: 'BUYER' }, { id: buyer, email: 'qa-buyer@labtodate.test' });
  assert.equal(dup.ok, false, 'one open request per order');
  assert.equal((await resolveReturn({ returnId: rr!.id, outcome: 'NONE', amountCents: null, method: null, note: 'not yet' }, STAFF)).ok, false, 'can not resolve before receive + inspect');
  assert.equal((await approveReturn({ returnId: rr!.id, instructions: 'Send it to Industrieweg 12, 2712 LB Zoetermeer with RMA on the box.', noReturnNeeded: false }, STAFF)).ok, true);
  assert.equal((await approveReturn({ returnId: rr!.id, instructions: 'again', noReturnNeeded: false }, STAFF)).ok, false, 'decided once');
  assert.equal((await receiveReturn({ returnId: rr!.id, receivedAt: new Date(), note: 'box intact' }, STAFF)).ok, true);
  assert.equal((await inspectReturn({ returnId: rr!.id, grade: 'REFURBISH', note: 'rotor bearing worn', restock: true }, STAFF)).ok, false, 'only RESELL goes back to stock');
  assert.equal((await inspectReturn({ returnId: rr!.id, grade: 'RESELL', note: 'works after cleaning', restock: true }, STAFF)).ok, true);
  assert.equal((await prisma.product.findUnique({ where: { id: products[0].id } }))!.quantity, 1, 'restocked at inspection');
  const res = await resolveReturn({ returnId: rr!.id, outcome: 'PARTIAL_REFUND', amountCents: 50_000, method: 'BANK_TRANSFER', note: 'Refund of the unit minus the agreed restocking fee' }, STAFF);
  assert.equal(res.ok, true, res.message);
  const refunds = await prisma.refund.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(refunds.length, 2);
  assert.equal(refunds[1].returnId, rr!.id);
  assert.equal(refunds[1].status, 'REQUESTED');
  assert.ok(refunds[1].creditNoteId, 'credit note per refund');
  const over = await createRefund({ orderId: order.id, amountCents: 121_000, reason: 'Other', method: 'BANK_TRANSFER', justification: 'trying to refund more than paid' }, STAFF);
  assert.equal(over.ok, false, 'never more than what is left (121,000 − 12,100 − 50,000)');
});
