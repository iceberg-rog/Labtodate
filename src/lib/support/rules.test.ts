import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSupportHours,
  belongsToCustomer,
  businessHoursProblem,
  cleanFileName,
  customerReplyRule,
  initialPriority,
  isAwaitingSupport,
  keywordMatcher,
  localClock,
  maskEmail,
  mentionedOrderNumbers,
  mentionedProformaNumbers,
  parseAttachmentList,
  parseBusinessHours,
  parseSlaHours,
  slaAfterCustomerMessage,
  slaHoursProblem,
  tooManyRequestsMessage,
  type TriageInput,
} from './rules';

test('SLA hours per priority: parsed, validated, NORMAL always present', () => {
  assert.deepEqual(parseSlaHours('VIP:2,URGENT:2,HIGH:8,NORMAL:24,LOW:72'), { VIP: 2, URGENT: 2, HIGH: 8, NORMAL: 24, LOW: 72 });
  assert.deepEqual(parseSlaHours('high:4, bogus, LOW:x'), { HIGH: 4, NORMAL: 24 });
  assert.equal(slaHoursProblem('VIP:1,NORMAL:8'), null);
  assert.match(slaHoursProblem('VIP:2') ?? '', /NORMAL is required/);
  assert.match(slaHoursProblem('NORMAL:8,FAST:1') ?? '', /PRIORITY:hours/);
});

test('business hours: day ranges, several windows, readable problems', () => {
  assert.equal(businessHoursProblem(''), null);
  assert.equal(parseBusinessHours(''), null);
  assert.equal(businessHoursProblem('Mon-Fri 09:00-17:00'), null);
  assert.equal(businessHoursProblem('Mon-Thu 08:30-17:00, Fri 08:30-15:00'), null);
  assert.equal(businessHoursProblem('Mon-Fri 09:00 - 12:00 13:00-17:00; Sat 10:00-13:00'), null);
  assert.match(businessHoursProblem('weekdays 9-5') ?? '', /day or a day range/);
  assert.match(businessHoursProblem('Mon-Fri 17:00-09:00') ?? '', /end after the start/);
  assert.match(businessHoursProblem('Mon 25:00-26:00') ?? '', /HH:MM/);
  const s = parseBusinessHours('Mon-Thu 08:30-17:00, Fri 08:30-12:00 13:00-15:00')!;
  assert.deepEqual(s[0], []); // Sunday closed
  assert.deepEqual(s[1], [[510, 1020]]); // Monday
  assert.deepEqual(s[5], [[510, 720], [780, 900]]); // Friday with a lunch break
  assert.deepEqual(parseBusinessHours('Sat-Mon 10:00-12:00')!.map((d) => d.length), [1, 1, 0, 0, 0, 0, 1]); // wraps over the weekend
});

test('localClock reads the wall clock of the time zone (incl. DST)', () => {
  assert.deepEqual(localClock(new Date('2026-10-23T13:00:00Z'), 'Europe/Amsterdam'), { weekday: 5, minutes: 15 * 60 }); // CEST
  assert.deepEqual(localClock(new Date('2026-10-26T10:00:00Z'), 'Europe/Amsterdam'), { weekday: 1, minutes: 11 * 60 }); // CET
  assert.deepEqual(localClock(new Date('2026-10-26T10:00:00Z'), 'Not/AZone'), { weekday: 1, minutes: 10 * 60 }); // UTC fallback
});

test('addSupportHours: round the clock without a schedule, else only business hours', () => {
  const fri = new Date('2026-10-23T13:00:00Z'); // Friday 15:00 Amsterdam
  assert.equal(addSupportHours(fri, 24, null, 'Europe/Amsterdam').toISOString(), '2026-10-24T13:00:00.000Z');
  const week = parseBusinessHours('Mon-Fri 09:00-17:00');
  // 2 h left on Friday, 2 h on Monday — across the end of summer time.
  assert.equal(addSupportHours(fri, 4, week, 'Europe/Amsterdam').toISOString(), '2026-10-26T10:00:00.000Z');
  // A ticket on Saturday starts counting at Monday 09:00.
  assert.equal(addSupportHours(new Date('2026-10-24T10:00:00Z'), 2, week, 'UTC').toISOString(), '2026-10-26T11:00:00.000Z');
  // Exactly one business day.
  assert.equal(addSupportHours(new Date('2026-10-20T09:00:00Z'), 8, week, 'UTC').toISOString(), '2026-10-20T17:00:00.000Z');
  // 24 business hours = three working days.
  assert.equal(addSupportHours(new Date('2026-10-20T09:00:00Z'), 24, week, 'UTC').toISOString(), '2026-10-22T17:00:00.000Z');
  // Lunch break is skipped.
  const lunch = parseBusinessHours('Mon-Fri 09:00-12:00 13:00-17:00');
  assert.equal(addSupportHours(new Date('2026-10-20T11:00:00Z'), 2, lunch, 'UTC').toISOString(), '2026-10-20T14:00:00.000Z');
});

const triage = (over: Partial<TriageInput>): TriageInput => ({
  text: 'Question about the manual',
  lifetimeCents: 0,
  vipThresholdCents: 50_000_00,
  urgentWords: ['fraud', 'chargeback'],
  highWords: ['damaged', 'never arrived', 'refund'],
  unpaidOrderAgeHours: null,
  unpaidHighAfterHours: 24,
  ...over,
});

test('initialPriority: VIP, urgent / high words (whole words), unpaid order, else NORMAL', () => {
  assert.equal(initialPriority(triage({})), 'NORMAL');
  assert.equal(initialPriority(triage({ lifetimeCents: 50_000_00 })), 'VIP');
  assert.equal(initialPriority(triage({ lifetimeCents: 50_000_00, vipThresholdCents: 0 })), 'NORMAL'); // 0 = off
  assert.equal(initialPriority(triage({ text: 'I filed a CHARGEBACK' })), 'URGENT');
  assert.equal(initialPriority(triage({ text: 'The parcel never  arrived.' })), 'HIGH');
  assert.equal(initialPriority(triage({ text: 'undamaged and fine' })), 'NORMAL'); // not a whole word
  assert.equal(initialPriority(triage({ text: 'fraud', urgentWords: [] })), 'NORMAL');
  assert.equal(initialPriority(triage({ unpaidOrderAgeHours: 30 })), 'HIGH');
  assert.equal(initialPriority(triage({ unpaidOrderAgeHours: 30, unpaidHighAfterHours: 0 })), 'NORMAL');
  assert.equal(initialPriority(triage({ unpaidOrderAgeHours: 3 })), 'NORMAL');
});

test('keywordMatcher escapes regex characters', () => {
  assert.equal(keywordMatcher([]), null);
  assert.equal(keywordMatcher(['c++ (broken)'])!.test('my c++ (broken) driver'), true);
  assert.equal(keywordMatcher(['a.b'])!.test('axb'), false);
});

test('order and proforma numbers mentioned in a text', () => {
  assert.deepEqual(mentionedOrderNumbers('see l2d-2026-abc123 and L2D-2026-ABC123, also L2D-2026-ZZZ999'), ['L2D-2026-ABC123', 'L2D-2026-ZZZ999']);
  assert.deepEqual(mentionedProformaNumbers('PRO-2026-QWE123'), ['PRO-2026-QWE123']);
  assert.deepEqual(mentionedOrderNumbers('no number'), []);
});

test('belongsToCustomer: same account, or the ticket e-mail is the order’s account / invoice e-mail', () => {
  const order = { ownerId: 'u1', emails: ['Buyer@Lab.com', 'ap@lab.com'] };
  assert.equal(belongsToCustomer(order, { userId: 'u1', email: 'x@y.z' }), true);
  assert.equal(belongsToCustomer(order, { userId: null, email: 'buyer@lab.com ' }), true);
  assert.equal(belongsToCustomer(order, { userId: null, email: 'AP@lab.com' }), true);
  assert.equal(belongsToCustomer(order, { userId: 'u2', email: 'other@lab.com' }), false);
  assert.equal(belongsToCustomer({ ownerId: null, emails: [null] }, { userId: null, email: '' }), false);
});

test('customerReplyRule: spam never, resolved / closed reopen within the period', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const day = 86400e3;
  assert.deepEqual(customerReplyRule({ status: 'SPAM', updatedAt: now }, 14, now), { canReply: false, reopens: false, reopenUntil: null });
  const resolved = customerReplyRule({ status: 'RESOLVED', updatedAt: new Date(now.getTime() - 3 * day) }, 14, now);
  assert.equal(resolved.canReply, true);
  assert.equal(resolved.reopens, true);
  assert.equal(resolved.reopenUntil!.toISOString(), '2026-10-29T12:00:00.000Z');
  assert.equal(customerReplyRule({ status: 'CLOSED', updatedAt: new Date(now.getTime() - 15 * day) }, 14, now).canReply, false);
  assert.deepEqual(customerReplyRule({ status: 'WAITING_ON_CUSTOMER', updatedAt: now, archivedAt: now }, 14, now), { canReply: true, reopens: true, reopenUntil: null });
  assert.deepEqual(customerReplyRule({ status: 'OPEN', updatedAt: now, archivedAt: null }, 14, now), { canReply: true, reopens: false, reopenUntil: null });
});

test('SLA after a customer message: restart when the ball was with the customer, keep a running deadline', () => {
  const due = new Date();
  assert.equal(slaAfterCustomerMessage({ status: 'WAITING_ON_CUSTOMER', dueAt: due, lastReplyByStaff: true }), 'restart');
  // Staff replied but the old deadline stayed (tickets from before the fix).
  assert.equal(slaAfterCustomerMessage({ status: 'WAITING_ON_SUPPORT', dueAt: due, lastReplyByStaff: true }), 'restart');
  assert.equal(slaAfterCustomerMessage({ status: 'RESOLVED', dueAt: null, lastReplyByStaff: true }), 'restart');
  assert.equal(slaAfterCustomerMessage({ status: 'OPEN', dueAt: null, lastReplyByStaff: false }), 'restart');
  // A nudge while we already owe a reply keeps the oldest deadline.
  assert.equal(slaAfterCustomerMessage({ status: 'WAITING_ON_SUPPORT', dueAt: due, lastReplyByStaff: false }), 'keep');
  assert.equal(isAwaitingSupport('WAITING_ON_CUSTOMER'), false);
});

test('parseAttachmentList: proxy URLs only, at most five, names aligned and cleaned', () => {
  const urls = ['/api/support-attachment/support-att/a.pdf', 'https://s3/evil.pdf', '/media/x.png', '/api/support-attachment/support-att/b.png'];
  assert.deepEqual(parseAttachmentList(JSON.stringify(urls), JSON.stringify(['Offer.pdf', 'x', 'y', 'C:\\fakepath\\photo 1.png'])), {
    urls: ['/api/support-attachment/support-att/a.pdf', '/api/support-attachment/support-att/b.png'],
    names: ['Offer.pdf', 'photo 1.png'],
  });
  const many = Array.from({ length: 7 }, (_, i) => `/api/support-attachment/support-att/${i}.png`);
  assert.equal(parseAttachmentList(many).urls.length, 5);
  assert.deepEqual(parseAttachmentList(['/api/support-attachment/support-att/z.pdf']).names, ['z.pdf']); // no name → the key
  assert.deepEqual(parseAttachmentList('not json'), { urls: [], names: [] });
  assert.equal(cleanFileName('a' + String.fromCharCode(7) + 'b.pdf', 'x'), 'a b.pdf');
});

test('readable limit and masked e-mail texts', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  assert.equal(tooManyRequestsMessage(new Date(now.getTime() + 7.2 * 60_000), now), 'Too many requests — try again in 8 minutes.');
  assert.equal(tooManyRequestsMessage(new Date(now.getTime() + 10_000), now), 'Too many requests — try again in 1 minute.');
  assert.equal(maskEmail('jane.doe@lab.com'), 'j•••@lab.com');
});
