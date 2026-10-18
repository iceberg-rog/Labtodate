import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME_FIELDS, HOME_STATIONS, countText, draftRead, getHomeContent, getHomeLayout, homeField, homeFieldProblem, parseCategoryItems,
  parseDemoSteps, parseRailNames, parseStations, serializeCategoryItems, type HomeRead,
} from './home-sections';

const none: HomeRead = () => '';
const from = (o: Record<string, string>): HomeRead => (k) => o[k] ?? '';
const ctx = { site: 'Acme Lab', sellLogistics: 'SELLER_SHIPS' as const, incoterm: 'EXW' };

test('stations: known names once, the intro first when shown, all seven when nothing usable is set', () => {
  assert.deepEqual(parseStations(''), [...HOME_STATIONS]);
  assert.deepEqual(parseStations('hero,nope,hero,categories'), ['hero', 'categories']);
  assert.deepEqual(parseStations('hero,intro,cta'), ['intro', 'hero', 'cta']);
  assert.deepEqual(getHomeLayout(from({ HOME_STATIONS: 'intro,hero,categories,process,ways,cta' })).stations, ['intro', 'hero', 'categories', 'process', 'ways', 'cta']);
  assert.match(homeFieldProblem('HOME_STATIONS', 'hero,intro') ?? '', /comes first/);
  assert.match(homeFieldProblem('HOME_STATIONS', 'hero,globe') ?? '', /unknown station/);
  assert.equal(homeFieldProblem('HOME_STATIONS', 'intro,hero,cta'), null);
});

test('extras: the registry key wins; the pre-registry list counts only with its version marker until published', () => {
  assert.deepEqual(getHomeLayout(none).extras, []);
  assert.deepEqual(getHomeLayout(from({ HOMEPAGE_SECTIONS: 'testimonials,featured', HOMEPAGE_SECTIONS_V: '3' })).extras, ['testimonials', 'featured']);
  assert.deepEqual(getHomeLayout(from({ HOMEPAGE_SECTIONS: 'hero,featured' })).extras, [], 'a v1/v2 list counts as no extras');
  assert.deepEqual(getHomeLayout(from({ HOME_EXTRAS: 'blog', HOMEPAGE_SECTIONS: 'featured', HOMEPAGE_SECTIONS_V: '3' })).extras, ['blog']);
  // a draft is complete: emptying the extras there really means none (the legacy list is not read)
  const live = from({ HOMEPAGE_SECTIONS: 'testimonials', HOMEPAGE_SECTIONS_V: '3' });
  assert.deepEqual(getHomeLayout(draftRead({ HOME_EXTRAS: '' }, live)).extras, []);
  assert.deepEqual(getHomeLayout(draftRead({ HOME_EXTRAS: 'featured,blog' }, live)).extras, ['featured', 'blog']);
});

test('a draft overrides the live values key by key; keys it lacks read live', () => {
  const read = draftRead({ HERO_TITLE: 'Draft title' }, from({ HERO_TITLE: 'Live title', HERO_BADGE: 'Live badge' }));
  const c = getHomeContent(read, ctx);
  assert.equal(c.heroTitle, 'Draft title');
  assert.equal(c.heroBadge, 'Live badge');
});

test('defaults tell the real flow: written offer, then acceptance and proforma, then payment and VAT invoice; freight quoted separately', () => {
  const c = getHomeContent(none, ctx);
  const all = JSON.stringify(c);
  assert.doesNotMatch(all, /proforma attached|Itemised offer \+ proforma|Packing &amp; shipping|"incl\."|pick-up together|from our hub/i);
  assert.deepEqual(c.demoSteps.map((s) => s.status), ['Requested', 'Offer received', 'Accepted', 'Paid', 'Shipped']);
  assert.match(c.demoSteps[1].text, /written offer/i);
  assert.doesNotMatch(c.demoSteps[1].text + c.demoSteps[1].toast, /proforma/i, 'no proforma before acceptance');
  assert.match(c.demoSteps[2].toast, /proforma issued/i);
  assert.match(c.demoSteps[3].toast, /VAT invoice/i);
  assert.deepEqual(c.demoOffer.find(([l]) => l === 'Freight'), ['Freight', 'quoted separately (EXW)']);
  assert.match(c.ways[3].bullets.join(';'), /You ship it to our warehouse/);
  assert.match(getHomeContent(none, { ...ctx, sellLogistics: 'WE_ARRANGE_PICKUP' }).ways[3].bullets.join(';'), /We arrange the collection/);
  assert.equal(getHomeContent(none, { ...ctx, incoterm: 'FCA' }).demoOffer[1][1], 'quoted separately (FCA)');
});

test('the brand comes from SITE_NAME: no default names it, {SITE} becomes the site name', () => {
  for (const f of HOME_FIELDS) assert.doesNotMatch(f.default, /lab2date|labtodate/i, f.key);
  const c = getHomeContent(none, ctx);
  assert.equal(c.netAccent, 'through Acme Lab.');
  assert.equal(c.hudMeta, 'Acme Lab//MOLECULAR ANALYSIS');
  assert.match(c.introTagline, /^Acme Lab — /);
  assert.equal(c.netHub, null, 'empty hub = derived from the company city by the page');
});

test('buttons are Label|/link with a safe link; the hero buttons, tiles and CTA come from the settings', () => {
  const c = getHomeContent(from({ HOME_HERO_BROWSE: 'Shop now|/marketplace?mode=BUY_NOW', HOME_CTA_PRIMARY: 'Ask us|javascript:alert(1)', HOME_CAT_ALL_TITLE: 'Everything' }), ctx);
  assert.deepEqual(c.heroBrowse, ['Shop now', '/marketplace?mode=BUY_NOW']);
  assert.deepEqual(c.ctaPrimary, ['Ask us', '/let-us-find-it'], 'an unsafe link falls back to the default page');
  assert.deepEqual(c.catAll, ['Everything', '/marketplace'], 'a title saved before links were editable keeps its page');
  assert.match(homeFieldProblem('HOME_CTA_PRIMARY', 'Ask us|javascript:alert(1)') ?? '', /not a link/);
  assert.match(homeFieldProblem('HOME_HERO_BROWSE', '|/marketplace') ?? '', /label/);
  assert.equal(homeFieldProblem('HOME_HERO_BROWSE', 'Browse|https://example.org/x'), null);
});

test('category items: slug|label|image|link, round trip and validation', () => {
  const raw = 'hplc-lc|HPLC systems|product:agilent-1260\ngc||/media/lab2date-media/cat/gc.jpg|product:gc-7890\nms';
  const items = parseCategoryItems(raw);
  assert.deepEqual(items.map((i) => i.slug), ['hplc-lc', 'gc', 'ms']);
  assert.deepEqual(items[0].image, { kind: 'product', slug: 'agilent-1260' });
  assert.deepEqual(items[1].link, { kind: 'product', slug: 'gc-7890' });
  assert.deepEqual(items[2].image, { kind: 'auto' });
  assert.equal(serializeCategoryItems(items), raw);
  assert.equal(homeFieldProblem('HOME_CAT_ITEMS', raw), null);
  assert.match(homeFieldProblem('HOME_CAT_ITEMS', 'gc\ngc') ?? '', /twice/);
  assert.match(homeFieldProblem('HOME_CAT_ITEMS', 'gc||ftp://x/y.jpg') ?? '', /image of “gc”/);
  assert.match(homeFieldProblem('HOME_CAT_ITEMS', 'gc|||https://elsewhere') ?? '', /link of “gc”/);
  assert.match(homeFieldProblem('HOME_CAT_ITEMS', 'HPLC / LC') ?? '', /slug/);
});

test('ways to buy: the first tab opens by default, the start tab is clamped to the ways there are', () => {
  assert.equal(getHomeContent(none, ctx).waysStart, 0);
  const one = getHomeContent(from({ HOME_WAYS_ITEMS: 'Request a quote|Written offer|Ask us.|a;b|Ask|/marketplace', HOME_WAYS_START: '2' }), ctx);
  assert.equal(one.ways.length, 1);
  assert.equal(one.waysStart, 0);
  assert.equal(getHomeContent(from({ HOME_WAYS_START: '3' }), ctx).waysStart, 2);
});

test('other formats: rail names, demo steps, counts, stats, hub', () => {
  assert.equal(parseRailNames('categories|CATALOGUE\nnope|X').categories, 'CATALOGUE');
  assert.equal(parseRailNames('').hero, 'MARKET');
  assert.equal(parseDemoSteps('A|B|C|D').length, 5, 'missing steps keep the default ones');
  assert.match(homeFieldProblem('HOME_DEMO_STEPS', 'A|B\nC|D') ?? '', /five lines/);
  assert.equal(countText('{N} listing|{N} listings', 1), '1 listing');
  assert.equal(countText('{N} listing|{N} listings', 1200), '1,200 listings');
  assert.match(homeFieldProblem('HOME_CAT_COUNT', 'listings') ?? '', /\{N\}/);
  assert.match(homeFieldProblem('HERO_STATS', '12|+|ok\nnonsense') ?? '', /nonsense/);
  assert.equal(homeFieldProblem('HOME_NET_HUB', 'Zoetermeer|52.06|4.49'), null);
  assert.match(homeFieldProblem('HOME_NET_HUB', 'Zoetermeer') ?? '', /latitude/);
  assert.deepEqual(getHomeContent(from({ HOME_NET_HUB: 'Depot|51.9|4.4' }), ctx).netHub, { label: 'Depot', lat: 51.9, lon: 4.4 });
  assert.match(homeFieldProblem('HOME_FEATURED_PRODUCTS', Array.from({ length: 9 }, (_, i) => `p${i}`).join(',')) ?? '', /eight/);
  assert.equal(homeFieldProblem('HOME_DEMO_PRODUCT', '2438'), null);
});

test('every field has a default its own validator accepts and a hint', () => {
  const keys = new Set<string>();
  for (const f of HOME_FIELDS) {
    assert.ok(!keys.has(f.key), `duplicate ${f.key}`);
    keys.add(f.key);
    assert.equal(homeFieldProblem(f.key, f.default), null, f.key);
    assert.ok((f.hint ?? '').length > 10, f.key);
    assert.equal(homeField(f.key), f);
  }
});
