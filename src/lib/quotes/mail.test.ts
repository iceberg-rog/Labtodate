import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The settings as Admin → Settings stores them, served by an in-memory stand-in
// for the one table read here (lib/db.ts re-uses globalThis.__prisma outside
// production) — no database, no .env.
const rows = new Map<string, string>();
(globalThis as { __prisma?: unknown }).__prisma = {
  setting: { findMany: async () => [...rows].map(([key, value]) => ({ key, value })) },
};
(globalThis as { __settingEnvDefaults?: unknown }).__settingEnvDefaults = {};

const KEYS = ['SITE_NAME', 'COMPANY_LEGAL_NAME', 'COMPANY_ADDRESS', 'COMPANY_COUNTRY', 'COMPANY_KVK', 'COMPANY_VAT', 'COMPANY_WEBSITE',
  'COMPANY_LOGO_URL', 'SUPPORT_EMAIL', 'TRANSACTIONAL_REPLY_TO', 'EMAIL_BRAND_COLOR', 'BETTER_AUTH_URL'];

const IDENTITY = {
  SITE_NAME: 'Labtodate',
  COMPANY_LEGAL_NAME: 'Labtodate B.V.',
  COMPANY_ADDRESS: 'Industrieweg 12\n2712 LB Zoetermeer',
  COMPANY_COUNTRY: 'Netherlands',
  COMPANY_KVK: '87654321',
  COMPANY_VAT: 'NL859123456B01',
  COMPANY_WEBSITE: 'labtodate.com',
  COMPANY_LOGO_URL: '/media/lab2date-media/products/branding/logo-1.png',
  SUPPORT_EMAIL: 'support@labtodate.com',
};

const load = () => import('./mail');

beforeEach(async () => {
  rows.clear();
  for (const k of KEYS) delete process.env[k];
  process.env.BETTER_AUTH_URL = 'https://labtodate.com';
  (await import('../settings')).invalidateSettingsCache();
});

test('every e-mail shows the uploaded logo, the brand colour and the legal identity footer', async () => {
  Object.assign(process.env, IDENTITY);
  const { mailLayout } = await load();
  const html = mailLayout({ heading: 'Your offer', body: ['Hi <b>x</b>'], cta: { href: 'https://labtodate.com/app', label: 'Open' } });
  assert.match(html, /<img src="https:\/\/labtodate\.com\/media\/lab2date-media\/products\/branding\/logo-1\.png" alt="Labtodate" height="40"/);
  assert.match(html, /color:#0E4F40;margin:0 0 12px;font-size:20px;">Your offer<\/h2>/);
  assert.match(html, /background:#0E4F40;color:#ffffff/);
  assert.match(html, /Labtodate B\.V\., Industrieweg 12, 2712 LB Zoetermeer, Netherlands/);
  assert.match(html, /KvK 87654321 · VAT NL859123456B01/);
  assert.match(html, /mailto:support@labtodate\.com/);
  assert.match(html, /href="https:\/\/labtodate\.com"/);
  assert.doesNotMatch(html, /lab2date(?!-media)/i);
});

test('without a logo the site name is the header; the configured colour is used', async () => {
  Object.assign(process.env, { SITE_NAME: 'Lab & Co', EMAIL_BRAND_COLOR: '#1d4ed8' });
  const { mailLayout } = await load();
  const html = mailLayout({ heading: 'Hello', body: [] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /color:#1D4ED8;">Lab &amp; Co<\/span>/);
  // Nothing invented: no legal name, KvK or VAT when they are not set.
  assert.doesNotMatch(html, /KvK|VAT/);
});

test('an unreadable brand colour never reaches a mail', async () => {
  Object.assign(process.env, { EMAIL_BRAND_COLOR: '#e2ff9c' });
  const { mailBrandColor } = await load();
  assert.equal(mailBrandColor(), '#0E4F40');
});

test('the text part carries the same legal footer', async () => {
  Object.assign(process.env, IDENTITY);
  const { mailTextFooter } = await load();
  assert.equal(
    mailTextFooter(),
    '—\nLabtodate B.V., Industrieweg 12, 2712 LB Zoetermeer, Netherlands\nKvK 87654321 · VAT NL859123456B01\nsupport@labtodate.com · labtodate.com',
  );
});

test('replyHint: “reply to this e-mail” only when replies reach a person', async () => {
  const { replyHint } = await load();
  assert.equal(replyHint().invitesReply, false);
  assert.match(replyHint().text, /https:\/\/labtodate\.com\/support/);
  process.env.TRANSACTIONAL_REPLY_TO = 'orders@labtodate.local';
  assert.equal(replyHint().invitesReply, false, 'a placeholder is not a reply address');
  process.env.TRANSACTIONAL_REPLY_TO = 'orders@labtodate.com';
  assert.equal(replyHint().invitesReply, true);
  assert.match(replyHint().html, /reply to this e-mail/);
});

test('brandedMail reads the live settings: subject with SITE_NAME, layout, text footer', async () => {
  for (const [k, v] of Object.entries({ ...IDENTITY, SITE_NAME: 'Labtodate Live' })) rows.set(k, v);
  const { brandedMail } = await load();
  const m = await brandedMail((site) => ({
    subject: `12345 is your ${site} verification code`,
    heading: 'Confirm your e-mail',
    body: ['Enter this code'],
    text: `Your ${site} verification code is 12345.`,
  }));
  assert.equal(m.subject, '12345 is your Labtodate Live verification code');
  assert.match(m.html, /alt="Labtodate Live"/);
  assert.match(m.html, /KvK 87654321/);
  assert.match(m.text, /^Your Labtodate Live verification code is 12345\.\n\n—\nLabtodate B\.V\./);
});

test('sendEmail sets a Reply-To on customer mail: TRANSACTIONAL_REPLY_TO, else the support address', async () => {
  const { defaultReplyTo } = await import('../email');
  assert.equal(defaultReplyTo('transactional'), undefined);
  process.env.SUPPORT_EMAIL = 'support@labtodate.local';
  assert.equal(defaultReplyTo('transactional'), undefined, 'never a placeholder');
  process.env.SUPPORT_EMAIL = 'support@labtodate.com';
  assert.equal(defaultReplyTo('auth.password-reset'), 'support@labtodate.com');
  process.env.TRANSACTIONAL_REPLY_TO = 'orders@labtodate.com';
  for (const t of ['transactional', 'account', 'auth.magic-link', 'marketing', 'admin'] as const) assert.equal(defaultReplyTo(t), 'orders@labtodate.com', t);
  // Staff copies: their callers decide (often the customer's own address).
  assert.equal(defaultReplyTo('internal'), undefined);
});
