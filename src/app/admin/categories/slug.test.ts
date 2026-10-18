import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorySlug, cleanSlugInput } from './slug';

test('Latin names keep their letters; accents are dropped', () => {
  assert.equal(categorySlug('HPLC / LC'), 'hplc-lc');
  assert.equal(categorySlug('Gas Chromatography (GC)'), 'gas-chromatography-gc');
  assert.equal(categorySlug('Réfrigérateurs & Congélateurs'), 'refrigerateurs-congelateurs');
  assert.equal(categorySlug('Messgeräte für Straße'), 'messgerate-fur-strasse');
});

test('a Persian name gets a usable Latin slug instead of “category”', () => {
  const s = categorySlug('دستگاه کروماتوگرافی');
  assert.match(s, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(s, 'dstgah-krvmatvgrafi');
  assert.equal(categorySlug('سانتریفیوژ ۲۰۰۰'), 'santrifivzh-2000');
  assert.equal(categorySlug(`می${String.fromCharCode(0x200c)}خواهم`), 'mikhvahm', 'the zero-width non-joiner does not split the word');
});

test('Cyrillic and Greek are transliterated; a name with nothing to transliterate asks for a slug', () => {
  assert.equal(categorySlug('Центрифуги'), 'tsentrifugi');
  assert.equal(categorySlug('Φασματόμετρα'), 'fasmatometra');
  assert.equal(categorySlug('离心机'), '');
  assert.equal(categorySlug('!!!'), '');
  assert.ok(categorySlug('x'.repeat(200)).length <= 70);
});

test('a typed slug is cleaned to the same alphabet', () => {
  assert.equal(cleanSlugInput(' Gas Chromatography '), 'gas-chromatography');
  assert.equal(cleanSlugInput('--a__b--'), 'a-b');
  assert.equal(cleanSlugInput('دستگاه'), null);
});
