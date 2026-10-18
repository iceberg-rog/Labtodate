import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandColorProblem, contrastWithWhite, DEFAULT_BRAND_COLOR, emailBrandColor } from './color';

test('the default brand colour carries white button text', () => {
  assert.equal(brandColorProblem(DEFAULT_BRAND_COLOR), null);
  assert.ok(contrastWithWhite(DEFAULT_BRAND_COLOR) > 9);
  assert.equal(Math.round(contrastWithWhite('#000000')), 21);
  assert.equal(contrastWithWhite('#ffffff'), 1);
});

test('only #RRGGBB colours dark enough for white text are accepted', () => {
  assert.equal(brandColorProblem('#1D4ED8'), null);
  assert.equal(brandColorProblem(' #0e4f40 '), null);
  assert.match(brandColorProblem('green') ?? '', /six hex digits/);
  assert.match(brandColorProblem('#0E4F4') ?? '', /six hex digits/);
  assert.match(brandColorProblem('rgb(0,0,0)') ?? '', /six hex digits/);
  // The site's lime accent: white on it is unreadable.
  assert.match(brandColorProblem('#A4E335') ?? '', /too light.*darker/);
});

test('e-mails fall back to the default for an unusable value', () => {
  assert.equal(emailBrandColor(''), DEFAULT_BRAND_COLOR);
  assert.equal(emailBrandColor(undefined), DEFAULT_BRAND_COLOR);
  assert.equal(emailBrandColor('#ffff00'), DEFAULT_BRAND_COLOR);
  assert.equal(emailBrandColor('red;background:url(x)'), DEFAULT_BRAND_COLOR);
  assert.equal(emailBrandColor('#1d4ed8'), '#1D4ED8');
});
