import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSitemap, type SitemapData } from './sitemap';

const d = (s: string) => new Date(s);

function data(over: Partial<SitemapData> = {}): SitemapData {
  return {
    base: 'https://labtodate.com/',
    products: [
      { slug: 'pump', categoryId: 'c1', updatedAt: d('2026-10-01T10:00:00Z') },
      { slug: 'gc', categoryId: 'c2', updatedAt: d('2026-10-05T10:00:00Z') },
    ],
    categories: [
      { id: 'c1', slug: 'hplc-lc', updatedAt: d('2026-01-01T00:00:00Z') },
      { id: 'c2', slug: 'gc', updatedAt: d('2026-10-09T00:00:00Z') },
    ],
    posts: [{ slug: 'buying-guide', updatedAt: d('2026-09-01T00:00:00Z') }],
    articles: [],
    cases: [],
    facilities: [],
    textSavedAt: { LEGAL_TERMS_TEXT: d('2026-06-01T00:00:00Z') },
    ...over,
  };
}

const byUrl = (map: ReturnType<typeof buildSitemap>) => new Map(map.map((e) => [e.url, e]));

test('the same data gives the same sitemap: no lastmod is the time of the request', () => {
  const a = buildSitemap(data());
  const b = buildSitemap(data());
  assert.deepEqual(a, b);
  const now = Date.now();
  for (const e of a) {
    if (e.lastModified) assert.ok(new Date(e.lastModified).getTime() < now - 60_000, e.url);
  }
});

test('lastmod = when the content changed; none when unknown', () => {
  const m = byUrl(buildSitemap(data()));
  assert.deepEqual(m.get('https://labtodate.com/marketplace')?.lastModified, d('2026-10-05T10:00:00Z'));
  assert.deepEqual(m.get('https://labtodate.com/marketplace/pump')?.lastModified, d('2026-10-01T10:00:00Z'));
  // A category: its own edit or its newest live listing, whichever is later.
  assert.deepEqual(m.get('https://labtodate.com/marketplace?category=hplc-lc')?.lastModified, d('2026-10-01T10:00:00Z'));
  assert.deepEqual(m.get('https://labtodate.com/marketplace?category=gc')?.lastModified, d('2026-10-09T00:00:00Z'));
  assert.deepEqual(m.get('https://labtodate.com/legal/terms')?.lastModified, d('2026-06-01T00:00:00Z'));
  assert.equal('lastModified' in (m.get('https://labtodate.com/legal/privacy') ?? {}), false);
  assert.equal('lastModified' in (m.get('https://labtodate.com/contact') ?? {}), false);
  assert.deepEqual(m.get('https://labtodate.com')?.lastModified, d('2026-10-05T10:00:00Z'));
});

test('the real static pages are listed; empty sections are not', () => {
  const urls = buildSitemap(data()).map((e) => e.url);
  for (const path of ['/about', '/faq', '/contact', '/support', '/legal/terms', '/legal/privacy', '/legal/cookies', '/sell', '/let-us-find-it', '/blog']) {
    assert.ok(urls.includes(`https://labtodate.com${path}`), path);
  }
  for (const path of ['/wiki', '/lab-rental', '/case-studies']) assert.ok(!urls.includes(`https://labtodate.com${path}`), path);
  assert.equal(new Set(urls).size, urls.length, 'no duplicates');
  assert.ok(!urls.some((u) => u.includes('//marketplace')), 'base without trailing slash');
});
