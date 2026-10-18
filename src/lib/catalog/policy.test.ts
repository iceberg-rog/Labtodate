import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPolicyFrom, linkPreviewFrom, termsStateReturnWindow } from './policy';
import { CATALOG_SETTING_DEFS, SEO_TEXT_DEFAULTS } from './settings-defs';
import { DEFAULT_TERMS_TEXT } from './texts';
import { settingDef, validateSettingValue } from '../settings/defs';

const policy = (env: Record<string, string> = {}) => catalogPolicyFrom((k) => env[k] ?? '');

test('the return window is advertised only when switched on AND stated by the terms', () => {
  assert.equal(policy().seoReturnPolicy, null, 'off by default');
  assert.equal(policy().seoReturnPolicyDays, null);
  // On, with the default terms ({RETURN_DAYS} in §5/§6): advertised, 7 days, home country.
  assert.deepEqual(policy({ SEO_ADVERTISE_RETURN_POLICY: 'true' }).seoReturnPolicy, { days: 7, country: 'NL', fees: null });
  // Terms written without the window: nothing is advertised.
  const noWindow = { SEO_ADVERTISE_RETURN_POLICY: 'true', LEGAL_TERMS_TEXT: 'Equipment is sold as is. No returns.' };
  assert.equal(policy(noWindow).seoReturnPolicy, null);
  // Fees follow "Return shipping is paid by"; the country the VAT home country.
  const p = policy({ SEO_ADVERTISE_RETURN_POLICY: 'true', RETURN_WINDOW_DAYS: '14', RETURN_FREIGHT_PAID_BY: 'SELLER', TAX_HOME_COUNTRY: 'be' });
  assert.deepEqual(p.seoReturnPolicy, { days: 14, country: 'BE', fees: 'FREE' });
  assert.equal(p.seoReturnPolicyDays, 14);
  assert.equal(policy({ SEO_ADVERTISE_RETURN_POLICY: 'true', RETURN_FREIGHT_PAID_BY: 'BUYER' }).seoReturnPolicy?.fees, 'CUSTOMER');
});

test('terms state the window: the placeholder or the spelled number of days', () => {
  assert.equal(termsStateReturnWindow(DEFAULT_TERMS_TEXT, 7), true);
  assert.equal(termsStateReturnWindow('Report it within 14 days of delivery.', 14), true);
  assert.equal(termsStateReturnWindow('A 14-day return window applies.', 14), true);
  assert.equal(termsStateReturnWindow('Report it within 14 days of delivery.', 7), false);
  assert.equal(termsStateReturnWindow('Report it within 114 days.', 14), false);
  assert.equal(termsStateReturnWindow('Sold as is.', 7), false);
});

test('archived listings, sold prices, the meta format and the not-found texts are settings', () => {
  const d = policy();
  assert.equal(d.archivedListingResponse, 'GONE');
  assert.equal(d.soldPriceShown, true);
  assert.equal(d.texts.soldPriceLabel, 'Last price');
  assert.equal(d.metaDescriptionFormat, SEO_TEXT_DEFAULTS.metaDescriptionFormat);
  assert.equal(d.texts.notFoundTitle, SEO_TEXT_DEFAULTS.notFoundTitle);
  const s = policy({
    ARCHIVED_LISTING_RESPONSE: 'REDIRECT_CATEGORY',
    PDP_SOLD_PRICE: 'HIDE',
    PDP_SOLD_PRICE_LABEL: 'Sold for',
    PDP_META_DESCRIPTION_FORMAT: '{TITLE} — {SITE}',
    NOT_FOUND_TITLE: 'Nothing here',
  });
  assert.equal(s.archivedListingResponse, 'REDIRECT_CATEGORY');
  assert.equal(s.soldPriceShown, false);
  assert.equal(s.texts.soldPriceLabel, 'Sold for');
  assert.equal(s.metaDescriptionFormat, '{TITLE} — {SITE}');
  assert.equal(s.texts.notFoundTitle, 'Nothing here');
  // A format without {TITLE} (e.g. typed before validation existed) falls back.
  assert.equal(policy({ PDP_META_DESCRIPTION_FORMAT: 'Used gear' }).metaDescriptionFormat, SEO_TEXT_DEFAULTS.metaDescriptionFormat);
  // Garbage enum values fall back to the defaults.
  assert.equal(policy({ ARCHIVED_LISTING_RESPONSE: 'X', PDP_SOLD_PRICE: 'Y' }).archivedListingResponse, 'GONE');
});

test('the new keys are registered with valid defaults and validation', () => {
  for (const key of ['ARCHIVED_LISTING_RESPONSE', 'PDP_SOLD_PRICE', 'PDP_SOLD_PRICE_LABEL', 'PDP_META_DESCRIPTION_FORMAT', 'NOT_FOUND_TITLE', 'NOT_FOUND_TEXT']) {
    assert.ok(CATALOG_SETTING_DEFS.some((d) => d.key === key), key);
    assert.ok(settingDef(key), `${key} in the registry`);
  }
  const fmt = settingDef('PDP_META_DESCRIPTION_FORMAT')!;
  assert.equal(validateSettingValue(fmt, '{CONDITION} {TITLE} at {SITE}'), null);
  assert.match(validateSettingValue(fmt, '{CONDITION} at {SITE}') ?? '', /\{TITLE\}/);
  assert.match(validateSettingValue(fmt, '{TITLE} for {PRICE}') ?? '', /unknown placeholder \{PRICE\}/);
  // The link-preview keys are read now (PKG-14): no "not applied yet" marker.
  assert.equal(settingDef('OG_DEFAULT_IMAGE_URL')?.pending, undefined);
  assert.equal(settingDef('OG_LOCALE')?.pending, undefined);
});

test('link-preview defaults: og:locale and the default picture', () => {
  assert.deepEqual(linkPreviewFrom(() => ''), { locale: 'en_US', image: null });
  const env: Record<string, string> = { OG_LOCALE: 'nl_NL', OG_DEFAULT_IMAGE_URL: '/media/lab2date-media/og.png' };
  assert.deepEqual(linkPreviewFrom((k) => env[k] ?? ''), { locale: 'nl_NL', image: '/media/lab2date-media/og.png' });
  assert.equal(linkPreviewFrom((k) => ({ OG_DEFAULT_IMAGE_URL: 'https://cdn.example.com/og.jpg' })[k] ?? '').image, 'https://cdn.example.com/og.jpg');
  // Not a usable value: no picture / the default locale.
  assert.equal(linkPreviewFrom((k) => ({ OG_DEFAULT_IMAGE_URL: '//evil.example/x.png' })[k] ?? '').image, null);
  assert.equal(linkPreviewFrom((k) => ({ OG_LOCALE: 'english' })[k] ?? '').locale, 'en_US');
  assert.deepEqual(policy({ OG_LOCALE: 'en_GB' }).linkPreview, { locale: 'en_GB', image: null });
});
