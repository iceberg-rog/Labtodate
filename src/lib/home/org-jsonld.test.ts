import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LegalIdentity } from '@/lib/brand/identity';
import { organizationJsonLd, splitAddress } from './org-jsonld';

const identity: LegalIdentity = {
  siteName: 'Labtodate', legalName: 'Labtodate B.V.', displayName: 'Labtodate B.V.', addressLines: ['Industrieweg 12', '2712 LB Zoetermeer', 'Netherlands'],
  city: 'Zoetermeer', country: 'Netherlands', kvk: '12345678', vat: 'NL 8591.23456.B01', eori: '', phone: '+31 79 123 4567',
  email: 'billing@labtodate.com', supportEmail: 'support@labtodate.com', website: 'labtodate.com', websiteUrl: 'https://labtodate.com',
  logoUrl: '/media/lab2date-media/branding/logo.png', logoAbsoluteUrl: 'https://labtodate.com/media/lab2date-media/branding/logo.png',
};

test('the registered address is split into street, postcode and city (the country line is not the street)', () => {
  assert.deepEqual(splitAddress('Industrieweg 12\n2712 LB Zoetermeer', 'Zoetermeer', 'Netherlands'), { streetAddress: 'Industrieweg 12', postalCode: '2712 LB', addressLocality: 'Zoetermeer' });
  assert.deepEqual(splitAddress('Industrieweg 12\n2712lb Zoetermeer\nNetherlands', '', 'Netherlands'), { streetAddress: 'Industrieweg 12', postalCode: '2712 LB', addressLocality: 'Zoetermeer' });
  assert.deepEqual(splitAddress('Hauptstraße 5\n10115 Berlin', '', 'Germany'), { streetAddress: 'Hauptstraße 5', postalCode: '10115', addressLocality: 'Berlin' });
  assert.deepEqual(splitAddress('Unit 4, Science Park', 'Cambridge', ''), { streetAddress: 'Unit 4, Science Park', addressLocality: 'Cambridge' });
  assert.deepEqual(splitAddress('', '', ''), {});
});

test('Organization: legal name, VAT ID, structured address with ISO country, logo and own profiles', () => {
  const ld = organizationJsonLd({
    identity, address: 'Industrieweg 12\n2712 LB Zoetermeer', homeCountry: 'nl',
    sameAs: ['https://www.linkedin.com/company/labtodate', 'http://insecure.example', ''], url: 'https://labtodate.com', description: 'Used lab equipment.',
  });
  assert.equal(ld.name, 'Labtodate');
  assert.equal(ld.legalName, 'Labtodate B.V.');
  assert.equal(ld.vatID, 'NL859123456B01');
  assert.deepEqual(ld.address, { '@type': 'PostalAddress', streetAddress: 'Industrieweg 12', postalCode: '2712 LB', addressLocality: 'Zoetermeer', addressCountry: 'NL' });
  assert.equal(ld.logo, identity.logoAbsoluteUrl);
  assert.equal(ld.email, 'support@labtodate.com');
  assert.deepEqual(ld.sameAs, ['https://www.linkedin.com/company/labtodate']);
  const bare = organizationJsonLd({ identity: { ...identity, legalName: '', vat: '', logoAbsoluteUrl: '', supportEmail: '', phone: '' }, address: '', homeCountry: '', sameAs: [], url: 'https://x.test', description: 'd' });
  for (const k of ['legalName', 'vatID', 'logo', 'email', 'telephone', 'sameAs']) assert.ok(!(k in bare), `${k} is left out when not set`);
  assert.deepEqual(bare.address, { '@type': 'PostalAddress', addressLocality: 'Zoetermeer' });
});
