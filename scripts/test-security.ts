/**
 * Unit tests for the security / platform rules (pure logic, no database).
 *   npx tsx --test scripts/test-security.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canGrantCapability,
  capsAllow,
  capsChangeProblems,
  isKnownCapability,
  CAPABILITY_PRESETS,
  type CapsChangeInput,
} from '../src/lib/capabilities';
import { adminEmailAllowed, defaultPolicy, planPolicySave, policyFromRows } from '../src/lib/security/policy';
import { stripInternal } from '../src/lib/security/gdpr-export';
import * as marketing from '../src/lib/security/marketing';

// Read at call time by the token functions.
process.env.BETTER_AUTH_SECRET ||= 'unit-test-secret-unit-test-secret-1234';

const base: CapsChangeInput = {
  actorId: 'actor',
  actorCaps: ['users:view', 'users:manage', 'orders:view'],
  targetId: 'target',
  targetRole: 'ADMIN',
  targetCaps: ['orders:view'],
  nextCaps: ['orders:view'],
  otherActiveSuperAdmins: 1,
};

test('capsAllow: wildcard and section wildcard', () => {
  assert.equal(capsAllow(['*'], 'orders:delete'), true);
  assert.equal(capsAllow(['orders:*'], 'orders:refund'), true);
  assert.equal(capsAllow(['orders:view'], 'orders:refund'), false);
  assert.equal(capsAllow([], 'orders:view'), false);
});

test('only super-admins grant *, users:manage, settings:write, security:manage, gdpr:manage', () => {
  for (const c of ['*', 'users:manage', 'settings:write', 'security:manage', 'gdpr:manage', 'users:*', 'settings:*']) {
    assert.equal(canGrantCapability(['users:manage', 'users:view', 'settings:write'], c), false, c);
    assert.equal(canGrantCapability(['*'], c), true, c);
  }
});

test('you can only grant what you hold; a section wildcard needs the same wildcard', () => {
  assert.equal(canGrantCapability(['orders:view', 'users:manage'], 'orders:view'), true);
  assert.equal(canGrantCapability(['orders:view', 'users:manage'], 'orders:refund'), false);
  assert.equal(canGrantCapability(['orders:*', 'users:manage'], 'orders:refund'), true);
  assert.equal(canGrantCapability(['orders:view', 'users:manage'], 'orders:*'), false);
  assert.equal(canGrantCapability(['orders:*', 'users:manage'], 'orders:*'), true);
});

test('self-change refused', () => {
  const p = capsChangeProblems({ ...base, targetId: 'actor', nextCaps: ['*'] });
  assert.match(p.join(' '), /own access/);
});

test('scoped admin cannot grant * to anyone', () => {
  const p = capsChangeProblems({ ...base, nextCaps: ['*'] });
  assert.match(p.join(' '), /Only a super-admin can grant “\*”/);
});

test('scoped admin cannot grant a cap they do not hold', () => {
  const p = capsChangeProblems({ ...base, nextCaps: ['tickets:delete'] });
  assert.match(p.join(' '), /hold yourself/);
});

test('scoped admin cannot touch someone with more access (e.g. a super-admin)', () => {
  const p = capsChangeProblems({ ...base, targetCaps: ['*'], nextCaps: [] });
  assert.match(p.join(' '), /only a super-admin can change their access/);
  assert.equal(p.length, 1, 'one clear reason, not a duplicate');
});

test('allowed: scoped admin edits a subordinate within their own caps', () => {
  assert.deepEqual(capsChangeProblems({ ...base, nextCaps: ['orders:view', 'users:view'] }), []);
});

test('last active super-admin can never lose *', () => {
  const p = capsChangeProblems({
    ...base,
    actorCaps: ['*'],
    targetCaps: ['*'],
    nextCaps: ['orders:view'],
    otherActiveSuperAdmins: 0,
  });
  assert.match(p.join(' '), /last active super-admin/);
  assert.deepEqual(capsChangeProblems({ ...base, actorCaps: ['*'], targetCaps: ['*'], nextCaps: [], otherActiveSuperAdmins: 1 }), []);
});

test('unknown capability strings are refused', () => {
  assert.equal(isKnownCapability('orders:view'), true);
  assert.equal(isKnownCapability('orders:*'), true);
  assert.equal(isKnownCapability('nuke:*'), false);
  assert.match(capsChangeProblems({ ...base, actorCaps: ['*'], nextCaps: ['root'] }).join(' '), /Unknown permission/);
});

test('SUPPORT preset has no irreversible delete; every preset only uses known caps', () => {
  assert.equal(CAPABILITY_PRESETS.SUPPORT.caps.includes('tickets:delete'), false);
  for (const [k, p] of Object.entries(CAPABILITY_PRESETS)) {
    for (const c of p.caps) assert.equal(isKnownCapability(c), true, `${k}: ${c}`);
  }
});

test('policy: defaults, stored values, invalid rows fall back', () => {
  const d = defaultPolicy();
  assert.deepEqual(d.TWO_FACTOR_REQUIRED_ROLES, ['ADMIN']);
  assert.equal(d.ADMIN_MAGIC_LINK_ALLOWED, false);
  assert.equal(d.LOGIN_MAX_FAILS_PER_ACCOUNT_IP, 8);
  assert.equal(d.IP_SIGNIN_LIMIT_PER_15MIN, 100);
  const p = policyFromRows([
    { key: 'LOGIN_MAX_FAILS_PER_ACCOUNT_IP', value: '5' },
    { key: 'ADMIN_IDLE_TIMEOUT_MIN', value: 'abc' }, // invalid → default
    { key: 'TWO_FACTOR_REQUIRED_ROLES', value: 'ADMIN,SELLER' },
    { key: 'TWO_FACTOR_REQUIRED_ROLES_X', value: 'ignored' },
  ]);
  assert.equal(p.LOGIN_MAX_FAILS_PER_ACCOUNT_IP, 5);
  assert.equal(p.ADMIN_IDLE_TIMEOUT_MIN, 30);
  assert.deepEqual(p.TWO_FACTOR_REQUIRED_ROLES, ['ADMIN', 'SELLER']);
});

function formFrom(policy: ReturnType<typeof defaultPolicy>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(policy)) {
    if (Array.isArray(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v ? 'on' : '';
    else out[k] = String(v);
  }
  return out;
}

test('policy save: diff, default rows removed, validation and cross-field rules', () => {
  const cur = defaultPolicy();
  const noChange = planPolicySave(cur, formFrom(cur));
  assert.deepEqual(noChange, { problems: [], changes: [], writes: [] });

  const form = formFrom(cur);
  form.LOGIN_MAX_FAILS_PER_ACCOUNT_IP = '10';
  form.ADMIN_MAGIC_LINK_ALLOWED = 'on';
  const plan = planPolicySave(cur, form);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.writes.map((w) => w.key).sort(), ['ADMIN_MAGIC_LINK_ALLOWED', 'LOGIN_MAX_FAILS_PER_ACCOUNT_IP']);
  assert.ok(plan.changes.find((c) => c.key === 'LOGIN_MAX_FAILS_PER_ACCOUNT_IP' && c.from === '8' && c.to === '10'));

  // Back to the default value → the row is deleted (value null).
  const changed = { ...cur, LOGIN_MAX_FAILS_PER_ACCOUNT_IP: 10 };
  const back = planPolicySave(changed, formFrom(cur));
  assert.deepEqual(back.writes, [{ key: 'LOGIN_MAX_FAILS_PER_ACCOUNT_IP', value: null }]);

  const bad = formFrom(cur);
  bad.STEP_UP_MAX_AGE_MIN = '0';
  bad.LOCKOUT_MAX_MINUTES = '5'; // shorter than the base (15)
  bad.BACKUP_TARGET = 'ftp://example.com/x';
  bad.TWO_FACTOR_REQUIRED_ROLES = ['ADMIN', 'ROOT'];
  const r = planPolicySave(cur, bad);
  assert.equal(r.writes.length, 0, 'nothing written when anything is invalid');
  assert.ok(r.problems.some((x) => /whole number from 1/.test(x)));
  assert.ok(r.problems.some((x) => /longest pause/.test(x)));
  assert.ok(r.problems.some((x) => /rclone/.test(x)));
  assert.ok(r.problems.some((x) => /unknown option ROOT/.test(x)));

  const ok = formFrom(cur);
  ok.BACKUP_TARGET = 'rclone:b2:lab2date-backups/prod';
  assert.deepEqual(planPolicySave(cur, ok).problems, []);
  ok.BACKUP_TARGET = 'scp:backup@nas.example.nl:/srv/backups/lab2date';
  assert.deepEqual(planPolicySave(cur, ok).problems, []);
});

test('admin e-mail domain allow-list', () => {
  assert.equal(adminEmailAllowed({ ADMIN_EMAIL_DOMAINS: '' }, 'x@gmail.com'), true);
  assert.equal(adminEmailAllowed({ ADMIN_EMAIL_DOMAINS: 'labtodate.com, samparsbenelux.com' }, 'a@labtodate.com'), true);
  assert.equal(adminEmailAllowed({ ADMIN_EMAIL_DOMAINS: 'labtodate.com' }, 'a@evil-labtodate.com'), false);
});

test('unsubscribe tokens: bound to one address, tamper-proof', () => {
  const t = marketing.unsubscribeToken('Buyer@Uni.nl');
  assert.deepEqual(marketing.verifyUnsubscribeToken(t), { email: 'buyer@uni.nl', scope: 'MARKETING' });
  const [e, s, mac] = t.split('.');
  const other = Buffer.from('victim@uni.nl').toString('base64url');
  assert.equal(marketing.verifyUnsubscribeToken(`${other}.${s}.${mac}`), null, 'another address with the same MAC');
  assert.equal(marketing.verifyUnsubscribeToken(`${e}.${s}.${mac.slice(0, -1)}A`), null, 'changed MAC');
  assert.equal(marketing.verifyUnsubscribeToken('garbage'), null);
  const h = marketing.listUnsubscribeHeaders('buyer@uni.nl');
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(h['List-Unsubscribe'], /^<https?:\/\/.*\/api\/email\/unsubscribe\?t=.+>$/);
});

test('legal identity reports what is missing, never invents it', () => {
  const keep = { ...process.env };
  process.env.COMPANY_LEGAL_NAME = 'Sampars Benelux B.V.';
  process.env.COMPANY_ADDRESS = 'Hoofdstraat 1\n2711 AA Zoetermeer';
  process.env.COMPANY_KVK = '';
  process.env.COMPANY_VAT = 'NL001234567B01';
  const id = marketing.legalIdentity();
  assert.deepEqual(id.missing, ['KvK number']);
  assert.match(id.lines[0], /Sampars Benelux B\.V\. · Hoofdstraat 1, 2711 AA Zoetermeer/);
  Object.assign(process.env, keep);
});

test('GDPR export strips staff-internal fields', () => {
  const row = {
    id: 'o1',
    orderNumber: 'L2D-1',
    adminNotes: 'called buyer',
    paidByAdminId: 'a1',
    paymentVerifiedById: 'a2',
    paymentNote: 'internal transfer note',
    shippingAddress: { line1: 'x' },
    buyerIp: '1.2.3.4',
    assignedToId: 'seller-1',
    accessToken: 'secret',
    accessTokenExpiresAt: null,
    priority: 'VIP',
    tags: ['difficult'],
  };
  const out = stripInternal(row, 'order');
  assert.deepEqual(Object.keys(out).sort(), ['buyerIp', 'id', 'orderNumber', 'shippingAddress']);
});
