import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProductJsonLd,
  cutAtWord,
  fillMetaFormat,
  isPlaceholderBrand,
  plainText,
  productMetaDescription,
  publicPlainText,
  schemaAvailability,
  type ProductJsonLdInput,
} from '../../src/lib/catalog/jsonld';
import { resolveOfferPrice } from '../../src/lib/catalog/offer-price';
import { SEO_TEXT_DEFAULTS } from '../../src/lib/catalog/settings-defs';

const EXCL = { mode: 'EXCL' as const, standardRateBp: 2100, marginSchemeEnabled: false };

function input(over: Partial<ProductJsonLdInput> = {}, product: Partial<ProductJsonLdInput['product']> = {}): ProductJsonLdInput {
  return {
    baseUrl: 'https://labtodate.com',
    product: {
      slug: 'agilent-g1311b-pump',
      title: 'Agilent G1311B quaternary pump',
      summary: '<p>Tested &amp; working</p>',
      description: null,
      sku: null,
      mpn: null,
      quantity: 1,
      sourceAvailability: null,
      removedAtSourceAt: null,
      vatScheme: 'STANDARD',
      ...product,
    },
    images: ['/media/lab2date-media/products/import/a.jpg', '/media/lab2date-media/products/import/b.jpg'],
    brand: { name: 'Agilent', slug: 'agilent' },
    categoryName: 'HPLC',
    schemaOrgCondition: 'UsedCondition',
    offer: resolveOfferPrice({ priceCents: 100000, currency: 'EUR', mode: 'HYBRID' }, null),
    priceShown: true,
    display: EXCL,
    sellerName: 'Lab2date B.V.',
    returnPolicy: null,
    rating: null,
    ...over,
  };
}

/** The Product node (asserted present). */
function ld(i: ProductJsonLdInput): Record<string, unknown> {
  const out = buildProductJsonLd(i);
  assert.ok(out, 'a Product node');
  return out;
}
const offerOf = (i: ProductJsonLdInput) => ld(i).offers as Record<string, unknown>;

test('availability comes from stock, never a constant', () => {
  assert.equal(schemaAvailability({ quantity: 2 }), 'InStock');
  assert.equal(schemaAvailability({ quantity: 0 }), 'SoldOut');
  assert.equal(schemaAvailability({ quantity: 0, sourceAvailability: 'outofstock' }), 'OutOfStock');
  assert.equal(schemaAvailability({ quantity: 0, removedAtSourceAt: new Date() }), 'Discontinued');
  assert.equal(offerOf(input({}, { quantity: 0 })).availability, 'https://schema.org/SoldOut');
});

test('a reserved unit is Reserved, never SoldOut', () => {
  assert.equal(schemaAvailability({ quantity: 0, reserved: true }), 'Reserved');
  assert.equal(offerOf(input({ reserved: true }, { quantity: 0 })).availability, 'https://schema.org/Reserved');
  // Not available at the supplier stays OutOfStock even when a reservation exists.
  assert.equal(schemaAvailability({ quantity: 0, reserved: true, sourceAvailability: 'outofstock' }), 'OutOfStock');
});

test('price is the buyer-facing price after the shop markup', () => {
  const offer = resolveOfferPrice({ priceCents: 100000, currency: 'EUR', mode: 'HYBRID' }, { pricingMode: 'MARKUP_PERCENT', pricingMarkupBp: 2000 });
  assert.equal(offerOf(input({ offer })).price, '1200.00');
});

test('the Offer states the price the page shows, with its VAT basis (PRICE_DISPLAY_MODE)', () => {
  const offer = resolveOfferPrice({ priceCents: 420000, currency: 'EUR', mode: 'BUY_NOW' }, null);
  // INCL: the page shows €5,082 incl. VAT — so does the structured data.
  const incl = offerOf(input({ offer, display: { ...EXCL, mode: 'INCL' } }));
  assert.equal(incl.price, '5082.00');
  assert.deepEqual(incl.priceSpecification, { '@type': 'UnitPriceSpecification', price: '5082.00', priceCurrency: 'EUR', valueAddedTaxIncluded: true });
  // EXCL and BOTH: the main amount is the net price.
  for (const mode of ['EXCL', 'BOTH'] as const) {
    const o = offerOf(input({ offer, display: { ...EXCL, mode } }));
    assert.equal(o.price, '4200.00', mode);
    assert.equal((o.priceSpecification as Record<string, unknown>).valueAddedTaxIncluded, false, mode);
  }
  // Margin scheme (switched on): the price is final, VAT inside, never grossed up.
  const margin = offerOf(input({ offer, display: { mode: 'INCL', standardRateBp: 2100, marginSchemeEnabled: true } }, { vatScheme: 'MARGIN' }));
  assert.equal(margin.price, '4200.00');
  assert.equal((margin.priceSpecification as Record<string, unknown>).valueAddedTaxIncluded, true);
});

test('no Product node without an offer or a rating (search engines reject it)', () => {
  const forced = resolveOfferPrice({ priceCents: 100000, currency: 'EUR', mode: 'HYBRID' }, { pricingMode: 'FORCE_QUOTE', pricingMarkupBp: 0 });
  assert.equal(buildProductJsonLd(input({ offer: forced })), null);
  const hidden = resolveOfferPrice({ priceCents: 100000, currency: 'EUR', mode: 'HYBRID' }, { pricingMode: 'HIDE_PRICE', pricingMarkupBp: 0 });
  assert.equal(hidden.purchasable, false);
  assert.equal(buildProductJsonLd(input({ offer: hidden })), null);
  const quote = resolveOfferPrice({ priceCents: null, currency: 'EUR', mode: 'QUOTE_ONLY' }, null);
  assert.equal(buildProductJsonLd(input({ offer: quote })), null);
  // A sold unit whose price the page hides (Settings → “Price of a sold unit”).
  assert.equal(buildProductJsonLd(input({ priceShown: false }, { quantity: 0 })), null);
  // With a rating the Product stays, without an Offer.
  const rated = ld(input({ offer: quote, rating: { average: 4.5, count: 2 } }));
  assert.equal(rated.offers, undefined);
  assert.deepEqual(rated.aggregateRating, { '@type': 'AggregateRating', ratingValue: 4.5, reviewCount: 2 });
});

test('a quote-only listing that shows a price has an Offer at that price', () => {
  const offer = resolveOfferPrice({ priceCents: 9900, currency: 'EUR', mode: 'QUOTE_ONLY' }, null);
  assert.equal(offer.mode, 'QUOTE_ONLY');
  assert.equal(offerOf(input({ offer })).price, '99.00');
});

test('sku / mpn only when real; never the slug', () => {
  const none = ld(input());
  assert.equal(none.sku, undefined);
  assert.equal(none.mpn, undefined);
  const real = ld(input({}, { sku: 'L2D-0042', mpn: 'G1311-60001' }));
  assert.equal(real.sku, 'L2D-0042');
  assert.equal(real.mpn, 'G1311-60001');
});

test('placeholder brands are omitted — the admin list included', () => {
  assert.equal(isPlaceholderBrand({ name: 'Other', slug: 'other' }), true);
  assert.equal(isPlaceholderBrand(null), true);
  assert.equal(isPlaceholderBrand({ name: 'Agilent', slug: 'agilent' }), false);
  assert.equal(ld(input({ brand: { name: 'Other', slug: 'other' } })).brand, undefined);
  assert.deepEqual(ld(input()).brand, { '@type': 'Brand', name: 'Agilent' });
  // Settings → “Brand names that are placeholders” with Dionex added.
  const dionex = { name: 'Dionex', slug: 'dionex' };
  assert.deepEqual(ld(input({ brand: dionex })).brand, { '@type': 'Brand', name: 'Dionex' });
  assert.equal(ld(input({ brand: dionex, placeholderBrands: ['other', 'dionex'] })).brand, undefined);
});

test('all own images as absolute URLs; condition from grade; seller = legal entity; plain-text description', () => {
  const out = ld(input());
  assert.deepEqual(out.image, [
    'https://labtodate.com/media/lab2date-media/products/import/a.jpg',
    'https://labtodate.com/media/lab2date-media/products/import/b.jpg',
  ]);
  assert.equal(out.itemCondition, 'https://schema.org/UsedCondition');
  assert.equal(out.description, 'Tested & working');
  assert.deepEqual((out.offers as Record<string, unknown>).seller, { '@type': 'Organization', name: 'Lab2date B.V.' });
  assert.equal(ld(input({ images: [] })).image, undefined);
});

test('return policy only when advertised, with the fields search engines require', () => {
  assert.equal(offerOf(input()).hasMerchantReturnPolicy, undefined);
  const policy = offerOf(input({ returnPolicy: { days: 14, country: 'NL', fees: 'CUSTOMER' } })).hasMerchantReturnPolicy;
  assert.deepEqual(policy, {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'NL',
    returnPolicyCountry: 'NL',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: 14,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees: 'https://schema.org/ReturnFeesCustomerResponsibility',
  });
  const free = offerOf(input({ returnPolicy: { days: 7, country: 'BE', fees: 'FREE' } })).hasMerchantReturnPolicy as Record<string, unknown>;
  assert.equal(free.returnFees, 'https://schema.org/FreeReturn');
  // Return shipping decided per case: no fee claim at all.
  const perCase = offerOf(input({ returnPolicy: { days: 7, country: 'NL', fees: null } })).hasMerchantReturnPolicy as Record<string, unknown>;
  assert.equal('returnFees' in perCase, false);
});

test('backorder: never SoldOut — BackOrder when it can be bought, OutOfStock when not', () => {
  assert.equal(schemaAvailability({ quantity: 0, sourceAvailability: 'onbackorder' }), 'OutOfStock');
  assert.equal(schemaAvailability({ quantity: 1, sourceAvailability: 'onbackorder' }), 'BackOrder');
});

test('public text (meta description, JSON-LD) never carries another price', () => {
  assert.equal(publicPlainText('Agilent /HP 7694 Headspace sampler € 4,500.00 For sale: refurbished Agilent G1888 Headspace sampler'), 'For sale: refurbished Agilent G1888 Headspace sampler');
  assert.equal(publicPlainText('<p>Prices from: 17.500 euro.</p>'), undefined);
  assert.equal(publicPlainText('<p>Quaternary pump. 600 bar.</p>'), 'Quaternary pump. 600 bar.');
});

test('plain text decodes every character reference (old imports: "&#8211;")', () => {
  assert.equal(plainText('<p>Agilent GCMS &#8211; 6890N with 5973N MSD &amp; 1.8&#8243; step</p>'), 'Agilent GCMS – 6890N with 5973N MSD & 1.8″ step');
  assert.equal(plainText('a&nbsp;b &deg;C'), 'a b °C');
});

test('placeholder brands are configurable', () => {
  assert.equal(isPlaceholderBrand({ name: 'Diverse' }, ['diverse']), true);
  assert.equal(isPlaceholderBrand({ name: 'Other' }, ['diverse']), false);
});

test('cutAtWord: about 155 characters, on a word boundary, with an ellipsis', () => {
  assert.equal(cutAtWord('Short text.'), 'Short text.');
  const long = 'For sale: Shimadzu HPLC with DAD including SPD-M20A Prominence Diode Array Detector, SIL-20AC Prominence autosampler, CTO-20AC Prominence column oven and more';
  const cut = cutAtWord(long, 100);
  assert.ok(cut.length <= 100, cut);
  assert.ok(cut.endsWith('…'));
  assert.ok(long.startsWith(cut.slice(0, -1)), 'cut at a word end');
  assert.match(cut, /autosampler…$|Prominence…$|SIL-20AC…$|Detector…$/);
});

test('the fact-based description leaves out what the title already says and empty brackets', () => {
  const f = SEO_TEXT_DEFAULTS.metaDescriptionFormat;
  assert.equal(
    fillMetaFormat(f, { condition: 'Used', brand: 'Agilent Technologies', title: 'Agilent 1200 series HPLC', category: 'HPLC / LC', year: 2008, site: 'Labtodate' }),
    'Used Agilent 1200 series HPLC (HPLC / LC, 2008) at Labtodate. See the condition, warranty and details of this unit.',
  );
  // The brand's first word in the title counts as naming it; another brand does not.
  assert.equal(
    fillMetaFormat('{BRAND} {TITLE}', { condition: '', brand: 'Waters Corporation', title: 'WATERS ALLIANCE 2695', category: '', year: null, site: '' }),
    'WATERS ALLIANCE 2695',
  );
  assert.equal(
    fillMetaFormat('{BRAND} {TITLE}', { condition: '', brand: 'Shimadzu', title: 'LC-20 HPLC system', category: '', year: null, site: '' }),
    'Shimadzu LC-20 HPLC system',
  );
  // Brand named in the title, no year: no "Agilent Agilent", no ", )".
  assert.equal(
    fillMetaFormat(f, { condition: 'Refurbished', brand: 'Agilent', title: 'Refurbished Agilent 1200 HPLC', category: 'HPLC / LC', year: null, site: 'Labtodate' }),
    'Refurbished Agilent 1200 HPLC (HPLC / LC) at Labtodate. See the condition, warranty and details of this unit.',
  );
  assert.equal(
    fillMetaFormat('{CONDITION} {BRAND} {TITLE} ({CATEGORY}, {YEAR}) — {SITE}', { condition: 'used', brand: null, title: 'Pump', category: '', year: null, site: 'L' }),
    'Used Pump — L',
  );
});

test('meta description: own SEO text → the listing text (not a copy of the title) → facts', () => {
  const base = {
    title: 'Agilent 1200 series HPLC',
    brandName: 'Agilent Technologies',
    conditionLabel: 'Used',
    categoryName: 'HPLC / LC',
    yearMade: 2008,
    siteName: 'Labtodate',
    format: SEO_TEXT_DEFAULTS.metaDescriptionFormat,
  };
  assert.equal(productMetaDescription({ ...base, seoDescription: '  Our own  text. ', summary: 'Summary', description: null }), 'Our own text.');
  assert.equal(productMetaDescription({ ...base, summary: 'Complete system, tested.', description: '<p>Long</p>' }), 'Complete system, tested.');
  // The summary only repeats the title: the description is used.
  assert.equal(
    productMetaDescription({ ...base, summary: 'Agilent Technologies Agilent 1200 series HPLC', description: '<p>Binary pump, autosampler &#8211; DAD.</p>' }),
    'Binary pump, autosampler – DAD.',
  );
  const facts = productMetaDescription({ ...base, summary: null, description: null });
  assert.match(facts, /^Used Agilent 1200 series HPLC \(HPLC \/ LC, 2008\) at Labtodate\./);
  assert.ok(facts.length <= 160);
  const long = productMetaDescription({ ...base, summary: null, description: `<p>${'Pump module with degasser and autosampler. '.repeat(10)}</p>` });
  assert.ok(long.length <= 155 && long.endsWith('…'), long);
});
