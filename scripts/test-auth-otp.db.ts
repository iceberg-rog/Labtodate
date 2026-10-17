/**
 * Regression tests (security finding, 2026-10-03): the e-mail verification code
 * must never mint a session — not for a verified admin with two-factor sign-in
 * (the original bypass: no password, no authenticator code), not for a verified
 * buyer, not for a brand-new account. The code only confirms the address; a
 * session always needs the password (+ the authenticator code with 2FA on).
 * Also: no account enumeration through the OTP endpoints.
 *
 * Runs better-auth's real handler against a LOCAL TEST database:
 *   npm run test:auth
 */
import { assertTestDatabase } from './db-test-guard';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { prisma } from '../src/lib/db';
import { auth, VERIFY_ONLY_PATHS } from '../src/lib/auth';

assertTestDatabase();

const ORIGIN = (process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
const RUN = randomBytes(4).toString('hex');
const PASSWORD = `T-${randomBytes(9).toString('base64url')}!`;
const created: string[] = [];

async function call(path: string, body: Record<string, unknown>) {
  const res = await auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Real-IP': '127.0.0.1' },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), setCookie: res.headers.get('set-cookie') ?? '' };
}
const sessionCookie = (sc: string) => /better-auth\.session_token=[^;]+/.test(sc) && !/better-auth\.session_token=;/.test(sc);

let seq = 0;
async function makeUser(kind: 'admin2fa' | 'buyer' | 'unverified') {
  const email = `auth-${kind}-${RUN}-${++seq}@s2e-auth-test.nl`;
  const u = await prisma.user.create({
    data: {
      id: randomBytes(16).toString('hex'),
      email,
      name: `Auth ${kind}`,
      emailVerified: kind !== 'unverified',
      role: kind === 'admin2fa' ? 'ADMIN' : 'BUYER',
      twoFactorEnabled: kind === 'admin2fa',
    },
  });
  await prisma.account.create({ data: { id: randomBytes(16).toString('hex'), accountId: u.id, providerId: 'credential', userId: u.id, password: await hashPassword(PASSWORD) } });
  created.push(u.id);
  return u;
}

/** A code the attacker somehow knows (guessed / leaked), stored the way the app stores codes (hashed). */
async function plantCode(email: string, otp: string) {
  const identifier = `email-verification-otp-${email}`;
  await prisma.verification.deleteMany({ where: { identifier } });
  const hash = createHash('sha256').update(otp).digest('base64url');
  await prisma.verification.create({ data: { id: randomBytes(12).toString('hex'), identifier, value: `${hash}:0`, expiresAt: new Date(Date.now() + 600_000) } });
}

after(async () => {
  // Test users only (no orders / documents): safe to remove.
  await prisma.session.deleteMany({ where: { userId: { in: created } } });
  await prisma.account.deleteMany({ where: { userId: { in: created } } });
  await prisma.verification.deleteMany({ where: { identifier: { contains: RUN } } });
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  await prisma.$disconnect();
});

test('verified ADMIN with 2FA: a correct e-mail code gives no session (no password / 2FA bypass)', async () => {
  const u = await makeUser('admin2fa');
  await plantCode(u.email, '13579');
  const r = await call('/email-otp/verify-email', { email: u.email, otp: '13579' });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json?.code, 'INVALID_OTP');
  assert.equal(sessionCookie(r.setCookie), false);
  assert.equal(await prisma.session.count({ where: { userId: u.id } }), 0);
  // …and the code is gone (cannot be retried).
  assert.equal(await prisma.verification.count({ where: { identifier: `email-verification-otp-${u.email}` } }), 0);
});

test('verified buyer: a correct e-mail code gives no session either', async () => {
  const u = await makeUser('buyer');
  await plantCode(u.email, '24680');
  const r = await call('/email-otp/verify-email', { email: u.email, otp: '24680' });
  assert.equal(r.status, 400, r.text);
  assert.equal(sessionCookie(r.setCookie), false);
  assert.equal(await prisma.session.count({ where: { userId: u.id } }), 0);
});

test('new (unverified) account: the code confirms the address but does NOT sign in; the password does', async () => {
  const u = await makeUser('unverified');
  await plantCode(u.email, '11223');
  const r = await call('/email-otp/verify-email', { email: u.email, otp: '11223', password: PASSWORD });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json?.token ?? null, null, 'no session token in the answer');
  assert.equal(sessionCookie(r.setCookie), false, 'no session cookie');
  assert.equal(await prisma.session.count({ where: { userId: u.id } }), 0);
  const after1 = await prisma.user.findUnique({ where: { id: u.id }, select: { emailVerified: true } });
  assert.equal(after1?.emailVerified, true);
  const si = await call('/sign-in/email', { email: u.email, password: PASSWORD });
  assert.equal(si.status, 200, si.text);
  assert.equal(sessionCookie(si.setCookie), true);
});

test('a session is refused on every verify-only path, whatever the configuration', async () => {
  const before = auth.options.databaseHooks?.session?.create?.before;
  assert.ok(before, 'session-create hook present');
  const u = await makeUser('buyer');
  for (const path of VERIFY_ONLY_PATHS) {
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (before as any)({ userId: u.id, token: 'x', expiresAt: new Date() }, { path }),
      /confirmed/i,
      path,
    );
  }
  assert.equal(auth.options.emailVerification?.autoSignInAfterVerification, false);
});

test('no enumeration: check-verification-otp is closed; verify-email answers the same for unknown and known', async () => {
  const known = await makeUser('buyer');
  const a = await call('/email-otp/check-verification-otp', { email: `nobody-${RUN}@s2e-auth-test.nl`, type: 'email-verification', otp: '00000' });
  const b = await call('/email-otp/check-verification-otp', { email: known.email, type: 'email-verification', otp: '00000' });
  assert.equal(a.status, b.status);
  assert.equal(a.text, b.text);
  assert.notEqual(a.json?.code, 'USER_NOT_FOUND');
  const c = await call('/email-otp/verify-email', { email: `nobody-${RUN}@s2e-auth-test.nl`, otp: '00000' });
  const d = await call('/email-otp/verify-email', { email: known.email, otp: '00000' });
  assert.equal(c.status, d.status);
  assert.equal(c.json?.code, d.json?.code);
});
