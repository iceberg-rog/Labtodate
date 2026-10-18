import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { settingDef } from '@/lib/settings/defs';
import { DEFAULT_TERMS_TEXT } from '@/lib/catalog/texts';
import { QUOTE_SETTING_DEFS, termsLink } from './settings-defs';
import {
  DEFAULT_TERMS_OF_SALE_URL, closeReasons, mediationMode, termsOfSaleHref, termsOfSaleUrl, termsTextVersion, vatReviewBuyerText,
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

test('the accepted terms version is the sha256 of the terms text in force', () => {
  withEnv({ LEGAL_TERMS_TEXT: undefined }, () => {
    const v = termsTextVersion();
    assert.match(v, /^sha256:[0-9a-f]{64}$/);
    const def = settingDef('LEGAL_TERMS_TEXT')?.default || DEFAULT_TERMS_TEXT;
    assert.equal(v, `sha256:${createHash('sha256').update(def.replace(/\r\n/g, '\n')).digest('hex')}`);
  });
  withEnv({ LEGAL_TERMS_TEXT: 'Our terms, version 2.' }, () => {
    assert.equal(termsTextVersion(), `sha256:${createHash('sha256').update('Our terms, version 2.').digest('hex')}`);
    withEnv({ LEGAL_TERMS_TEXT: 'Our terms,\r\nversion 2.' }, () => assert.equal(termsTextVersion(), `sha256:${createHash('sha256').update('Our terms,\nversion 2.').digest('hex')}`));
  });
});

test('close reasons, mediation mode and the VAT-review texts are settings', () => {
  withEnv({ QUOTE_CLOSE_REASONS: undefined }, () => assert.ok(closeReasons().includes('No suitable unit found')));
  withEnv({ QUOTE_CLOSE_REASONS: 'Gone,Other' }, () => assert.deepEqual(closeReasons(), ['Gone', 'Other']));
  withEnv({ MESSAGE_MEDIATION_MODE: undefined }, () => assert.equal(mediationMode(), 'MASK_CONTACTS'));
  withEnv({ MESSAGE_MEDIATION_MODE: 'STAFF_REVIEW' }, () => assert.equal(mediationMode(), 'STAFF_REVIEW'));
  withEnv({ MESSAGE_MEDIATION_MODE: 'bogus' }, () => assert.equal(mediationMode(), 'MASK_CONTACTS'));
  withEnv({ QUOTE_MSG_VAT_ID_UNCHECKED: undefined }, () => {
    assert.equal(vatReviewBuyerText('VIES_UNAVAILABLE'), 'We could not check your VAT ID with the EU service right now. Your order is placed; we confirm the VAT before asking for payment.');
  });
  withEnv({ QUOTE_MSG_VAT_REVIEW: 'Custom text.' }, () => assert.equal(vatReviewBuyerText('REVIEW'), 'Custom text.'));
});

test('quote settings name no brand (it comes from SITE_NAME)', () => {
  for (const d of QUOTE_SETTING_DEFS) {
    assert.doesNotMatch(`${d.label} ${d.hint ?? ''} ${d.default ?? ''}`, /lab2date/i, d.key);
  }
  assert.equal(settingDef('QUOTE_CLOSE_REASONS')?.group, 'Quotes & offers');
});
