import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPolicy, planPolicySave, policyFromRows, splitPolicyList, formatPolicyValue } from './policy';
import { parseAbandonedFilter, abandonedWhere, cutoffFor } from './unverified';
import { canonicalAuthPath } from './auth-paths';
import { settingDef, validateSettingValue } from '../settings/defs';

/** The whole form as the Security tab submits it, with some fields changed. */
function form(overrides: Record<string, string | string[]>) {
  const p = defaultPolicy() as unknown as Record<string, unknown>;
  const input: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'boolean') {
      if (v) input[k] = 'on';
    } else if (Array.isArray(v)) {
      input[k] = k.startsWith('MAIL_') ? v.join('\n') : v;
    } else input[k] = String(v);
  }
  return { ...input, ...overrides };
}

test('every bot-check and e-mail rule is an admin setting with a safe default', () => {
  const p = defaultPolicy();
  assert.deepEqual(p.CAPTCHA_ALWAYS.sort(), ['magic_link', 'password_reset', 'sell', 'signup', 'support', 'verify_email']);
  assert.equal(p.CAPTCHA_SIGNIN_AFTER_FAILS, 3);
  assert.ok(p.MAIL_BLOCKED_DOMAINS.includes('txt.att.net'));
  assert.equal(p.MAIL_BLOCK_DISPOSABLE, true);
  assert.equal(p.UNVERIFIED_AUTO_PURGE, false);
  for (const k of ['CAPTCHA_ALWAYS', 'CAPTCHA_COST', 'CAPTCHA_MAX_TRIES', 'CAPTCHA_SIGNIN_AFTER_FAILS', 'MAIL_BLOCKED_DOMAINS', 'MAIL_ADDRESS_COOLDOWN_SEC',
    'MAIL_DOMAIN_MAX_PER_HOUR', 'MAIL_ANON_MAX_PER_HOUR', 'MAIL_BOUNCE_SUPPRESS_AFTER', 'MAIL_IP_SIGNUPS_PER_HOUR', 'UNVERIFIED_PURGE_DAYS']) {
    const d = settingDef(k);
    assert.ok(d, `${k} is in the settings registry (Change history)`);
    assert.equal(d!.group, 'Security');
    if (d!.default !== undefined) assert.equal(validateSettingValue(d!, d!.default), null, k);
  }
});

test('domain lists: typed one per line or with commas, stored lower-case, bad entries refused', () => {
  assert.deepEqual(splitPolicyList(' TXT.att.net\n\n@vtext.com, tmomail.net.;tmomail.net '), ['txt.att.net', 'vtext.com', 'tmomail.net']);
  const ok = planPolicySave(defaultPolicy(), form({ MAIL_BLOCKED_DOMAINS: 'txt.att.net\nVTEXT.com\nexample-spam.biz' }));
  assert.deepEqual(ok.problems, []);
  const w = ok.writes.find((x) => x.key === 'MAIL_BLOCKED_DOMAINS');
  assert.equal(w?.value, 'example-spam.biz,txt.att.net,vtext.com');
  assert.equal(policyFromRows([{ key: 'MAIL_BLOCKED_DOMAINS', value: w!.value! }]).MAIL_BLOCKED_DOMAINS.length, 3);

  const bad = planPolicySave(defaultPolicy(), form({ MAIL_BLOCKED_DOMAINS: 'txt.att.net\nnot a domain\nhttp://x.com' }));
  assert.equal(bad.writes.length, 0);
  assert.match(bad.problems.join(' '), /not valid/);
  // An unparseable stored value falls back to the default list.
  assert.ok(policyFromRows([{ key: 'MAIL_BLOCKED_DOMAINS', value: 'bad value!' }]).MAIL_BLOCKED_DOMAINS.includes('vtext.com'));
  // Long lists are summarised in history / alerts.
  assert.match(formatPolicyValue('MAIL_DOMAIN_CAP_EXEMPT', defaultPolicy().MAIL_DOMAIN_CAP_EXEMPT), /in total/);
});

test('switching the check off for a form and changing numbers is saved; the default round-trips to "no row"', () => {
  const plan = planPolicySave(defaultPolicy(), form({ CAPTCHA_ALWAYS: ['signup', 'password_reset'], CAPTCHA_COST: '2000' }));
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.writes.find((w) => w.key === 'CAPTCHA_ALWAYS')?.value, 'password_reset,signup');
  assert.equal(plan.writes.find((w) => w.key === 'CAPTCHA_COST')?.value, '2000');
  const back = planPolicySave(policyFromRows(plan.writes.map((w) => ({ key: w.key, value: w.value ?? '' }))), form({}));
  assert.equal(back.writes.find((w) => w.key === 'CAPTCHA_COST')?.value, null);
  const tooBig = planPolicySave(defaultPolicy(), form({ CAPTCHA_COST: '999999999' }));
  assert.match(tooBig.problems.join(' '), /whole number/);
});

test('unverified purge filter: days, optional start date and domain; nothing with activity matches', () => {
  assert.deepEqual(parseAbandonedFilter({}, 7), { olderThanDays: 7, createdFrom: null, domain: null });
  const f = parseAbandonedFilter({ days: '0', from: '2026-10-05', domain: '@TXT.att.net ' }, 7)!;
  assert.equal(f.olderThanDays, 0);
  assert.equal(f.createdFrom?.toISOString(), '2026-10-05T00:00:00.000Z');
  assert.equal(f.domain, 'txt.att.net');
  assert.equal(parseAbandonedFilter({ days: '-1' }, 7), null);
  assert.equal(parseAbandonedFilter({ days: 'x' }, 7), null);
  assert.equal(parseAbandonedFilter({ from: 'not a date' }, 7), null);

  const now = new Date('2026-10-17T12:00:00Z');
  const where = abandonedWhere(f, now) as Record<string, unknown>;
  assert.equal(where.emailVerified, false);
  assert.equal(where.role, 'BUYER');
  assert.equal(where.companyId, null);
  for (const rel of ['ordersAsBuyer', 'sourcingRequestsSubmitted', 'supportTickets', 'productsOwned', 'messagesSent', 'sellSubmissions', 'reviews', 'sessions']) {
    assert.deepEqual(where[rel], { none: {} }, rel);
  }
  assert.equal(cutoffFor({ olderThanDays: 7 }, now).toISOString(), '2026-10-10T12:00:00.000Z');
});

test('auth paths are matched the way better-auth routes them (a trailing slash is the same endpoint)', () => {
  assert.equal(canonicalAuthPath('/api/auth/sign-in/email/'), '/api/auth/sign-in/email');
  assert.equal(canonicalAuthPath('/api/auth//sign-up/email'), '/api/auth/sign-up/email');
  assert.equal(canonicalAuthPath('/api/auth/sign-in/email'), '/api/auth/sign-in/email');
  assert.equal(canonicalAuthPath('/'), '/');
});
