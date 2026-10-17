import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProductJsonLd, isPlaceholderBrand, publicPlainText, schemaAvailability, type ProductJsonLdInput } from '../../src/lib/catalog/jsonld';
import { resolveOfferPrice } from '../../src/lib/catalog/offer-price';

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
      ...product,
    },
    images: ['/media/lab2date-media/products/import/a.jpg', '/media/lab2date-media/products/import/b.jpg'],
    brand: { name: 'Agilent', slug: 'agilent' },
    categoryName: 'HPLC',
    schemaOrgCondition: 'UsedCondition',
    offer: resolveOfferPrice({ priceCents: 100000, currency: 'EUR', mode: 'HYBRID' }, null),
    sellerName: 'Lab2date B.V.',
    returnPolicyDays: null,
    rating: null,
    ...over,
  };
}

test('availability comes from stock, never a constant', () => {
  assert.equal(schemaAvailability({ quantity: 2 }), 'InStock');
  assert.equal(schemaAvailability({ quantity: 0 }), 'SoldOut');
  assert.equal(schemaAvailability({ quantity: 0, sourceAvailability: 'outofstock' }), 'OutOfStock');
  assert.equal(schemaAvailability({ quantity: 0, removedAtSourceAt: new Date() }), 'Discontinued');
  const sold = buildProductJsonLd(input({}, { quantity: 0 }));
  assert.equal((sold.offers as Record<string, unknown>).availability, 'https://schema.org/SoldOut');
});

test('price is the buyer-facing price after the shop markup', () => {
  const offer = resolveOfferPrice({ priceCents: 100000, currency: 'EUR', mode: 'HYBRID' }, { pricingMode: 'MARKUP_PERCENT', pricingMarkupBp: 2000 });
  const ld = buildProductJsonLd(input({ offer }));
  assert.equal((ld.offers as Record<string, unknown>).price, '1200.00');
});

test('no Offer for quote-only or hidden prices', () => {
  const forced = resolveOfferPrice({ priceCents: 100000, currency: 'EUR', mode: 'HYBRID' }, { pricingMode: 'FORCE_QUOTE', pricingMarkupBp: 0 });
  assert.equal(buildProductJsonLd(input({ offer: forced })).offers, undefined);
  const hidden = resolveOfferPrice({ priceCents: 100000, currency: 'EUR', mode: 'HYBRID' }, { pricingMode: 'HIDE_PRICE', pricingMarkupBp: 0 });
  assert.equal(hidden.purchasable, false);
  assert.equal(buildProductJsonLd(input({ offer: hidden })).offers, undefined);
  const quote = resolveOfferPrice({ priceCents: null, currency: 'EUR', mode: 'QUOTE_ONLY' }, null);
  assert.equal(buildProductJsonLd(input({ offer: quote })).offers, undefined);
});

test('sku / mpn only when real; never the slug', () => {
  const none = buildProductJsonLd(input());
  assert.equal(none.sku, undefined);
  assert.equal(none.mpn, undefined);
  const real = buildProductJsonLd(input({}, { sku: 'L2D-0042', mpn: 'G1311-60001' }));
  assert.equal(real.sku, 'L2D-0042');
  assert.equal(real.mpn, 'G1311-60001');
});

test('placeholder brands are omitted', () => {
  assert.equal(isPlaceholderBrand({ name: 'Other', slug: 'other' }), true);
  assert.equal(isPlaceholderBrand(null), true);
  assert.equal(isPlaceholderBrand({ name: 'Agilent', slug: 'agilent' }), false);
  assert.equal(buildProductJsonLd(input({ brand: { name: 'Other', slug: 'other' } })).brand, undefined);
  assert.deepEqual(buildProductJsonLd(input()).brand, { '@type': 'Brand', name: 'Agilent' });
});

test('all own images as absolute URLs; condition from grade; seller = legal entity; plain-text description', () => {
  const ld = buildProductJsonLd(input());
  assert.deepEqual(ld.image, [
    'https://labtodate.com/media/lab2date-media/products/import/a.jpg',
    'https://labtodate.com/media/lab2date-media/products/import/b.jpg',
  ]);
  assert.equal(ld.itemCondition, 'https://schema.org/UsedCondition');
  assert.equal(ld.description, 'Tested & working');
  assert.deepEqual((ld.offers as Record<string, unknown>).seller, { '@type': 'Organization', name: 'Lab2date B.V.' });
  assert.equal(buildProductJsonLd(input({ images: [] })).image, undefined);
});

test('return policy only when configured', () => {
  assert.equal((buildProductJsonLd(input()).offers as Record<string, unknown>).hasMerchantReturnPolicy, undefined);
  const withPolicy = buildProductJsonLd(input({ returnPolicyDays: 14 }));
  assert.equal(((withPolicy.offers as Record<string, unknown>).hasMerchantReturnPolicy as Record<string, unknown>).merchantReturnDays, 14);
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

test('placeholder brands are configurable', () => {
  assert.equal(isPlaceholderBrand({ name: 'Diverse' }, ['diverse']), true);
  assert.equal(isPlaceholderBrand({ name: 'Other' }, ['diverse']), false);
});
