import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteSiteUrl, addressLinesOf, legalIdentity, siteName, websiteUrlOf } from './identity';

const KEYS = ['SITE_NAME', 'COMPANY_LEGAL_NAME', 'COMPANY_ADDRESS', 'COMPANY_COUNTRY', 'COMPANY_CITY', 'COMPANY_KVK', 'COMPANY_VAT', 'COMPANY_EORI',
  'COMPANY_PHONE', 'COMPANY_EMAIL', 'SUPPORT_EMAIL', 'COMPANY_WEBSITE', 'COMPANY_LOGO_URL', 'BETTER_AUTH_URL'];

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});

test('siteName: the configured brand, “Labtodate” only when none is set', () => {
  assert.equal(siteName(), 'Labtodate');
  process.env.SITE_NAME = '  Lab Two Date  ';
  assert.equal(siteName(), 'Lab Two Date');
});

test('legalIdentity reads the Company settings and invents nothing', () => {
  process.env.SITE_NAME = 'Labtodate';
  process.env.BETTER_AUTH_URL = 'https://labtodate.com/';
  let id = legalIdentity();
  assert.equal(id.legalName, '');
  assert.equal(id.displayName, 'Labtodate');
  assert.deepEqual(id.addressLines, []);
  assert.equal(id.kvk, '');
  assert.equal(id.logoAbsoluteUrl, '');
  assert.equal(id.websiteUrl, 'https://labtodate.com');

  Object.assign(process.env, {
    COMPANY_LEGAL_NAME: 'Labtodate B.V.', COMPANY_ADDRESS: 'Industrieweg 12\r\n2712 LB Zoetermeer', COMPANY_COUNTRY: 'Netherlands', COMPANY_CITY: 'Zoetermeer',
    COMPANY_KVK: '87654321', COMPANY_VAT: 'NL859123456B01', COMPANY_EORI: 'NL859123456', COMPANY_PHONE: '+31 79 123 4567',
    COMPANY_EMAIL: 'billing@labtodate.com', SUPPORT_EMAIL: 'support@labtodate.com', COMPANY_WEBSITE: 'labtodate.com',
    COMPANY_LOGO_URL: '/media/lab2date-media/branding/logo.png',
  });
  id = legalIdentity();
  assert.equal(id.legalName, 'Labtodate B.V.');
  assert.equal(id.displayName, 'Labtodate B.V.');
  assert.deepEqual(id.addressLines, ['Industrieweg 12', '2712 LB Zoetermeer', 'Netherlands']);
  assert.equal(id.kvk, '87654321');
  assert.equal(id.vat, 'NL859123456B01');
  assert.equal(id.eori, 'NL859123456');
  assert.equal(id.supportEmail, 'support@labtodate.com');
  assert.equal(id.websiteUrl, 'https://labtodate.com');
  assert.equal(id.logoAbsoluteUrl, 'https://labtodate.com/media/lab2date-media/branding/logo.png');
});

test('legalIdentity never hands out a placeholder e-mail address', () => {
  // .env.example ships these; a mail footer or the Organization data must not print them.
  Object.assign(process.env, { COMPANY_EMAIL: 'billing@lab2date.local', SUPPORT_EMAIL: 'support@lab2date.local' });
  let id = legalIdentity();
  assert.equal(id.email, '');
  assert.equal(id.supportEmail, '');
  Object.assign(process.env, { COMPANY_EMAIL: ' billing@labtodate.com ', SUPPORT_EMAIL: 'sales@shop.example' });
  id = legalIdentity();
  assert.equal(id.email, 'billing@labtodate.com');
  assert.equal(id.supportEmail, '');
});

test('URL helpers', () => {
  assert.equal(absoluteSiteUrl('/media/x.png', 'https://a.example'), 'https://a.example/media/x.png');
  assert.equal(absoluteSiteUrl('https://cdn.example/x.png', ''), 'https://cdn.example/x.png');
  assert.equal(absoluteSiteUrl('//evil.example/x.png', 'https://a.example'), '');
  assert.equal(absoluteSiteUrl('/media/x.png', ''), '');
  assert.equal(websiteUrlOf('https://www.labtodate.com/', 'https://x'), 'https://www.labtodate.com');
  assert.equal(websiteUrlOf('www.labtodate.com', ''), 'https://www.labtodate.com');
  assert.equal(websiteUrlOf('our site', 'https://labtodate.com'), 'https://labtodate.com');
  assert.deepEqual(addressLinesOf('Street 1\n1234 AB City\nNetherlands', 'netherlands'), ['Street 1', '1234 AB City', 'Netherlands']);
  assert.deepEqual(addressLinesOf('', 'Netherlands'), ['Netherlands']);
});
