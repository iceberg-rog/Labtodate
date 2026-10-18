import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { settingDef } from '@/lib/settings/defs';
import { DEFAULT_TERMS_TEXT } from '@/lib/catalog/texts';
import { QUOTE_SETTING_DEFS, termsLink } from './settings-defs';
import {
  DEFAULT_TERMS_OF_SALE_URL, closeReasons, mediationMode, renderTermsOfSale, sellerOffersGoDirect, termsLinkIsBuiltIn, termsOfSaleHref, termsOfSaleUrl,
  termsPlaceholders, termsVersionOf, vatReviewBuyerText,
} from './policy';

// The getters read the hydrated settings (process.env) with the registry
// default as fallback — no database needed here.
const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { fn(); } finally { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

test('the Terms of Sale link defaults to the page that exists and is validated', () => {
  assert.equal(settingDef('TERMS_OF_SALE_URL')?.default, '/legal/terms');
  withEnv({ TERMS_OF_SALE_URL: undefined }, () => {
    assert.equal(termsOfSaleUrl(), DEFAULT_TERMS_OF_SALE_URL);
    assert.equal(termsOfSaleHref('https://labtodate.com'), 'https://labtodate.com/legal/terms');
  });
  withEnv({ TERMS_OF_SALE_URL: 'https://example.org/terms.pdf' }, () => assert.equal(termsOfSaleHref('https://labtodate.com'), 'https://example.org/terms.pdf'));
  assert.equal(termsLink('/legal/terms'), null);
  assert.equal(termsLink('https://labtodate.com/legal/terms'), null);
  for (const bad of ['//evil.example/terms', 'http://labtodate.com/terms', 'legal/terms', 'javascript:alert(1)', '/legal terms']) {
    assert.notEqual(termsLink(bad), null, bad);
  }
});

test('the accepted terms version is the sha256 of the terms as the buyer reads them (placeholders filled)', () => {
  const settings = {
    site: 'Labtodate', legalName: 'Labtodate B.V.', country: 'Netherlands', returnDays: 7, offerValidDays: 14, paymentTermDays: 14,
    priceMode: 'EXCL', labelIncl: 'incl. VAT', labelExcl: 'excl. VAT', warrantyFallback: '3 months', inspectionRequiresReport: true, shippingClaim: '',
  };
  const template = settingDef('LEGAL_TERMS_TEXT')?.default || DEFAULT_TERMS_TEXT;
  const t = renderTermsOfSale(template, termsPlaceholders(settings), 'support@labtodate.com');
  assert.match(t.version, /^sha256:[0-9a-f]{64}$/);
  assert.equal(t.version, `sha256:${createHash('sha256').update(t.text).digest('hex')}`);
  assert.doesNotMatch(t.text, /\{[A-Z_]+\}/, 'no placeholder is left in the text the buyer reads');
  assert.equal(renderTermsOfSale(template, termsPlaceholders(settings), 'support@labtodate.com').version, t.version, 'same settings, same version');
  // A setting the text quotes changes what the buyer accepted — and so the version.
  assert.ok(template.includes('{RETURN_DAYS}') && template.includes('{PAYMENT_TERM_DAYS}'));
  assert.notEqual(renderTermsOfSale(template, termsPlaceholders({ ...settings, returnDays: 14 }), 'support@labtodate.com').version, t.version);
  assert.notEqual(renderTermsOfSale(template, termsPlaceholders({ ...settings, paymentTermDays: 30 }), 'support@labtodate.com').version, t.version);
  const custom = renderTermsOfSale('## Payment\nPay within {PAYMENT_TERM_DAYS} days. Questions: {CONTACT}.', termsPlaceholders(settings), 'support@labtodate.com');
  assert.equal(custom.text, '## Payment\n\nPay within 14 days. Questions: support@labtodate.com.');
  assert.equal(termsVersionOf('a\r\nb'), termsVersionOf('a\nb'), 'line endings do not make a new version');
});

test('only the built-in Terms page is versioned', () => {
  assert.equal(termsLinkIsBuiltIn('/legal/terms', 'https://labtodate.com'), true);
  assert.equal(termsLinkIsBuiltIn('/terms', 'https://labtodate.com'), true, '/terms redirects there');
  assert.equal(termsLinkIsBuiltIn('https://labtodate.com/legal/terms/', 'https://labtodate.com'), true);
  assert.equal(termsLinkIsBuiltIn('https://example.org/legal/terms', 'https://labtodate.com'), false);
  assert.equal(termsLinkIsBuiltIn('/legal/terms-b2b.pdf', 'https://labtodate.com'), false);
  assert.equal(termsLinkIsBuiltIn('not a link', ''), false);
});

test('close reasons, mediation mode and the VAT-review texts are settings', () => {
  withEnv({ QUOTE_CLOSE_REASONS: undefined }, () => assert.ok(closeReasons().includes('No suitable unit found')));
  withEnv({ QUOTE_CLOSE_REASONS: 'Gone,Other' }, () => assert.deepEqual(closeReasons(), ['Gone', 'Other']));
  withEnv({ MESSAGE_MEDIATION_MODE: undefined }, () => assert.equal(mediationMode(), 'MASK_CONTACTS'));
  withEnv({ MESSAGE_MEDIATION_MODE: 'STAFF_REVIEW' }, () => assert.equal(mediationMode(), 'STAFF_REVIEW'));
  withEnv({ MESSAGE_MEDIATION_MODE: 'bogus' }, () => assert.equal(mediationMode(), 'MASK_CONTACTS'));
  withEnv({ QUOTE_MSG_VAT_ID_UNCHECKED: undefined, QUOTE_MSG_VAT_ID_UNCHECKED_PREVIEW: undefined, QUOTE_MSG_VAT_REVIEW_PREVIEW: undefined }, () => {
    assert.equal(vatReviewBuyerText('VIES_UNAVAILABLE', 'PLACED'), 'We could not check your VAT ID with the EU service right now. Your order is placed; we confirm the VAT before asking for payment.');
    // Before the buyer confirms, nothing is ordered: the acceptance step never says "your order is placed".
    for (const kind of ['VIES_UNAVAILABLE', 'REVIEW'] as const) {
      const preview = vatReviewBuyerText(kind, 'PREVIEW');
      assert.match(preview, /If you accept, your order is placed/);
      assert.doesNotMatch(preview, /Your order is placed/);
    }
  });
  withEnv({ QUOTE_MSG_VAT_REVIEW: 'Custom text.' }, () => assert.equal(vatReviewBuyerText('REVIEW', 'PLACED'), 'Custom text.'));
  withEnv({ QUOTE_MSG_VAT_REVIEW_PREVIEW: 'Custom preview.' }, () => assert.equal(vatReviewBuyerText('REVIEW', 'PREVIEW'), 'Custom preview.'));
  for (const k of ['QUOTE_MSG_VAT_ID_UNCHECKED_PREVIEW', 'QUOTE_MSG_VAT_REVIEW_PREVIEW']) {
    assert.doesNotMatch(settingDef(k)?.default ?? '', /Your order is placed/, k);
  }
});

test('a supplier price goes to the buyer directly only with review off and supplier texts not held for staff', () => {
  withEnv({ SELLER_OFFERS_REQUIRE_APPROVAL: 'false', MESSAGE_MEDIATION_MODE: 'MASK_CONTACTS' }, () => assert.equal(sellerOffersGoDirect(), true));
  withEnv({ SELLER_OFFERS_REQUIRE_APPROVAL: 'false', MESSAGE_MEDIATION_MODE: 'STAFF_REVIEW' }, () => assert.equal(sellerOffersGoDirect(), false));
  withEnv({ SELLER_OFFERS_REQUIRE_APPROVAL: 'true', MESSAGE_MEDIATION_MODE: 'OFF' }, () => assert.equal(sellerOffersGoDirect(), false));
});

test('quote settings name no brand (it comes from SITE_NAME)', () => {
  for (const d of QUOTE_SETTING_DEFS) {
    assert.doesNotMatch(`${d.label} ${d.hint ?? ''} ${d.default ?? ''}`, /lab2date/i, d.key);
  }
  assert.equal(settingDef('QUOTE_CLOSE_REASONS')?.group, 'Quotes & offers');
});
