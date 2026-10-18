// Server modules import lib/auth-server (React `cache`): the project's test shim provides it outside Next.
import '../../../scripts/react-cache-shim.cjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUOTE_COUNTRY_LOCKED, destinationChangeRule, offerDestinationCountry } from './details-server';

test('an accepted offer: the buyer can not move the delivery to another country', () => {
  const r = destinationChangeRule({ isQuote: true, prevShip: 'NL', offerDestination: null, nextShip: 'US', actor: 'BUYER' });
  assert.ok(r.refused);
  assert.equal(r.refused.error, `${QUOTE_COUNTRY_LOCKED} Nothing was saved.`);
  assert.equal(r.refused.fieldErrors.d_country, 'stays NL for this offer');
  // A first delivery address for another country than the offer was priced for: refused too.
  const first = destinationChangeRule({ isQuote: true, prevShip: null, offerDestination: 'DE', nextShip: 'AU', actor: 'BUYER' });
  assert.ok(first.refused);
  // Same country: allowed, no review.
  const same = destinationChangeRule({ isQuote: true, prevShip: 'NL', offerDestination: 'NL', nextShip: 'NL', actor: 'BUYER' });
  assert.equal(same.refused, null);
  assert.equal(!same.refused && same.quoteReview, false);
});

test('an accepted offer moved by staff goes on address review (re-quote), a checkout order keeps its own rule', () => {
  const staff = destinationChangeRule({ isQuote: true, prevShip: 'NL', offerDestination: 'NL', nextShip: 'US', actor: 'STAFF' });
  assert.equal(staff.refused, null);
  assert.ok(!staff.refused && staff.quoteReview && staff.pricedFor === 'NL');
  const checkoutBuyer = destinationChangeRule({ isQuote: false, prevShip: 'NL', offerDestination: 'DE', nextShip: 'BE', actor: 'BUYER' });
  assert.ok(checkoutBuyer.refused);
  assert.match(checkoutBuyer.refused.error, /can not|cannot be changed while paying/);
  const checkoutStaff = destinationChangeRule({ isQuote: false, prevShip: 'NL', offerDestination: null, nextShip: 'BE', actor: 'STAFF' });
  assert.ok(!checkoutStaff.refused && !checkoutStaff.quoteReview && checkoutStaff.countryChanged);
});

test('the offer destination country is read only when it is a country code', () => {
  assert.equal(offerDestinationCountry({ destinationCountry: ' de ' }), 'DE');
  assert.equal(offerDestinationCountry({ destinationCountry: 'Germany' }), null);
  assert.equal(offerDestinationCountry(null), null);
});
