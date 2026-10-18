import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABOUT_PAGE_TOKENS, COOKIE_POLICY_TOKENS, DEFAULT_ABOUT_PAGE_TEXT, DEFAULT_COOKIE_POLICY_TEXT, DEFAULT_FAQ_TEXT, DEFAULT_PRIVACY_POLICY_TEXT,
  DEFAULT_SELLER_PAYOUT_TERMS_TEXT, DEFAULT_SELLER_TERMS_TEXT, FAQ_TOKENS, PRIVACY_POLICY_TOKENS, SELLER_TERMS_TOKENS, privacyMarketingBasis,
} from './page-texts';

const tokensOf = (text: string) => [...new Set(text.match(/\{[A-Z_]+\}/g) ?? [])];

test('every placeholder a default uses is listed for its page (the page fills only those)', () => {
  const pairs: [string, string, readonly string[]][] = [
    ['about', DEFAULT_ABOUT_PAGE_TEXT, ABOUT_PAGE_TOKENS],
    ['faq', DEFAULT_FAQ_TEXT, FAQ_TOKENS],
    ['privacy', DEFAULT_PRIVACY_POLICY_TEXT, PRIVACY_POLICY_TOKENS],
    ['cookies', DEFAULT_COOKIE_POLICY_TEXT, COOKIE_POLICY_TOKENS],
    ['seller terms', DEFAULT_SELLER_TERMS_TEXT, SELLER_TERMS_TOKENS],
    ['seller payout', DEFAULT_SELLER_PAYOUT_TERMS_TEXT, SELLER_TERMS_TOKENS],
  ];
  for (const [name, text, tokens] of pairs) {
    for (const t of tokensOf(text)) assert.ok(tokens.includes(t), `${name}: ${t} is not in its token list`);
  }
});

test('privacy: the marketing paragraph follows the soft opt-in setting', () => {
  assert.ok(PRIVACY_POLICY_TOKENS.includes('{MARKETING_BASIS}'));
  assert.match(DEFAULT_PRIVACY_POLICY_TEXT, /\{MARKETING_BASIS\}/);
  // No fixed claim that only opted-in people get offers: past buyers do while the soft opt-in is on.
  assert.doesNotMatch(DEFAULT_PRIVACY_POLICY_TEXT, /Only if you opted in/);
  assert.doesNotMatch(DEFAULT_PRIVACY_POLICY_TEXT, /for news and offers, your consent/);

  const on = privacyMarketingBasis(true);
  assert.match(on, /bought from us/);
  assert.match(on, /11\.7\(3\)/);
  assert.match(on, /unless you opt out/);
  assert.match(on, /opting in \(your consent\)/);
  const off = privacyMarketingBasis(false);
  assert.match(off, /Only if you opted in/);
  assert.doesNotMatch(off, /bought from us|11\.7/);
});

test('privacy: lists the sell-to-us data, the terms acceptance record and suppliers as recipients', () => {
  const p = DEFAULT_PRIVACY_POLICY_TEXT;
  assert.match(p, /Selling equipment to us/);
  assert.match(p, /bank account we pay you on/);
  assert.match(p, /VAT ID and KvK/);
  assert.match(p, /declarations you accept \(ownership, decontamination\)/);
  assert.match(p, /accept our Terms of Sale[^.]*IP address/);
  assert.match(p, /buy it from you and pay you for it/);
  assert.match(p, /Suppliers: [^.]*not your name or contact details/);
  assert.ok(p.length < 5000, 'fits the 5000-character limit of a text setting');
});

test('cookies: only what the public site really keeps (no theme: the site is dark only)', () => {
  assert.doesNotMatch(DEFAULT_COOKIE_POLICY_TEXT, /theme|light|dark/i);
  assert.match(DEFAULT_COOKIE_POLICY_TEXT, /closed the cookie notice is kept in your browser’s local storage/);
  assert.doesNotMatch(DEFAULT_COOKIE_POLICY_TEXT, /assistant|chat/i);
});
