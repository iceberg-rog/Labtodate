import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTACT_REMOVED, HELD_SUPPLIER_MESSAGE_PREFIX, contactKindsLabel, destinationFromPlace, isHeldSupplierMessage, maskContactDetails,
  mediateSupplierMessage, sentence, statusClaimFilter,
} from './offer';

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

test('the destination of an offer comes from the place of a C/D-term only', () => {
  const byName = (n: string) => ({ germany: 'DE', belgium: 'BE' } as Record<string, string>)[n.toLowerCase()] ?? null;
  assert.equal(destinationFromPlace('DAP', 'Berlin, DE'), 'DE');
  assert.equal(destinationFromPlace('dap', 'Berlin DE'), 'DE');
  assert.equal(destinationFromPlace('DDP', 'Basel (CH)'), 'CH');
  assert.equal(destinationFromPlace('CIP', 'Leuven, Belgium', byName), 'BE');
  assert.equal(destinationFromPlace('DPU', 'London, UK'), 'GB');
  assert.equal(destinationFromPlace('DAP', 'Berlin'), null, 'a city alone names no country');
  assert.equal(destinationFromPlace('EXW', 'Zoetermeer, NL'), null, 'EXW names the origin');
  assert.equal(destinationFromPlace('FCA', 'Schiphol, NL'), null, 'FCA names the origin');
  assert.equal(destinationFromPlace(null, 'Berlin, DE'), null);
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
