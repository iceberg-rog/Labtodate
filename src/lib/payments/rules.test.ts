import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  announcementLinkProblem, bookingHoldBlocker, briefText, countryPolicyValue, dayInZone, fmtValueDay, holdResolvedAt, lowAmountNeedsConfirm, manualPaymentBlocker,
  parseAmountInput, proofKeyOf, readReceived, receiptAmountLabel, receiptHistory, withoutHold,
} from './rules';

const cents = (s: string) => {
  const r = parseAmountInput(s);
  return r.ok ? r.cents : r.message;
};

test('amounts: Dutch and English thousands, decimals with a comma or a dot', () => {
  assert.equal(cents('1210'), 121000);
  assert.equal(cents('1210.00'), 121000);
  assert.equal(cents('1210,5'), 121050);
  assert.equal(cents('1.210,00'), 121000);
  assert.equal(cents('1,210.00'), 121000);
  assert.equal(cents('€ 2.480,50'), 248050);
  assert.equal(cents('2 480,50'), 248050);
  assert.equal(cents('1.234.567'), 123456700);
  assert.equal(cents('1,234,567.89'), 123456789);
  assert.equal(cents('12.10'), 1210);
  assert.equal(cents('0,99'), 99);
  assert.equal(cents('EUR 1210.00'), 121000);
});

test('amounts: a single separator before three digits is ambiguous and refused', () => {
  for (const s of ['1.210', '1,210', '12.500', '999,000']) {
    const r = parseAmountInput(s);
    assert.equal(r.ok, false, s);
    if (!r.ok) assert.match(r.message, /ambiguous/, s);
  }
  const r = parseAmountInput('1.210');
  assert.ok(!r.ok && r.message.includes('1210.00') && r.message.includes('1.21'));
});

test('amounts: garbage, zero and three decimals are refused', () => {
  for (const s of ['', 'abc', '0', '0,00', '1.2345', '1,21.0', '-5', '1.210.5']) assert.equal(parseAmountInput(s).ok, false, s);
});

const base = {
  amount: '1210.00', date: '2026-10-18', bankRef: '', required: true, openCents: 121000,
  orderCreatedAt: new Date('2026-10-18T09:30:00Z'), confirmEarlierDate: false, now: new Date('2026-10-18T15:00:00Z'), timeZone: 'Europe/Amsterdam',
};

test('received: the value date is a day (noon UTC), the bank reference is kept', () => {
  const r = readReceived({ ...base, bankRef: '  NL-REF-1 ' });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.amountCents, 121000);
    assert.equal(r.receivedAt.toISOString(), '2026-10-18T12:00:00.000Z');
    assert.equal(r.bankRef, 'NL-REF-1');
  }
  assert.equal(fmtValueDay('2026-10-16T12:00:00.000Z'), '16 Oct 2026');
});

test('received: a value date before the order date needs the confirmation tick', () => {
  const r = readReceived({ ...base, date: '2026-10-16' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.confirm, 'EARLIER_DATE');
    assert.match(r.message, /16 October 2026 is before the order date \(18 October 2026\)/);
  }
  assert.ok(readReceived({ ...base, date: '2026-10-16', confirmEarlierDate: true }).ok);
  // The order day is the Amsterdam day: created 17 Oct 23:30 UTC = 18 Oct in Amsterdam.
  const late = { ...base, orderCreatedAt: new Date('2026-10-17T23:30:00Z') };
  assert.equal(readReceived({ ...late, date: '2026-10-17' }).ok, false);
  assert.ok(readReceived({ ...late, date: '2026-10-18' }).ok);
  assert.equal(dayInZone(new Date('2026-10-17T23:30:00Z'), 'Europe/Amsterdam'), '2026-10-18');
});

test('received: required fields, future and very old dates, ambiguous amounts', () => {
  assert.equal(readReceived({ ...base, amount: '' }).ok, false);
  assert.equal(readReceived({ ...base, date: '' }).ok, false);
  const optional = readReceived({ ...base, amount: '', date: '', required: false });
  assert.ok(optional.ok && optional.amountCents === 121000 && optional.receivedAt.getTime() === base.now.getTime());
  assert.equal(readReceived({ ...base, date: '2026-10-21' }).ok, false);
  assert.equal(readReceived({ ...base, date: '2025-01-01', orderCreatedAt: new Date('2024-12-01T10:00:00Z') }).ok, false);
  const amb = readReceived({ ...base, amount: '1.210' });
  assert.ok(!amb.ok && /ambiguous/.test(amb.message));
});

test('a receipt far below the open amount asks for a confirmation', () => {
  assert.equal(lowAmountNeedsConfirm(121, 121000, 50), true);
  assert.equal(lowAmountNeedsConfirm(60_000, 121000, 50), true);
  assert.equal(lowAmountNeedsConfirm(60_500, 121000, 50), false);
  assert.equal(lowAmountNeedsConfirm(121, 121000, 0), false);
});

test('mark as paid is refused while a receipt waits, on invoice-terms requests, holds and payment reviews', () => {
  const ok = { holdMessage: null, holdReason: null, openHolds: [], paymentVerificationStatus: null };
  assert.equal(manualPaymentBlocker(ok), null);
  assert.equal(manualPaymentBlocker({ ...ok, paymentVerificationStatus: 'REJECTED' }), null);
  assert.match(manualPaymentBlocker({ ...ok, paymentVerificationStatus: 'AWAITING_VERIFICATION' }) ?? '', /verify or reject the buyer’s receipt/);
  assert.match(manualPaymentBlocker({ ...ok, paymentVerificationStatus: 'TERMS_REQUESTED' }) ?? '', /pay on invoice/);
  const held = 'Order L2D-1 is waiting for an export-compliance review — no proforma (payment request) is issued until that is done.';
  assert.match(manualPaymentBlocker({ ...ok, holdMessage: held, holdReason: 'COMPLIANCE', openHolds: ['COMPLIANCE'] }) ?? '', /export-compliance.*can not be marked paid/);
  assert.match(manualPaymentBlocker({ ...ok, openHolds: ['PAYMENT_REVIEW'] }) ?? '', /under review/);
});

test('verifying a receipt is refused under the same holds — with the way out (clear the hold or reject)', () => {
  const none = { holdMessage: null, holdReason: null, openHolds: [] as string[] };
  assert.equal(bookingHoldBlocker(none, 'VERIFY'), null);
  // A stock shortage or an invoice hold is no reason to refuse booking money.
  assert.equal(bookingHoldBlocker({ ...none, openHolds: ['STOCK_SHORTAGE', 'INVOICE_PENDING'] }, 'VERIFY'), null);
  const held = 'Order L2D-1 is waiting for an export-compliance review — no proforma (payment request) is issued until that is done.';
  const v = bookingHoldBlocker({ holdMessage: held, holdReason: 'COMPLIANCE', openHolds: ['COMPLIANCE'] }, 'VERIFY') ?? '';
  assert.match(v, /export-compliance.*receipt can not be verified.*or reject the receipt/);
  assert.match(bookingHoldBlocker({ ...none, holdReason: 'PAYMENT_REVIEW' }, 'VERIFY') ?? '', /under review/);
});

test('releasing one hold keeps the others, the primary one and their notes', () => {
  const prio = ['COMPLIANCE', 'VAT_REVIEW', 'ADDRESS_REVIEW', 'SHIPPING_PENDING', 'PAYMENT_REVIEW', 'INVOICE_PENDING'];
  assert.deepEqual(withoutHold({ openHolds: ['STOCK_SHORTAGE'], holdReason: 'STOCK_SHORTAGE', holdNote: 'STOCK_SHORTAGE: sold to L2D-2' }, 'STOCK_SHORTAGE', prio), { openHolds: [], holdReason: null, holdNote: null });
  assert.deepEqual(
    withoutHold({ openHolds: ['ADDRESS_REVIEW', 'STOCK_SHORTAGE'], holdReason: 'ADDRESS_REVIEW', holdNote: 'ADDRESS_REVIEW: NL → DE | STOCK_SHORTAGE: sold' }, 'STOCK_SHORTAGE', prio),
    { openHolds: ['ADDRESS_REVIEW'], holdReason: 'ADDRESS_REVIEW', holdNote: 'ADDRESS_REVIEW: NL → DE' },
  );
  // The released hold was the primary one: the next by priority (or any other) takes its place.
  assert.equal(withoutHold({ openHolds: ['STOCK_SHORTAGE', 'FRAUD', 'VAT_REVIEW'], holdReason: 'STOCK_SHORTAGE', holdNote: null }, 'STOCK_SHORTAGE', prio).holdReason, 'VAT_REVIEW');
  assert.equal(withoutHold({ openHolds: ['STOCK_SHORTAGE', 'FRAUD'], holdReason: 'STOCK_SHORTAGE', holdNote: null }, 'STOCK_SHORTAGE', prio).holdReason, 'FRAUD');
});

test('the quick view points only to holds that have a control on the order page', () => {
  const unpaidCheckout = { unpaid: true, checkoutOrder: true };
  const paidQuote = { unpaid: false, checkoutOrder: false };
  assert.equal(holdResolvedAt('COMPLIANCE', paidQuote), 'Pricing, VAT & holds');
  assert.equal(holdResolvedAt('SHIPPING_PENDING', unpaidCheckout), 'Pricing, VAT & holds');
  assert.equal(holdResolvedAt('SHIPPING_PENDING', paidQuote), null);
  assert.equal(holdResolvedAt('VAT_REVIEW', { unpaid: true, checkoutOrder: false }), null);
  assert.equal(holdResolvedAt('VAT_REVIEW', paidQuote), 'Invoice decisions & corrections');
  assert.equal(holdResolvedAt('INVOICE_PENDING', paidQuote), 'Invoice decisions & corrections');
  assert.equal(holdResolvedAt('STOCK_SHORTAGE', paidQuote), 'Stock shortage');
  for (const code of ['FRAUD', 'SUPPLIER_CONFIRMATION', 'SOMETHING_NEW']) assert.equal(holdResolvedAt(code, paidQuote), null, code);
});

test('the staff receipt notice names the open amount of a rest payment', () => {
  const fmt = (c: number) => `€${(c / 100).toFixed(2)}`;
  assert.equal(receiptAmountLabel(20000, 248050, fmt), 'the €200.00 still due (of €2480.50)');
  assert.equal(receiptAmountLabel(248050, 248050, fmt), '€2480.50');
});

test('receipts: every upload stays listed with what became of it', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 18, h));
  const rows = receiptHistory({
    proofs: [
      { key: 'order-proofs/A-1.pdf', kind: 'SUBMITTED', fileName: 'first.pdf', amountCents: null, rejectedReason: null, createdAt: t(8) },
      { key: 'order-proofs/A-1.pdf', kind: 'REJECTED', fileName: 'first.pdf', amountCents: null, rejectedReason: 'Illegible', createdAt: t(9) },
      { key: 'order-proofs/A-2.pdf', kind: 'SUBMITTED', fileName: 'second.pdf', amountCents: null, rejectedReason: null, createdAt: t(10) },
      { key: 'order-proofs/A-2.pdf', kind: 'PART', fileName: 'second.pdf', amountCents: 20000, rejectedReason: null, createdAt: t(11) },
      { key: 'order-proofs/A-3.pdf', kind: 'SUBMITTED', fileName: 'rest.pdf', amountCents: null, rejectedReason: null, createdAt: t(12) },
    ],
    payments: [
      { proofKey: 'https://s3.example/bucket/order-proofs/A-2.pdf', amountCents: 20000 },
      { proofKey: 'https://s3.example/bucket/order-proofs/A-3.pdf', amountCents: 228050 },
    ],
    currentProofUrl: 'https://s3.example/bucket/order-proofs/A-3.pdf',
    verificationStatus: 'VERIFIED',
  });
  assert.deepEqual(rows.map((r) => [r.key, r.status, r.amountCents, r.reason]), [
    ['order-proofs/A-1.pdf', 'REJECTED', null, 'Illegible'],
    ['order-proofs/A-2.pdf', 'PART', 20000, null],
    ['order-proofs/A-3.pdf', 'VERIFIED', 228050, null],
  ]);
  // A replaced upload (new file sent before review) and an order from before receipts were kept.
  const replaced = receiptHistory({
    proofs: [
      { key: 'order-proofs/B-1.png', kind: 'SUBMITTED', fileName: null, amountCents: null, rejectedReason: null, createdAt: t(8) },
      { key: 'order-proofs/B-2.png', kind: 'SUBMITTED', fileName: null, amountCents: null, rejectedReason: null, createdAt: t(9) },
    ],
    payments: [],
    currentProofUrl: 'order-proofs/B-2.png',
    verificationStatus: 'AWAITING_VERIFICATION',
  });
  assert.deepEqual(replaced.map((r) => r.status), ['REPLACED', 'AWAITING']);
  const legacy = receiptHistory({ proofs: [], payments: [], currentProofUrl: 'https://x/order-proofs/C.pdf', verificationStatus: 'REJECTED' });
  assert.deepEqual(legacy.map((r) => [r.key, r.status]), [['order-proofs/C.pdf', 'ON_FILE']]);
  const manual = receiptHistory({
    proofs: [{ key: 'order-proofs/D.pdf', kind: 'MANUAL', fileName: 'stmt.pdf', amountCents: 5000, rejectedReason: null, createdAt: t(8) }],
    payments: [{ proofKey: 'order-proofs/D.pdf', amountCents: 5000 }],
    currentProofUrl: 'order-proofs/D.pdf',
    verificationStatus: null,
  });
  assert.deepEqual(manual.map((r) => [r.by, r.status]), [['STAFF', 'BOOKED']]);
  assert.equal(proofKeyOf('https://cdn/x/order-proofs/L2D-1.pdf?sig=1'), 'order-proofs/L2D-1.pdf');
  assert.equal(proofKeyOf('products/a.png'), null);
});

test('announcement links: site pages and https only — never //host or /\\host', () => {
  assert.equal(announcementLinkProblem('/marketplace'), null);
  assert.equal(announcementLinkProblem('/app/orders/L2D-1?x=1'), null);
  assert.equal(announcementLinkProblem('https://labtodate.com/blog'), null);
  for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', '/ /evil', 'http://evil.com', 'javascript:alert(1)', 'evil.com', 'https://', 'https:/evil.com']) {
    assert.ok(announcementLinkProblem(bad), bad);
  }
});

test('texts are cut on a word boundary, never mid-word', () => {
  const s = 'void=PF-2026-00011 · units=1 · buyer emailed with the reason Changed plans';
  const cut = briefText(s, 40);
  assert.ok(cut.endsWith('…') && cut.length <= 41);
  assert.doesNotMatch(cut, /buyer e…$/);
  assert.equal(briefText('short text', 40), 'short text');
});

test('country policy change-history value', () => {
  assert.equal(countryPolicyValue({ name: 'Austria', mode: 'ALLOW', isEu: true, vatStandardRateBp: 2000 }), 'Austria: allow · EU member · VAT 20%');
  assert.equal(countryPolicyValue({ name: 'Austria', mode: 'ALLOW', isEu: false, vatStandardRateBp: null, note: 'test' }), 'Austria: allow · not EU · no VAT rate · test');
  assert.equal(countryPolicyValue(null), null);
});
