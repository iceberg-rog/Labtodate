import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedMessageAmount, offerMessageAmount, timelineEvents, type TimelineInput } from './activity-timeline';

const AMS = 'Europe/Amsterdam';
const t = (iso: string) => new Date(iso);
const staff = { name: 'Anna Staff', email: 'anna@labtodate.com', role: 'ADMIN' };
const supplier = { name: 'Sam Supplier', email: 'sam@supplier.test', role: 'SELLER' };
const buyer = { name: 'Bea Buyer', email: 'bea@uni.test', role: 'BUYER' };

test('offer amount as the buyer saw it: total incl. VAT, else goods + freight excl. VAT', () => {
  assert.deepEqual(
    offerMessageAmount('Offer (revision 1) for "Agilent 7890B": €9,000 + freight €400 excl. VAT; VAT 21%: €1,974; total €11,374. Valid until 1 Nov 2026.'),
    { revision: 1, update: false, amount: '€11,374' },
  );
  assert.deepEqual(
    offerMessageAmount('Updated offer (revision 2) for "A: "B"": 2 × €4,500.50 = €9,001 + freight €400.25 excl. VAT; VAT is determined from your billing details when you accept. Valid until 1 Nov 2026.\nPrevious offer: €11,374.'),
    { revision: 2, update: true, amount: '€9,401.25 excl. VAT' },
  );
  assert.deepEqual(
    offerMessageAmount('Offer (revision 3) for "X": CHF 12,000 excl. VAT; VAT 0%: CHF 0; total CHF 12,000.50. Valid until 1 Nov 2026.'),
    { revision: 3, update: false, amount: 'CHF 12,000.50' },
  );
  assert.equal(offerMessageAmount('Can you ship in May?'), null);
  assert.deepEqual(acceptedMessageAmount('Offer accepted (revision 3): €8,712 incl. VAT 21% for "X". Order L2D-2026-AB12CD …'), { revision: 3, amount: '€8,712 incl. VAT' });
  // Accepted under a VAT review: the amount is net, the VAT follows.
  assert.deepEqual(
    acceptedMessageAmount('Offer accepted (revision 2): €9,400 excl. VAT for "X" — the VAT is confirmed by Labtodate before payment. Order L2D-2026-AB12CD was created; the proforma invoice follows once the VAT is confirmed.'),
    { revision: 2, amount: '€9,400 excl. VAT' },
  );
  assert.deepEqual(acceptedMessageAmount('Offer accepted (revision 4).'), { revision: 4, amount: null });
  assert.equal(acceptedMessageAmount('Offer accepted, thanks!'), null);
});

function deal(): TimelineInput {
  return {
    brand: 'Labtodate',
    timeZone: AMS,
    now: t('2026-10-30T12:00:00Z'),
    sr: {
      createdAt: t('2026-10-01T08:00:00Z'),
      updatedAt: t('2026-10-20T09:00:00Z'),
      buyerName: 'Bea Buyer',
      status: 'ACCEPTED',
      quotedAt: t('2026-10-05T10:00:00Z'),
      quotedPriceCents: 720_000,
      quotedCurrency: 'EUR',
      offerRevision: 3,
      offerSubtotalCents: 720_000,
      offerShippingCents: 0,
      offerVatTreatment: 'DOMESTIC_STANDARD',
      offerVatRateBp: 2100,
      offerVatCents: 151_200,
      offerTotalCents: 871_200,
      validUntilAt: t('2026-10-19T21:59:59Z'),
      proformaNumber: 'PF-2026-00004',
      proformaIssuedAt: null,
      slaBreachAt: null,
      lostReason: null,
      assignedTo: null,
    },
    messages: [
      { createdAt: t('2026-10-02T09:00:00Z'), fromStaff: true, isInternalNote: false, body: 'Offer (revision 1) for "X": €9,000 + freight €400 excl. VAT; VAT 21%: €1,974; total €11,374. Valid until 15 Oct 2026.', author: staff },
      { createdAt: t('2026-10-03T09:00:00Z'), fromStaff: true, isInternalNote: false, body: 'We can also include the autosampler.', author: supplier },
      { createdAt: t('2026-10-03T10:00:00Z'), fromStaff: false, isInternalNote: false, body: 'Too expensive for us.', author: buyer },
      { createdAt: t('2026-10-04T09:00:00Z'), fromStaff: true, isInternalNote: false, body: 'Updated offer (revision 2) for "X": €8,000 excl. VAT; VAT 21%: €1,680; total €9,680. Valid until 18 Oct 2026.\nPrevious offer: €11,374.', author: staff },
      { createdAt: t('2026-10-05T10:00:00Z'), fromStaff: true, isInternalNote: false, body: 'Updated offer (revision 3) for "X": €7,200 excl. VAT; VAT 21%: €1,512; total €8,712. Valid until 19 Oct 2026.', author: staff },
      { createdAt: t('2026-10-06T08:00:00Z'), fromStaff: true, isInternalNote: true, body: 'Margin ok.', author: staff },
      { createdAt: t('2026-10-07T09:00:00Z'), fromStaff: false, isInternalNote: false, body: 'Offer accepted (revision 3): €8,712 incl. VAT 21% for "X". Order L2D-2026-AB12CD and proforma PF-2026-00004 were created — payment due by 21 Oct 2026.', author: buyer },
    ],
    order: {
      orderNumber: 'L2D-2026-AB12CD',
      createdAt: t('2026-10-07T09:00:01Z'),
      status: 'DELIVERED',
      dueAt: t('2026-10-21T21:59:59Z'),
      // The bank's value date: noon UTC, BEFORE the acceptance it pays for.
      paidAt: t('2026-10-06T12:00:00Z'),
      paymentSubmittedAt: t('2026-10-08T10:00:00Z'),
      paymentVerifiedAt: t('2026-10-09T14:00:00Z'),
      shippedAt: t('2026-10-12T09:00:00Z'),
      deliveredAt: t('2026-10-15T15:00:00Z'),
      trackingCarrier: 'DHL',
      trackingNumber: 'JD0001',
    },
  };
}

test('3-revision deal: three offers with the totals the buyer saw, in true order, through delivery', () => {
  const ev = timelineEvents(deal());
  const offers = ev.filter((e) => e.kind === 'offer_sent').map((e) => e.title);
  assert.deepEqual(offers, ['Offer sent · revision 1: €11,374', 'Offer updated · revision 2: €9,680', 'Offer updated · revision 3: €8,712']);
  assert.deepEqual(ev.map((e) => e.kind), [
    'submitted', 'offer_sent', 'supplier_reply', 'buyer_reply', 'offer_sent', 'offer_sent', 'internal_note',
    'accepted', 'order_created', 'payment_submitted', 'order_paid', 'order_shipped', 'order_delivered',
  ]);
  // The acceptance is the buyer's, not "Buyer replied"; the supplier is not "Staff".
  assert.equal(ev.find((e) => e.kind === 'accepted')?.title, 'Buyer accepted revision 3: €8,712 incl. VAT');
  assert.equal(ev.find((e) => e.kind === 'supplier_reply')?.title, 'Supplier replied (Sam Supplier)');
  // Paid is dated when it was booked, with the value date as detail.
  const paid = ev.find((e) => e.kind === 'order_paid')!;
  assert.equal(paid.at.toISOString(), '2026-10-09T14:00:00.000Z');
  assert.equal(paid.detail, 'Value date 6 Oct 2026');
  assert.equal(ev.find((e) => e.kind === 'order_shipped')?.detail, 'DHL · JD0001');
  // Once paid: no "payment due", and never one built from the offer validity.
  assert.equal(ev.some((e) => e.kind === 'payment_due' || e.kind === 'offer_valid_until'), false);
  // Every event is chronological.
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i - 1].at.getTime() <= ev[i].at.getTime());
});

test('unpaid accepted order: payment due from the order due date (Amsterdam day), last', () => {
  const i = deal();
  i.order = { ...i.order!, status: 'PENDING_PAYMENT', paidAt: null, paymentSubmittedAt: null, paymentVerifiedAt: null, shippedAt: null, deliveredAt: null };
  const ev = timelineEvents(i);
  const due = ev.at(-1)!;
  assert.equal(due.kind, 'payment_due');
  // 21:59:59Z on 21 Oct is 23:59:59 in Amsterdam — still 21 Oct there.
  assert.equal(due.title, 'Payment due 21 Oct 2026');
});

test('open offer: its validity; staff replies carry the brand; a legacy offer without revision messages gets one event', () => {
  const i = deal();
  i.sr = { ...i.sr, status: 'RESPONDED', offerRevision: 0, offerTotalCents: null, offerVatTreatment: null, offerVatCents: null, offerShippingCents: 35_000, validUntilAt: t('2026-11-30T22:59:59Z') };
  i.order = null;
  i.messages = [{ createdAt: t('2026-10-02T09:00:00Z'), fromStaff: true, isInternalNote: false, body: 'We will check stock.', author: staff }];
  const ev = timelineEvents(i);
  assert.equal(ev.find((e) => e.kind === 'staff_reply')?.title, 'Labtodate replied (Anna Staff)');
  assert.equal(ev.find((e) => e.kind === 'offer_sent')?.title, 'Offer sent: €7,550 excl. VAT');
  assert.equal(ev.find((e) => e.kind === 'offer_valid_until')?.title, 'Offer valid until 30 Nov 2026');
});

test('accepted under a VAT review: one "accepted" event, excl. VAT — not "Buyer replied", no second acceptance', () => {
  const i = deal();
  i.order = { ...i.order!, status: 'PENDING_PAYMENT', paidAt: null, paymentSubmittedAt: null, paymentVerifiedAt: null, shippedAt: null, deliveredAt: null };
  i.messages = [
    ...i.messages.slice(0, -1),
    { createdAt: t('2026-10-07T09:00:00Z'), fromStaff: false, isInternalNote: false, body: 'Offer accepted (revision 3): €7,200 excl. VAT for "X" — the VAT is confirmed by Labtodate before payment. Order L2D-2026-AB12CD was created; the proforma invoice follows once the VAT is confirmed.', author: buyer },
  ];
  const ev = timelineEvents(i);
  const accepted = ev.filter((e) => e.kind === 'accepted');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].title, 'Buyer accepted revision 3: €7,200 excl. VAT');
  // Only the buyer's real reply ("Too expensive for us.") is a reply.
  assert.deepEqual(ev.filter((e) => e.kind === 'buyer_reply').map((e) => e.detail), ['Too expensive for us.']);
});

test('declined: the decline message with its reason; closed: the close reason', () => {
  const i = deal();
  i.order = null;
  i.sr = { ...i.sr, status: 'DECLINED' };
  i.messages = [
    { createdAt: t('2026-10-02T09:00:00Z'), fromStaff: true, isInternalNote: false, body: 'Offer (revision 1) for "X": €9,000 excl. VAT; VAT 21%: €1,890; total €10,890. Valid until 15 Oct 2026.', author: staff },
    { createdAt: t('2026-10-03T09:00:00Z'), fromStaff: false, isInternalNote: false, body: 'Offer declined — Price too high.\nWe got €8,000 elsewhere.', author: buyer },
  ];
  const ev = timelineEvents(i);
  const declined = ev.filter((e) => e.kind === 'declined');
  assert.equal(declined.length, 1);
  assert.match(declined[0].detail ?? '', /^Price too high/);
  const closed = timelineEvents({ ...i, sr: { ...i.sr, status: 'CLOSED', lostReason: 'Bought elsewhere' }, messages: [] });
  assert.equal(closed.find((e) => e.kind === 'closed')?.detail, 'Bought elsewhere');
});
