import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeConfirmText, dealStageOf, isBuyerPriceMessage, messageAuthorLabel, partPaidLine, queuePage, receivedCents,
  sortQueue, supplierSafeBody, unitUnavailable, validUntilBounds, withFulfilment,
} from './quote-view';

const brand = 'Labtodate';
const staff = { id: 'u-staff', role: 'ADMIN', name: 'Anna Staff', email: 'anna@labtodate.com' };
const supplier = { id: 'u-sup', role: 'SELLER', name: 'Sam Supplier', email: 'sam@supplier.test' };
const buyer = { id: 'u-buyer', role: 'BUYER', name: 'Bea Buyer', email: 'bea@uni.test' };

test('buyer page: staff messages are the brand, supplier messages "Supplier", never a name or "lab2date"', () => {
  const v = { kind: 'BUYER' as const, userId: buyer.id, brand };
  assert.equal(messageAuthorLabel({ fromStaff: true, author: staff }, v), 'Labtodate');
  assert.equal(messageAuthorLabel({ fromStaff: true, author: supplier }, v), 'Supplier');
  // A system message from our side (no author) is ours too.
  assert.equal(messageAuthorLabel({ fromStaff: true, author: null }, v), 'Labtodate');
  assert.equal(messageAuthorLabel({ fromStaff: false, author: buyer }, v), 'You');
  // A reply sent from the magic link (no author) is still the buyer's own.
  assert.equal(messageAuthorLabel({ fromStaff: false, author: null }, v), 'You');
});

test('supplier page: the buyer stays "Buyer", staff is the brand, own messages "You"', () => {
  const v = { kind: 'SELLER' as const, userId: supplier.id, brand };
  assert.equal(messageAuthorLabel({ fromStaff: false, author: buyer }, v), 'Buyer');
  assert.equal(messageAuthorLabel({ fromStaff: true, author: staff }, v), 'Labtodate');
  assert.equal(messageAuthorLabel({ fromStaff: true, author: supplier }, v), 'You');
});

test('admin page: the side and the name', () => {
  const v = { kind: 'STAFF' as const, userId: 'someone-else', brand, buyerName: 'Bea Buyer' };
  assert.equal(messageAuthorLabel({ fromStaff: true, author: staff }, v), 'Labtodate · Anna Staff');
  assert.equal(messageAuthorLabel({ fromStaff: true, author: supplier }, v), 'Supplier · Sam Supplier');
  assert.equal(messageAuthorLabel({ fromStaff: false, author: buyer }, v), 'Bea Buyer');
  assert.equal(messageAuthorLabel({ fromStaff: true, author: null }, v), 'Labtodate');
});

test('review off, supplier sends €5,000: their own direct offer message never shows the €5,750 buyer price', () => {
  const own = 'Offer (revision 1) for "Agilent 7890B": €5,750 excl. VAT; VAT is determined from your billing details when you accept. Valid until 1 Nov 2026.';
  const masked = supplierSafeBody(own, { brand, showSellPrice: false });
  assert.doesNotMatch(masked, /5,750|€/);
  assert.match(masked, /Labtodate sent the buyer an offer \(revision 1\)/);
  const update = 'Updated offer (revision 2) for "X": £4,600 excl. VAT. Valid until 3 Nov 2026.\nPrevious offer: €5,750 excl. VAT.';
  assert.doesNotMatch(supplierSafeBody(update, { brand, showSellPrice: false }), /4,600|5,750/);
  const accepted = 'Offer accepted (revision 2): €6,958 incl. VAT 21% for "X". Order L2D-2026-ABCDEF and proforma PF-2026-00001 were created — payment due by 1 Nov 2026.';
  const a = supplierSafeBody(accepted, { brand, showSellPrice: false });
  assert.equal(a, 'The buyer accepted Labtodate’s offer. Buyer prices are not shown to suppliers.');
  assert.ok(isBuyerPriceMessage(own) && isBuyerPriceMessage(update) && isBuyerPriceMessage(accepted));
  // A normal reply is untouched; with SELLER_SEES_SELL_PRICE on the offer is shown.
  assert.equal(supplierSafeBody('Can you ship in May?', { brand, showSellPrice: false }), 'Can you ship in May?');
  assert.equal(supplierSafeBody(own, { brand, showSellPrice: true }), own);
});

test('order-cancel messages never reach the supplier with the buyer’s words, documents or refund amounts', () => {
  const byBuyer = 'Order L2D-2026-R8M8S3 was canceled by the buyer: Ordered by mistake — Budget moved to next quarter. Proforma PF-2026-00067 is void; no payment is due.';
  assert.equal(supplierSafeBody(byBuyer, { brand, showSellPrice: true }), 'The buyer canceled the order.');
  const byStaff = 'Order L2D-2026-R8M8S3 was canceled by Labtodate after payment: wrong unit. A refund of €1,210 is recorded and will be sent by bank transfer.';
  assert.equal(supplierSafeBody(byStaff, { brand, showSellPrice: true }), 'Labtodate canceled the order.');
  const auto = 'Order L2D-2026-R8M8S3 was canceled automatically: Not paid by the due date. No payment is due.';
  assert.equal(supplierSafeBody(auto, { brand, showSellPrice: false }), 'The order was canceled automatically.');
});

test('competing offers: the unit is unavailable once another acceptance holds it', () => {
  assert.equal(unitUnavailable({ quantity: 0, heldByThisQuote: false }, 1), true);
  assert.equal(unitUnavailable({ quantity: 0, heldByThisQuote: true }, 1), false); // held for this offer
  assert.equal(unitUnavailable({ quantity: 1, heldByThisQuote: false }, 1), false);
  assert.equal(unitUnavailable({ quantity: 1, heldByThisQuote: false }, 2), true);
  assert.equal(unitUnavailable(null, 1), true); // the listing is gone
});

test('part-paid order: "X received, Y open", net of refunds; nothing received → no line', () => {
  const o = { totalCents: 302_500, currency: 'EUR', amountPaidCents: 282_500, refunds: [] };
  assert.equal(partPaidLine(o), '€2,825 received, €200 open');
  assert.equal(partPaidLine({ ...o, amountPaidCents: 0 }), null);
  assert.equal(partPaidLine({ ...o, amountPaidCents: 302_500 }), null);
  // A refund owed (REQUESTED) is no longer held money; a REJECTED one does not count.
  assert.equal(receivedCents({ amountPaidCents: 100_000, refunds: [{ status: 'REQUESTED', amountCents: 40_000 }, { status: 'REJECTED', amountCents: 5_000 }] }), 60_000);
});

test('deal stage: receipt to verify first, then part paid, unpaid, terms, shipped, paid', () => {
  const base = { totalCents: 302_500, currency: 'EUR', amountPaidCents: 0, refunds: [] as Array<{ status: string; amountCents: number }> };
  assert.equal(dealStageOf({ ...base, status: 'PENDING_PAYMENT' }, false), 'UNPAID');
  assert.equal(dealStageOf({ ...base, status: 'PENDING_PAYMENT', amountPaidCents: 282_500 }, false), 'PART_PAID');
  assert.equal(dealStageOf({ ...base, status: 'PENDING_PAYMENT', amountPaidCents: 282_500, paymentSubmittedAt: new Date() }, false), 'PROOF');
  assert.equal(dealStageOf({ ...base, status: 'PROCESSING' }, true), 'TERMS');
  assert.equal(dealStageOf({ ...base, status: 'SHIPPED', shippedAt: new Date() }, true), 'SHIPPED');
  assert.equal(dealStageOf({ ...base, status: 'DELIVERED' }, false), 'SHIPPED');
  assert.equal(dealStageOf({ ...base, status: 'PAID' }, false), 'PAID');
  assert.equal(dealStageOf({ ...base, status: 'CANCELED' }, false), 'CANCELED');
  assert.equal(dealStageOf({ ...base, status: 'REFUNDED' }, false), 'REFUNDED');
});

test('close dialog text follows QUOTE_AUTO_ARCHIVE_ON_CLOSE', () => {
  assert.match(closeConfirmText({ autoArchive: true, hasOpenOffer: true }), /moves to Archived/);
  assert.doesNotMatch(closeConfirmText({ autoArchive: true, hasOpenOffer: true }), /Lost/);
  assert.match(closeConfirmText({ autoArchive: false, hasOpenOffer: false }), /moves to Lost/);
  assert.doesNotMatch(closeConfirmText({ autoArchive: false, hasOpenOffer: false }), /offer is withdrawn/);
});

test('queue: 103 quotes in pages of 50 — page 3 holds the last 3; out-of-range pages clamp', () => {
  assert.deepEqual(queuePage(103, 3, 50), { page: 3, pages: 3, skip: 100 });
  assert.deepEqual(queuePage(103, 9, 50), { page: 3, pages: 3, skip: 100 });
  assert.deepEqual(queuePage(103, Number.NaN, 50), { page: 1, pages: 3, skip: 0 });
  assert.deepEqual(queuePage(0, 1, 50), { page: 1, pages: 1, skip: 0 });
});

test('queue urgency order: priority, then status, then reply due, then newest', () => {
  const d = (s: string) => new Date(s);
  const rows = [
    { id: 'normal-pending', priority: 'NORMAL', status: 'PENDING', dueAt: null, createdAt: d('2026-10-01') },
    { id: 'vip-responded', priority: 'VIP', status: 'RESPONDED', dueAt: null, createdAt: d('2026-10-02') },
    { id: 'vip-pending-late', priority: 'VIP', status: 'PENDING', dueAt: d('2026-10-20'), createdAt: d('2026-10-03') },
    { id: 'vip-pending-soon', priority: 'VIP', status: 'PENDING', dueAt: d('2026-10-19'), createdAt: d('2026-10-04') },
    { id: 'normal-pending-new', priority: 'NORMAL', status: 'PENDING', dueAt: null, createdAt: d('2026-10-05') },
  ];
  assert.deepEqual(sortQueue(rows, 'urgency').map((r) => r.id), ['vip-pending-soon', 'vip-pending-late', 'vip-responded', 'normal-pending-new', 'normal-pending']);
  assert.deepEqual(sortQueue(rows, 'sla').map((r) => r.id).slice(0, 2), ['vip-pending-soon', 'vip-pending-late']);
  assert.deepEqual(sortQueue(rows, 'oldest').map((r) => r.id)[0], 'normal-pending');
  assert.deepEqual(sortQueue(rows, 'newest').map((r) => r.id)[0], 'normal-pending-new');
});

test('offer validity bounds: today .. one year', () => {
  assert.deepEqual(validUntilBounds(new Date('2026-10-18T09:00:00Z')), { min: '2026-10-18', max: '2027-10-18' });
});

test('deal badge after dispatch says shipped / delivered; invoice terms keep "unpaid"', () => {
  const paid = { state: 'won_paid', tone: 'emerald', label: 'Won · paid' };
  assert.equal(withFulfilment(paid, { status: 'DELIVERED', deliveredAt: new Date() }).label, 'Won · delivered');
  assert.equal(withFulfilment(paid, { status: 'SHIPPED', shippedAt: new Date() }).label, 'Won · shipped');
  assert.equal(withFulfilment(paid, { status: 'PAID' }).label, 'Won · paid');
  const terms = { state: 'won_paid', tone: 'sky', label: 'Won · on invoice terms (unpaid)' };
  assert.equal(withFulfilment(terms, { status: 'SHIPPED', shippedAt: new Date() }).label, 'Won · on invoice terms (unpaid)');
});
