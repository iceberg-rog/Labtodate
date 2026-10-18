import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTACT_REMOVED, HELD_PREFIX, WITHHELD_PREFIX, deliveryState, ibanChecksumOk, maskContacts, mediateMessage, mediationMode,
  messageFlags, messageText, sanitizeMessageInput, screeningSummary, storedBody,
} from './mediation';
import { mediationNotice, participantMessages } from './view';

test('the QA bypass messages lose every contact detail but keep the text around them', () => {
  const s1 = 'Buy it directly from us for EUR 9,500 - call me on +31 6 1234 5678 or mail jan.devries@biolab-direct.nl and skip the platform fee';
  const r1 = maskContacts(s1);
  assert.equal(r1.text, `Buy it directly from us for EUR 9,500 - call me on ${CONTACT_REMOVED} or mail ${CONTACT_REMOVED} and skip the platform fee`);
  assert.deepEqual(r1.removed.sort(), ['email', 'phone']);

  const s2 = 'EUR 6,000 direct, bank transfer to BioLab Refurb, IBAN DE89 3704 0044 0532 0130 00, call me +49 30 12345678';
  const r2 = maskContacts(s2);
  assert.equal(r2.text, `EUR 6,000 direct, bank transfer to BioLab Refurb, IBAN ${CONTACT_REMOVED}, call me ${CONTACT_REMOVED}`);
  assert.deepEqual(r2.removed.sort(), ['iban', 'phone']);
});

test('IBANs with and without spaces; a checksum-invalid one only after the word IBAN', () => {
  assert.ok(ibanChecksumOk('NL91ABNA0417164300'));
  assert.ok(ibanChecksumOk('GB29NWBK60161331926819'));
  assert.ok(!ibanChecksumOk('NL91ABNA0417164301'));
  assert.equal(maskContacts('pay to NL91 ABNA 0417 1643 00 please').text, `pay to ${CONTACT_REMOVED} please`);
  assert.equal(maskContacts('pay to nl91abna0417164300.').text, `pay to ${CONTACT_REMOVED}.`);
  assert.equal(maskContacts('GB29-NWBK-6016-1331-9268-19').text, CONTACT_REMOVED);
  assert.equal(maskContacts('IBAN: NL12 ABCD 0123 4567 89').text, `IBAN: ${CONTACT_REMOVED}`);
});

test('phone numbers in the usual European and international forms', () => {
  for (const p of ['+31 6 1234 5678', '+31612345678', '0031 6 12345678', '06-12345678', '(030) 1234567', '030 123 4567', '31612345678', '+49 30 123456']) {
    assert.equal(maskContacts(`ring ${p} today`).text, `ring ${CONTACT_REMOVED} today`, p);
  }
  // A “serial” label does not let a phone number through.
  assert.equal(maskContacts('serial 0612345678').text, `serial ${CONTACT_REMOVED}`);
  assert.equal(maskContacts('serial +31612345678').text, `serial ${CONTACT_REMOVED}`);
});

test('links, obfuscated e-mail addresses and messenger handles; our own links stay', () => {
  assert.equal(maskContacts('see https://biolab-direct.nl/shop?id=4.').text, `see ${CONTACT_REMOVED}.`);
  assert.equal(maskContacts('see www.biolab.de or biolab-direct.nl/offers').text, `see ${CONTACT_REMOVED} or ${CONTACT_REMOVED}`);
  assert.equal(maskContacts('wa.me/31612345678').text, CONTACT_REMOVED);
  assert.equal(maskContacts('jan (at) biolab (dot) nl').text, CONTACT_REMOVED);
  assert.equal(maskContacts('jan at biolab dot nl').text, CONTACT_REMOVED);
  assert.equal(maskContacts('find me @biolab_direct on Telegram').text, `find me ${CONTACT_REMOVED} on Telegram`);
  const own = 'Like https://labtodate.com/marketplace/eppendorf-5430r and www.labtodate.com';
  assert.equal(maskContacts(own, { allowHosts: ['labtodate.com'] }).text, own);
  assert.match(maskContacts(own).text, /\[contact details removed\]/);
});

test('ordinary lab-equipment text is left alone', () => {
  for (const t of [
    'Eppendorf 5430R refrigerated microcentrifuge, 2019, 24 x 1.5/2.0 mL, rotor F-45-30-11',
    'Thermo Sorvall ST16R and Mettler-Toledo XPR205 analytic balance',
    'Agilent 1100 series G1311A quaternary pump, 1260 Infinity II G7111B',
    'Offer €4,370 excl. VAT, delivery on 18.10.2026 between 10:00-12:00, order L2D-2026-LGCZP3',
    'Models 2019 2020 2021 in stock, 5 units, 0,5 % discount, version v2.0, e.g. a report.pdf',
    'Serial SN-4521-77 and invoice INV-2026-00004, proforma PF-2026-00067',
    'Zeiss LSM 980 Airyscan 2, 2021, serial 2802001234, part no. 5430000018, S/N: 7712345678',
  ]) {
    const r = maskContacts(t);
    assert.equal(r.text, t, t);
    assert.deepEqual(r.removed, []);
  }
});

test('flags: prices and “deal around us” wording are flagged for staff, not removed', () => {
  assert.deepEqual(messageFlags('Buy it directly from us for EUR 9,500 and skip the platform fee'), ['price', 'off-platform']);
  assert.deepEqual(messageFlags('€ 5.000 is our best'), ['price']);
  assert.deepEqual(messageFlags('message me on WhatsApp'), ['off-platform']);
  assert.deepEqual(messageFlags('Is the rotor included? Does it ship directly?'), []);
  assert.equal(screeningSummary({ removed: ['phone', 'email'], flags: ['price'] }), 'removed: phone number, e-mail address · mentions a price');
});

test('mediateMessage follows the mode; staff text is never changed', () => {
  const body = 'call +31 6 1234 5678';
  assert.deepEqual(mediateMessage({ mode: 'MASK_CONTACTS', author: 'STAFF', body }), { body, held: false, removed: [], flags: [] });
  assert.deepEqual(mediateMessage({ mode: 'OFF', author: 'SUPPLIER', body }), { body, held: false, removed: [], flags: [] });
  const masked = mediateMessage({ mode: 'MASK_CONTACTS', author: 'SUPPLIER', body });
  assert.equal(masked.body, `call ${CONTACT_REMOVED}`);
  assert.equal(masked.held, false);
  const review = mediateMessage({ mode: 'STAFF_REVIEW', author: 'SUPPLIER', body: 'Yes, it is available.' });
  assert.equal(review.held, true);
  assert.equal(review.body, 'Yes, it is available.');
  const buyer = mediateMessage({ mode: 'STAFF_REVIEW', author: 'BUYER', body });
  assert.equal(buyer.held, false);
  assert.equal(buyer.body, `call ${CONTACT_REMOVED}`);
  assert.equal(mediationMode('SOMETIMES'), 'MASK_CONTACTS');
  assert.equal(mediationMode('OFF'), 'OFF');
});

test('delivery state lives in an invisible prefix users cannot type', () => {
  assert.equal(deliveryState(storedBody('HELD', 'x')), 'HELD');
  assert.equal(deliveryState(storedBody('WITHHELD', 'x')), 'WITHHELD');
  assert.equal(deliveryState('x'), 'DELIVERED');
  assert.equal(messageText(storedBody('HELD', 'hello')), 'hello');
  assert.equal(sanitizeMessageInput(`${HELD_PREFIX}fake\r\n `), 'heldfake');
  assert.equal(deliveryState(sanitizeMessageInput(`${WITHHELD_PREFIX}x`)), 'DELIVERED');
});

test('participants see only delivered messages of the other side; staff show as the site team', () => {
  const at = new Date('2026-10-18T10:00:00Z');
  const rows = [
    { id: '1', body: 'Is it available?', createdAt: at, authorId: 'buyer', authorRole: 'BUYER' },
    { id: '2', body: storedBody('HELD', 'Yes - call me'), createdAt: at, authorId: 'sup', authorRole: 'SELLER' },
    { id: '3', body: 'We can deliver next week.', createdAt: at, authorId: 'staff', authorRole: 'ADMIN' },
    { id: '4', body: storedBody('WITHHELD', 'mail me'), createdAt: at, authorId: 'sup', authorRole: 'SELLER' },
  ];
  const buyerView = participantMessages(rows, { viewerId: 'buyer', viewerIsBuyer: true, site: 'Labtodate' });
  assert.deepEqual(buyerView.map((m) => [m.id, m.authorName]), [['1', 'You'], ['3', 'Labtodate team']]);
  const supplierView = participantMessages(rows, { viewerId: 'sup', viewerIsBuyer: false, site: 'Labtodate' });
  assert.deepEqual(supplierView.map((m) => [m.id, m.authorName, m.body]), [
    ['1', 'Labtodate Buyer', 'Is it available?'], ['2', 'You', 'Yes - call me'], ['3', 'Labtodate team', 'We can deliver next week.'], ['4', 'You', 'mail me'],
  ]);
  assert.match(supplierView[1].note ?? '', /Waiting for review by the Labtodate team/);
  assert.match(supplierView[3].note ?? '', /Not delivered/);
  for (const mode of ['MASK_CONTACTS', 'STAFF_REVIEW', 'OFF'] as const) {
    const n = mediationNotice(mode, 'Labtodate');
    assert.match(n, /Labtodate team/);
    assert.doesNotMatch(n, /lab2date/);
    assert.equal(/removed/.test(n), mode !== 'OFF', mode);
  }
});
