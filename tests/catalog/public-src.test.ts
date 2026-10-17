import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ownMediaPath, publicProductImages, firstPublicImage } from '../../src/lib/media/public-src';
import { isPrivateAddress, importImageKey } from '../../src/lib/media/localize';

// public-src reads the environment at call time: production-like values.
before(() => {
  process.env.S3_PUBLIC_URL = 'https://labtodate.com/media/lab2date-media';
  process.env.S3_BUCKET = 'lab2date-media';
  process.env.BETTER_AUTH_URL = 'https://labtodate.com';
  process.env.MEDIA_LEGACY_PUBLIC_URLS = 'https://87.107.206.76/media/lab2date-media';
});

test('own media in every stored shape becomes the /media path', () => {
  assert.equal(ownMediaPath('/media/lab2date-media/products/import/a.jpg'), '/media/lab2date-media/products/import/a.jpg');
  assert.equal(ownMediaPath('https://labtodate.com/media/lab2date-media/products/x.png'), '/media/lab2date-media/products/x.png');
  assert.equal(ownMediaPath('https://labtodate.com/media/lab2date-media/products/x.png?v=2'), '/media/lab2date-media/products/x.png');
  // stored under an earlier public base (server IP before the domain)
  assert.equal(ownMediaPath('https://87.107.206.76/media/lab2date-media/products/y.jpg'), '/media/lab2date-media/products/y.jpg');
});

test('foreign (supplier) URLs are never treated as ours', () => {
  assert.equal(ownMediaPath('https://lab2parts.com/wp-content/uploads/a.jpg'), null);
  assert.equal(ownMediaPath('https://evil.example/media/lab2date-media/a.jpg'), null);
  assert.equal(ownMediaPath('//labtodate.com/media/x.jpg'), null);
  assert.equal(ownMediaPath('javascript:alert(1)'), null);
  assert.equal(ownMediaPath('/media/../admin'), null);
  assert.equal(ownMediaPath('https://labtodate.com/media/lab2date-media/../../etc/passwd'), null);
});

test('buyer-facing lists drop foreign photos and keep order', () => {
  const list = [
    'https://lab2parts.com/a.jpg',
    '/media/lab2date-media/products/import/b.jpg',
    'https://labtodate.com/media/lab2date-media/products/import/c.jpg',
  ];
  assert.deepEqual(publicProductImages(list), ['/media/lab2date-media/products/import/b.jpg', '/media/lab2date-media/products/import/c.jpg']);
  assert.equal(firstPublicImage(list), '/media/lab2date-media/products/import/b.jpg');
  assert.equal(firstPublicImage(['https://lab2parts.com/a.jpg']), null);
});

test('SSRF guard classifies private addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['185.199.108.153', '8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('image keys are stable per source URL (same scheme as the original localize script)', () => {
  const k = importImageKey('https://lab2parts.com/wp-content/uploads/2026/09/IMG_0851-scaled.jpeg');
  assert.match(k, /^products\/import\/[0-9a-f]{20}\.jpeg$/);
  assert.equal(k, importImageKey('https://lab2parts.com/wp-content/uploads/2026/09/IMG_0851-scaled.jpeg'));
});
