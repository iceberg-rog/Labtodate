import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTACT_REMOVED, HELD_SUPPLIER_MESSAGE_PREFIX, contactKindsLabel, destinationFromPlace, isHeldSupplierMessage, maskContactDetails,
  mediateSupplierMessage, mediateSupplierOffer, placeCountries, sentence, statusClaimFilter, type CountryRef,
} from './offer';

// The country list as seeded (CountryPolicy): no Morocco, no "ON".
const COUNTRIES: CountryRef[] = [
  ['DE', 'Germany'], ['BE', 'Belgium'], ['CH', 'Switzerland'], ['FR', 'France'], ['GB', 'United Kingdom'], ['IT', 'Italy'], ['NL', 'Netherlands'],
  ['US', 'United States'], ['CA', 'Canada'], ['AU', 'Australia'], ['RU', 'Russia'],
].map(([code, name]) => ({ code, name }));

test('supplier contact details are removed; prices, dates, serials and VAT IDs stay', () => {
  const m = maskContactDetails('Buy directly for EUR 9,500: call me on +49 151 2345 6789 or 030 1234567, mail sales@biolab-refurb.de, see www.biolab-refurb.de/deal or biolab.com, IBAN DE89 3704 0044 0532 0130 00.');
  assert.equal(m.masked, true);
  assert.deepEqual(new Set(m.kinds), new Set(['email', 'link', 'iban', 'phone']));
  for (const leak of ['+49', '030 1234567', 'sales@', 'biolab-refurb.de', 'biolab.com', 'DE89']) assert.ok(!m.text.includes(leak), `${leak} removed: ${m.text}`);
  assert.ok(m.text.includes('EUR 9,500'), 'the price stays');
  assert.ok(m.text.includes(CONTACT_REMOVED));

  const kept = maskContactDetails('Zeiss LSM 980, 2021, SN 2802001234 (SN2802001234), ready 05.10.2026 14:30, order L2D-2026-5T33CU, VAT ID NL859876543B01, € 11.374,00.');
  assert.equal(kept.masked, false, kept.text);
  assert.equal(kept.text, 'Zeiss LSM 980, 2021, SN 2802001234 (SN2802001234), ready 05.10.2026 14:30, order L2D-2026-5T33CU, VAT ID NL859876543B01, € 11.374,00.');

  assert.equal(maskContactDetails('write to anna [at] lab [dot] de').masked, true, 'spelled-out e-mail address');
  assert.equal(maskContactDetails('Tel. 0049 (0)89 123 456 78').masked, true, 'international number with 00');
});

test('mediation modes: mask, hold for review, or deliver as written', () => {
  const body = 'Call +31 6 1234 5678 for a better price.';
  const masked = mediateSupplierMessage('MASK_CONTACTS', body);
  assert.equal(masked.held, false);
  assert.deepEqual(masked.removed, ['phone']);
  assert.equal(masked.body, `Call ${CONTACT_REMOVED} for a better price.`);

  const held = mediateSupplierMessage('STAFF_REVIEW', body);
  assert.equal(held.held, true);
  assert.equal(held.body, `${HELD_SUPPLIER_MESSAGE_PREFIX}${body}`);
  assert.ok(isHeldSupplierMessage({ body: held.body, isInternalNote: true }));
  assert.ok(!isHeldSupplierMessage({ body: held.body, isInternalNote: false }), 'a released message is no longer held');
  assert.ok(!isHeldSupplierMessage({ body, isInternalNote: true }), 'an ordinary internal note is not a held message');

  assert.deepEqual(mediateSupplierMessage('OFF', body), { body, held: false, removed: [] });
  assert.equal(contactKindsLabel(['email', 'phone']), 'e-mail addresses and phone numbers');
  assert.equal(contactKindsLabel(['link']), 'links');
});

test('the destination of an offer comes from the place of a C/D-term, only when it names one country of the list', () => {
  const dest = (inc: string | null, place: string, list = COUNTRIES) => destinationFromPlace(inc, place, list);
  assert.equal(dest('DDP', 'Basel (CH)'), 'CH');
  assert.equal(dest('CIP', 'Leuven, Belgium'), 'BE');
  assert.equal(dest('dap', 'Paris, FR'), 'FR');
  assert.equal(dest('DPU', 'London, UK'), 'GB');
  assert.equal(dest('DAP', 'Boston, MA, USA'), 'US');
  // A state / province after the city is not a country.
  assert.equal(dest('DAP', 'Boston, MA'), 'US', 'MA is Massachusetts (Morocco is not on the list)');
  assert.equal(dest('DAP', 'Boston, MA', [...COUNTRIES, { code: 'MA', name: 'Morocco' }]), null, 'with Morocco on the list MA may mean either');
  assert.equal(dest('DAP', 'Toronto, ON'), 'CA', 'ON is Ontario, not a country');
  assert.equal(dest('DAP', 'San Diego, CA'), null, 'CA is California or Canada');
  assert.equal(dest('DAP', 'Newark, DE'), null, 'DE is Delaware or Germany');
  assert.equal(dest('DAP', 'Berlin, DE'), null, 'the same suffix — staff choose the destination');
  assert.equal(dest('DAP', 'Lab 3, Building IT'), null, 'a word in the address is no country');
  assert.equal(dest('dap', 'Berlin DE'), null, 'no separator, no country');
  assert.equal(dest('DAP', 'Casablanca, MA'), 'US', 'documented limit: read as a US state while Morocco is not on the list');
  assert.equal(dest('DAP', 'Berlin'), null, 'a city alone names no country');
  assert.equal(dest('DAP', 'Somewhere, XX'), null, 'an unknown code');
  assert.equal(dest('EXW', 'Zoetermeer, NL'), null, 'EXW names the origin');
  assert.equal(dest('FCA', 'Schiphol, NL'), null, 'FCA names the origin');
  assert.equal(dest(null, 'Berlin, DE'), null);
  assert.equal(dest('DAP', 'Berlin, DE', []), null, 'nothing is read without the country list');

  // Every country a place may name (the check of offers sent before they named a destination).
  assert.deepEqual(placeCountries('DAP', 'Berlin, DE', COUNTRIES), ['DE', 'US']);
  assert.deepEqual(placeCountries('DAP', 'San Diego, CA', COUNTRIES), ['CA', 'US']);
  assert.deepEqual(placeCountries('DAP', 'Toronto, ON', COUNTRIES), ['CA']);
  assert.deepEqual(placeCountries('DAP', 'Perth, WA', COUNTRIES), ['US', 'AU']);
  assert.deepEqual(placeCountries('DAP', 'Atlanta, Georgia', COUNTRIES), ['US']);
  assert.equal(placeCountries('DAP', 'Lab 3, Building IT', COUNTRIES), null);
  assert.equal(placeCountries('EXW', 'Berlin, DE', COUNTRIES), null);
});

test('a supplier offer: held for staff, published with contact details removed, or as written', () => {
  const fields = {
    note: 'Buy directly for EUR 9,500: call +49 151 2345 6789 or mail sales@biolab-refurb.de',
    leadTime: '2 weeks', warranty: '6 months, ask anna [at] biolab [dot] de', incotermPlace: 'Berlin, DE',
    itemTitle: 'Zeiss LSM 980 — see www.biolab-refurb.de', itemDescription: undefined, itemSerial: '2802001234',
  };
  const held = mediateSupplierOffer('STAFF_REVIEW', fields);
  assert.equal(held.route, 'PROPOSAL');
  assert.deepEqual(held.fields, fields);

  const masked = mediateSupplierOffer('MASK_CONTACTS', fields);
  assert.equal(masked.route, 'PUBLISH');
  assert.deepEqual(new Set(masked.removed), new Set(['phone', 'email', 'link']));
  assert.deepEqual(new Set(masked.maskedFields), new Set(['note', 'warranty', 'itemTitle']));
  assert.equal(masked.fields.note, `Buy directly for EUR 9,500: call ${CONTACT_REMOVED} or mail ${CONTACT_REMOVED}`);
  assert.equal(masked.fields.warranty, `6 months, ask ${CONTACT_REMOVED}`);
  assert.equal(masked.fields.itemTitle, `Zeiss LSM 980 — see ${CONTACT_REMOVED}`);
  assert.equal(masked.fields.leadTime, '2 weeks');
  assert.equal(masked.fields.incotermPlace, 'Berlin, DE');
  assert.equal(masked.fields.itemSerial, '2802001234', 'a serial number is no phone number');
  assert.equal(masked.fields.itemDescription, undefined, 'a field not sent stays unset (an update keeps it)');
  assert.equal(fields.note.includes('+49'), true, 'the original is not changed');

  const off = mediateSupplierOffer('OFF', fields);
  assert.equal(off.route, 'PUBLISH');
  assert.deepEqual(off.fields, fields);
  assert.deepEqual(off.removed, []);
});

test('sentence(): one full stop, never two', () => {
  assert.equal(sentence('Budget withdrawn'), 'Budget withdrawn.');
  assert.equal(sentence('Ordered by mistake.'), 'Ordered by mistake.');
  assert.equal(sentence('  Why?  '), 'Why?');
  assert.equal(sentence(''), '');
  assert.equal(sentence(null), '');
});

test('decline / close claims: a concurrent acceptance or a newer offer wins', () => {
  // The buyer declines only the revision they looked at, while it is open.
  assert.deepEqual(statusClaimFilter('DECLINED', 'RESPONDED', 1), { status: 'RESPONDED', offerRevision: 1 });
  // Staff close anything but an accepted or closed quote: an acceptance that
  // committed first is not matched, so its order is never canceled or mailed "closed".
  const close = statusClaimFilter('CLOSED', 'RESPONDED', 3);
  assert.deepEqual(close, { status: { notIn: ['CLOSED', 'ACCEPTED'] } });
  assert.equal('offerRevision' in close, false);
  // An accepted quote whose order was canceled closes from ACCEPTED only.
  assert.deepEqual(statusClaimFilter('CLOSED', 'ACCEPTED', 2), { status: 'ACCEPTED' });
});
