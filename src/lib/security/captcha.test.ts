import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

import { decodePayload, escalationFactor, formNeedsCaptcha, issueChallenge, signInNeedsCaptcha, verifyCaptcha } from './captcha';
import { defaultPolicy } from './policy';

// Read when a challenge is signed (captcha.ts derives its HMAC keys from it).
process.env.BETTER_AUTH_SECRET ||= 'unit-test-secret-unit-test-secret-0123456789';

// Small puzzles keep the test fast; the mechanics are the same.
const policy = { ...defaultPolicy(), CAPTCHA_COST: 100, CAPTCHA_MAX_TRIES: 60 };

async function solved(purpose: Parameters<typeof issueChallenge>[0], p = policy) {
  const challenge = await issueChallenge(purpose, p);
  const solution = await solveChallenge({ challenge, deriveKey });
  assert.ok(solution, 'solvable');
  return { challenge, solution: solution!, payload: Buffer.from(JSON.stringify({ challenge, solution })).toString('base64') };
}

/** In-memory single-use store for the replay check. */
function store() {
  const used = new Set<string>();
  return { firstUse: async (nonce: string) => (used.has(nonce) ? false : (used.add(nonce), true)) };
}

test('a solved challenge verifies once, for its purpose only', async () => {
  const deps = store();
  const { payload } = await solved('signup');
  assert.deepEqual(await verifyCaptcha(payload, 'signup', deps), { ok: true });
  const again = await verifyCaptcha(payload, 'signup', deps);
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.code, 'CAPTCHA_REUSED');

  const other = await solved('signup');
  const wrongPurpose = await verifyCaptcha(other.payload, 'password_reset', store());
  assert.equal(!wrongPurpose.ok && wrongPurpose.code, 'CAPTCHA_INVALID');
});

test('missing, garbage, tampered or wrong solutions are refused', async () => {
  assert.equal((await verifyCaptcha(null, 'signup', store())).ok, false);
  const missing = await verifyCaptcha('', 'signup', store());
  assert.equal(!missing.ok && missing.code, 'CAPTCHA_REQUIRED');
  assert.equal(decodePayload('not base64 json'), null);
  const garbage = await verifyCaptcha(Buffer.from('{"x":1}').toString('base64'), 'signup', store());
  assert.equal(!garbage.ok && garbage.code, 'CAPTCHA_INVALID');

  const { challenge, solution } = await solved('signup');
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
  // A made-easier puzzle (cost changed) breaks the signature.
  const easier = { ...challenge, parameters: { ...challenge.parameters, cost: 1 } };
  assert.equal((await verifyCaptcha(enc({ challenge: easier, solution }), 'signup', store())).ok, false);
  // Swapping the purpose inside the challenge breaks the signature too.
  const repurposed = { ...challenge, parameters: { ...challenge.parameters, data: { purpose: 'support' } } };
  assert.equal((await verifyCaptcha(enc({ challenge: repurposed, solution }), 'support', store())).ok, false);
  // A wrong derived key.
  const wrong = { ...solution, derivedKey: '00'.repeat(32) };
  const r = await verifyCaptcha(enc({ challenge, solution: wrong }), 'signup', store());
  assert.equal(!r.ok && r.code, 'CAPTCHA_INVALID');
});

test('an expired challenge is refused as expired', async () => {
  const { challenge, solution } = await solved('signup', { ...policy, CAPTCHA_EXPIRY_MIN: 1 });
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60_000;
  try {
    const r = await verifyCaptcha(Buffer.from(JSON.stringify({ challenge, solution })).toString('base64'), 'signup', store());
    assert.equal(!r.ok && r.code, 'CAPTCHA_EXPIRED');
  } finally {
    Date.now = realNow;
  }
});

test('the challenge carries the admin-set work and expiry', async () => {
  const c = await issueChallenge('signin', { ...policy, CAPTCHA_COST: 1234, CAPTCHA_EXPIRY_MIN: 7 });
  assert.equal(c.parameters.algorithm, 'PBKDF2/SHA-256');
  assert.equal(c.parameters.cost, 1234);
  assert.equal(c.parameters.data?.purpose, 'signin');
  const ttl = c.parameters.expiresAt! - Math.floor(Date.now() / 1000);
  assert.ok(ttl > 6 * 60 && ttl <= 7 * 60, String(ttl));
  assert.ok(c.parameters.keySignature, 'server knows the answer and signs it (verifying is one HMAC)');
});

test('networks that keep asking get bigger puzzles, capped at 8×', () => {
  assert.equal(escalationFactor(5, 10), 1);
  assert.equal(escalationFactor(10, 10), 1);
  assert.equal(escalationFactor(11, 10), 2);
  assert.equal(escalationFactor(21, 10), 4);
  assert.equal(escalationFactor(500, 10), 8);
  assert.equal(escalationFactor(500, 0), 1);
});

test('where the check applies (progressive sign-in, guest forms)', () => {
  const p = defaultPolicy();
  assert.equal(signInNeedsCaptcha(p, { accountIp: 0, account: 0, ip: 0 }), false);
  assert.equal(signInNeedsCaptcha(p, { accountIp: 2, account: 2, ip: 9 }), false);
  assert.equal(signInNeedsCaptcha(p, { accountIp: 3, account: 0, ip: 0 }), true);
  assert.equal(signInNeedsCaptcha(p, { accountIp: 0, account: 3, ip: 0 }), true);
  assert.equal(signInNeedsCaptcha(p, { accountIp: 0, account: 0, ip: 10 }), true);
  assert.equal(signInNeedsCaptcha({ ...p, CAPTCHA_SIGNIN_AFTER_FAILS: 0 }, { accountIp: 0, account: 0, ip: 0 }), true);

  assert.equal(formNeedsCaptcha(p, 'support', false), true);
  assert.equal(formNeedsCaptcha(p, 'sell', false), true);
  assert.equal(formNeedsCaptcha(p, 'support', true), false);
  assert.equal(formNeedsCaptcha(p, 'quote', true), false);
  assert.equal(formNeedsCaptcha({ ...p, CAPTCHA_SIGNED_IN_FORMS: true }, 'quote', true), true);
  assert.equal(formNeedsCaptcha({ ...p, CAPTCHA_ALWAYS: [] }, 'support', false), false);
});
