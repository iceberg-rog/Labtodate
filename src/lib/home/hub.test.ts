import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubFromCompany } from './hub';

test('the globe hub sits at the company city, labelled with the site name', () => {
  assert.deepEqual(hubFromCompany('Labtodate', 'Zoetermeer', 'NL'), { label: 'Labtodate · Zoetermeer', lat: 52.06, lon: 4.49 });
  assert.deepEqual(hubFromCompany('Acme', '  Den   Haag ', 'NL'), { label: 'Acme · Den   Haag', lat: 52.08, lon: 4.3 });
  // an unknown city: the capital of the VAT home country (the label still names the real city)
  assert.deepEqual(hubFromCompany('Acme', 'Kleindorp', 'BE'), { label: 'Acme · Kleindorp', lat: 50.85, lon: 4.35 });
  assert.deepEqual(hubFromCompany('Acme', '', ''), { label: 'Acme', lat: 52.37, lon: 4.9 });
});
