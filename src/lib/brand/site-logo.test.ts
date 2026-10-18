import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteLogoOf } from './site-logo';

test('the dark website shows the dark-background logo as it is', () => {
  assert.deepEqual(siteLogoOf(' /media/logo-light.png ', 'https://cdn.example/logo.png'), { logoUrl: '/media/logo-light.png', logoOnLight: false });
});

test('without one, the document logo sits on a white tile (it is made for white)', () => {
  assert.deepEqual(siteLogoOf('', 'https://cdn.example/logo.png'), { logoUrl: 'https://cdn.example/logo.png', logoOnLight: true });
});

test('no logo at all: the built-in mark', () => {
  assert.deepEqual(siteLogoOf('  ', ''), { logoUrl: '', logoOnLight: false });
});
