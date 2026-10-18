import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrackingUrl,
  carriersProblem,
  fillTemplate,
  findCarrier,
  orderNextSteps,
  parseCarriers,
  parseReturnReasons,
  refundCapacity,
  remainingToShip,
  returnEligibility,
  returnReasonsProblem,
  settleCredit,
  shipBlockers,
  shipmentLinesProblem,
  shipProgress,
  trackingRequired,
  type NextStepInput,
} from './rules';
import { DEFAULT_CARRIERS, DEFAULT_RETURN_REASONS } from './settings-defs';

const bill = { company: 'Lab B.V.', name: 'Dr. A', vat: 'NL859876543B01', address: { line1: 'Keizersgracht 123', postal_code: '1015 CJ', city: 'Amsterdam', country: 'NL' } };
const ship = { name: 'Goods-in', phone: '+31 20 7654321', address: { line1: 'Keizersgracht 123', postal_code: '1015 CJ', city: 'Amsterdam', country: 'NL' } };

test('carriers: default list parses, links need {TRACKING} and https', () => {
  const list = parseCarriers(DEFAULT_CARRIERS);
  assert.equal(carriersProblem(DEFAULT_CARRIERS), null);
  assert.ok(list.length >= 8);
  const postnl = findCarrier(list, 'postnl');
  assert.equal(buildTrackingUrl(postnl, '3S ABC 123'), 'https://jouw.postnl.nl/track-and-trace/3S%20ABC%20123');
  const own = findCarrier(list, 'Own transport');
  assert.equal(own?.urlTemplate, null);
  assert.equal(buildTrackingUrl(own, 'X1'), null);
  assert.equal(trackingRequired(postnl, true), true);
  assert.equal(trackingRequired(own, true), false, 'own transport never needs a tracking number');
  assert.equal(trackingRequired(postnl, false), false);
  assert.match(carriersProblem('DHL | http://x.test/{TRACKING}') ?? '', /https/);
  assert.match(carriersProblem('DHL | https://x.test/track') ?? '', /\{TRACKING\}/);
  assert.match(carriersProblem('') ?? '', /at least one/);
  assert.equal(parseCarriers('A\na\nB | https://b.test/{TRACKING}').length, 2, 'duplicates ignored');
});

test('return reasons: TYPE | text lines, validated', () => {
  const r = parseReturnReasons(DEFAULT_RETURN_REASONS);
  assert.equal(returnReasonsProblem(DEFAULT_RETURN_REASONS), null);
  assert.equal(r[0].type, 'TRANSPORT_DAMAGE');
  assert.match(returnReasonsProblem('BROKEN | x') ?? '', /RETURN, TRANSPORT_DAMAGE/);
  assert.match(returnReasonsProblem('RETURN |') ?? '', /missing/);
});

test('templates fill known placeholders and keep unknown ones', () => {
  assert.equal(fillTemplate('Order {ORDER} — {X}', { ORDER: 'L2D-1' }), 'Order L2D-1 — {X}');
});

test('ship readiness: unpaid, incomplete details, blocked country and dispatch holds all block (owner report 5)', () => {
  const ok = { status: 'PAID', billingAddress: bill, shippingAddress: ship, openHolds: [], holdReason: null, shipCountryMode: 'ALLOW' as const };
  assert.deepEqual(shipBlockers(ok, { vatIdRule: 'EU' }), []);
  assert.match(shipBlockers({ ...ok, status: 'PENDING_PAYMENT' }).join(), /not paid/);
  assert.match(shipBlockers({ ...ok, shippingAddress: null }).join(), /delivery address/);
  assert.match(shipBlockers({ ...ok, shippingAddress: { ...ship, phone: '' } }).join(), /delivery phone/);
  assert.match(shipBlockers({ ...ok, billingAddress: { ...bill, vat: '' } }, { vatIdRule: 'EU' }).join(), /VAT ID/);
  assert.match(shipBlockers({ ...ok, shipCountryMode: 'BLOCK', shipCountry: 'RU' }).join(), /do not ship to RU/);
  assert.match(shipBlockers({ ...ok, openHolds: ['PAYMENT_REVIEW'] }).join(), /payment is under review/);
  assert.match(shipBlockers({ ...ok, holdReason: 'COMPLIANCE' }).join(), /export-compliance/);
  assert.deepEqual(shipBlockers({ ...ok, openHolds: ['VAT_REVIEW'] }), [], 'a VAT question does not stop the parcel');
  // Paid, but the unit is gone (PAYMENT_VERIFIED oversell): nothing ships until staff decide.
  assert.deepEqual(shipBlockers({ ...ok, openHolds: ['STOCK_SHORTAGE'] }), ['the unit is no longer in stock — decide refund, backorder or another unit']);
});

test('partial shipments: remaining units, progress, line validation', () => {
  const items = [{ id: 'a', quantity: 2 }, { id: 'b', quantity: 1 }];
  assert.deepEqual(remainingToShip(items, []), { a: 2, b: 1 });
  assert.equal(shipProgress(items, []), 'NONE');
  const first = [{ orderItemId: 'a', qty: 1 }];
  assert.equal(shipProgress(items, first), 'PARTIAL');
  assert.equal(shipProgress(items, [...first, { orderItemId: 'a', qty: 1 }, { orderItemId: 'b', qty: 1 }]), 'ALL');
  const rem = remainingToShip(items, first);
  assert.equal(shipmentLinesProblem([{ orderItemId: 'a', qty: 2 }], rem), 'only 1 unit(s) of an item are left to ship.');
  assert.match(shipmentLinesProblem([{ orderItemId: 'a', qty: 0 }], rem) ?? '', /at least one/);
  assert.match(shipmentLinesProblem([{ orderItemId: 'zz', qty: 1 }], rem) ?? '', /does not belong/);
  assert.equal(shipmentLinesProblem([{ orderItemId: 'a', qty: 1 }, { orderItemId: 'b', qty: 1 }], rem), null);
});

test('refunds: paid order → money; unpaid NET invoice → receivable only, no money refund (fiscal finding)', () => {
  const paid = { totalCents: 12100, paidCents: 12100, creditedCents: 0, refundedCents: 0, invoiced: true };
  assert.deepEqual(settleCredit(paid, 12100), { receivableCents: 0, refundCents: 12100 });
  assert.deepEqual(settleCredit(paid, 2000), { receivableCents: 0, refundCents: 2000 });
  const net = { totalCents: 12100, paidCents: 0, creditedCents: 0, refundedCents: 0, invoiced: true };
  assert.deepEqual(settleCredit(net, 12100), { receivableCents: 12100, refundCents: 0 });
  // Partly paid on terms: the open receivable is cancelled first, then money.
  const part = { totalCents: 10000, paidCents: 4000, creditedCents: 0, refundedCents: 0, invoiced: true };
  assert.deepEqual(settleCredit(part, 7000), { receivableCents: 6000, refundCents: 1000 });
  // After a 2000 money refund + credit note, 10100 left.
  const after = { totalCents: 12100, paidCents: 12100, creditedCents: 2000, refundedCents: 2000, invoiced: true };
  assert.equal(refundCapacity(after).maxCents, 10100);
  assert.match(String((settleCredit(after, 10101) as { error: string }).error), /at most 101\.00/);
  // A receivable credit (no money) leaves the paid money untouched.
  const netCredited = { totalCents: 12100, paidCents: 0, creditedCents: 2100, refundedCents: 0, invoiced: true };
  assert.deepEqual(refundCapacity(netCredited), { maxCents: 10000, receivableCents: 10000, moneyCents: 0 });
  // No invoice yet: only money received can go back, no credit.
  assert.deepEqual(refundCapacity({ ...paid, invoiced: false }), { maxCents: 12100, receivableCents: 0, moneyCents: 12100 });
});

test('returns: window from delivery, warranty claims after it, one open request at a time', () => {
  const cfg = { enabled: true, windowDays: 14, warrantyAfterWindow: true };
  const delivered = new Date('2026-09-01T10:00:00Z');
  const base = { status: 'DELIVERED', shippedAt: new Date('2026-08-29T10:00:00Z'), deliveredAt: delivered, warrantyMonths: [3], openReturn: false };
  const inWin = returnEligibility(base, cfg, new Date('2026-09-10T00:00:00Z'));
  assert.equal(inWin.canRequest, true);
  assert.equal(inWin.onlyWarranty, false);
  assert.equal(inWin.windowEndsAt?.toISOString().slice(0, 10), '2026-09-15');
  const late = returnEligibility(base, cfg, new Date('2026-10-20T00:00:00Z'));
  assert.equal(late.canRequest, true);
  assert.equal(late.onlyWarranty, true);
  const tooLate = returnEligibility(base, cfg, new Date('2027-01-05T00:00:00Z'));
  assert.equal(tooLate.canRequest, false);
  assert.match(tooLate.reason ?? '', /window ended/);
  assert.equal(returnEligibility({ ...base, warrantyMonths: [null] }, cfg, new Date('2026-10-20T00:00:00Z')).canRequest, false, 'no warranty → closed after the window');
  assert.equal(returnEligibility({ ...base, openReturn: true }, cfg, new Date('2026-09-10T00:00:00Z')).canRequest, false);
  assert.equal(returnEligibility({ ...base, status: 'PAID', shippedAt: null, deliveredAt: null }, cfg).canRequest, false);
  assert.equal(returnEligibility({ ...base, status: 'PROCESSING', deliveredAt: null }, cfg, new Date('2026-09-02T00:00:00Z')).canRequest, true, 'partly shipped: the shipped items can be reported');
  assert.equal(returnEligibility({ ...base, status: 'CANCELED' }, cfg, new Date('2026-09-10T00:00:00Z')).canRequest, false);
  assert.equal(returnEligibility(base, { ...cfg, enabled: false }, new Date('2026-09-10T00:00:00Z')).canRequest, false);
});

test('next steps: never empty, honest about refunds that are not sent yet', () => {
  const base: NextStepInput = {
    status: 'CANCELED', financialStatus: 'PAID', onTermsUnpaid: false, prePaymentHold: false, paymentVerificationStatus: null, paymentSubmitted: false,
    detailsMissing: [], shipBlockers: [], progress: 'NONE', deliveredAt: null, refunds: [{ status: 'REQUESTED', amountLabel: '€121.00' }], returns: [],
    returnWindowEndsAt: null, returnsOpen: false, buyerCanCancel: false, invoiceIssued: true,
  };
  const buyer = orderNextSteps(base, 'buyer');
  assert.match(buyer[0].text, /not sent yet/);
  assert.equal(buyer[0].who, 'staff');
  assert.match(orderNextSteps(base, 'staff')[0].text, /Mark refund sent/);
  const unpaid = orderNextSteps({ ...base, status: 'PENDING_PAYMENT', financialStatus: 'UNPAID', refunds: [], detailsMissing: ['delivery address'], buyerCanCancel: true }, 'buyer');
  assert.match(unpaid[0].text, /delivery address/);
  assert.match(unpaid[1].text, /cancel this order/);
  const blocked = orderNextSteps({ ...base, status: 'PAID', refunds: [], shipBlockers: ['billing / delivery details are incomplete'] }, 'staff');
  assert.match(blocked[0].text, /Before shipping/);
  assert.ok(orderNextSteps({ ...base, status: 'DELIVERED', refunds: [] }, 'buyer').length > 0);
});
