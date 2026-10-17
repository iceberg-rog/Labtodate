import { createHmac } from 'node:crypto';
import { createChallenge, randomInt, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import type { Challenge, Payload } from 'altcha-lib/types';
import { prisma } from '@/lib/db';
import { getSecurityPolicy, type SecurityPolicy } from './policy';
import { hitBucket, peekBucket } from './throttle';
import { domainBlock } from '@/lib/email-guard/rules';
import { CAPTCHA_HEADER, CAPTCHA_PURPOSES, type AuthCaptchaFlags, type CaptchaPurpose } from './captcha-shared';

export { CAPTCHA_HEADER, CAPTCHA_PURPOSES, type AuthCaptchaFlags, type CaptchaPurpose };

/**
 * Self-hosted bot check: ALTCHA v2 proof of work (PBKDF2-SHA-256), created
 * and verified on this server with HMAC keys derived from BETTER_AUTH_SECRET
 * — no third-party service, nothing to block from an Iran-hosted server, no
 * cookies. The browser has to find the secret counter the challenge was made
 * with (on average half of CAPTCHA_MAX_TRIES × CAPTCHA_COST PBKDF2 rounds);
 * verifying is one HMAC. Each solved challenge is accepted ONCE and only for
 * the purpose it was issued for (sign-up, reset, …). Where it applies is in
 * Settings → Security → Bot check (CAPTCHA_* keys).
 */

const ALGORITHM = 'PBKDF2/SHA-256';

function secrets(): { signature: string; key: string } {
  const base = process.env.CAPTCHA_HMAC_SECRET || process.env.BETTER_AUTH_SECRET || '';
  if (!base) throw new Error('CAPTCHA: no BETTER_AUTH_SECRET (or CAPTCHA_HMAC_SECRET) to sign challenges with');
  const derive = (label: string) => createHmac('sha256', base).update(`lab2date-altcha:${label}`).digest('hex');
  return { signature: derive('challenge-signature'), key: derive('derived-key-signature') };
}

/** Work multiplier for a network that keeps asking for puzzles (1, 2, 4 or 8). Pure. */
export function escalationFactor(servedThisHour: number, escalateAfter: number): number {
  if (escalateAfter <= 0 || servedThisHour <= escalateAfter) return 1;
  const steps = Math.ceil((servedThisHour - escalateAfter) / escalateAfter);
  return Math.min(8, 2 ** steps);
}

/** A new signed challenge for `purpose`. `factor` multiplies the puzzle size. */
export async function issueChallenge(purpose: CaptchaPurpose, policy: SecurityPolicy, factor = 1): Promise<Challenge> {
  const { signature, key } = secrets();
  const max = Math.max(2, Math.min(Math.round(policy.CAPTCHA_MAX_TRIES * factor), 50_000_000));
  const min = Math.max(1, Math.floor(max / 3));
  return createChallenge({
    algorithm: ALGORITHM,
    cost: policy.CAPTCHA_COST,
    counter: randomInt(max, min),
    deriveKey,
    expiresAt: new Date(Date.now() + policy.CAPTCHA_EXPIRY_MIN * 60_000),
    data: { purpose },
    hmacSignatureSecret: signature,
    hmacKeySignatureSecret: key,
  });
}

/** Count one issued puzzle for `ip` and return the work multiplier for it. */
export async function challengeFactorFor(ip: string, policy: SecurityPolicy): Promise<number> {
  const served = await hitBucket(`captcha:served:${ip}`, 3600_000);
  return escalationFactor(served.count, policy.CAPTCHA_ESCALATE_AFTER);
}

export type CaptchaCode = 'CAPTCHA_REQUIRED' | 'CAPTCHA_INVALID' | 'CAPTCHA_EXPIRED' | 'CAPTCHA_REUSED';
export type CaptchaResult = { ok: true } | { ok: false; code: CaptchaCode; message: string };

const MESSAGES: Record<CaptchaCode, string> = {
  CAPTCHA_REQUIRED: 'Please complete the “I’m not a robot” check, then try again.',
  CAPTCHA_INVALID: 'The “I’m not a robot” check didn’t go through. Please run it again.',
  CAPTCHA_EXPIRED: 'The “I’m not a robot” check expired. Please run it again.',
  CAPTCHA_REUSED: 'That “I’m not a robot” check was already used. Please run it again.',
};

export function captchaFailure(code: CaptchaCode): CaptchaResult {
  return { ok: false, code, message: MESSAGES[code] };
}

/** Decode the widget's base64 JSON payload; null when it is not one. Pure. */
export function decodePayload(raw: string): Payload | null {
  if (!raw || raw.length > 8000) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Payload;
    if (!p?.challenge?.parameters || typeof p.challenge.signature !== 'string') return null;
    if (!p.solution || typeof p.solution.derivedKey !== 'string' || typeof p.solution.counter !== 'number') return null;
    return p;
  } catch {
    return null;
  }
}

/** First redemption of a challenge nonce? (atomic; the row lives until the challenge expires). */
async function firstUse(nonce: string, expiresAt: number | undefined): Promise<boolean> {
  const ttl = Math.max(60_000, (expiresAt ? expiresAt * 1000 : Date.now() + 3600_000) - Date.now());
  const hit = await hitBucket(`captcha:used:${nonce.slice(0, 64)}`, ttl);
  return hit.count === 1;
}

/**
 * Verify a solved challenge for `purpose`. Signature, expiry, purpose, the
 * solution and single use are all checked here, on this server.
 */
export async function verifyCaptcha(
  raw: string | null | undefined,
  purpose: CaptchaPurpose,
  deps: { firstUse?: (nonce: string, expiresAt: number | undefined) => Promise<boolean> } = {},
): Promise<CaptchaResult> {
  if (!raw) return captchaFailure('CAPTCHA_REQUIRED');
  const payload = decodePayload(raw);
  if (!payload) return captchaFailure('CAPTCHA_INVALID');
  const params = payload.challenge.parameters;
  if (params.algorithm !== ALGORITHM || params.data?.purpose !== purpose) return captchaFailure('CAPTCHA_INVALID');
  const { signature, key } = secrets();
  let result;
  try {
    result = await verifySolution({
      challenge: payload.challenge as Challenge,
      solution: payload.solution,
      deriveKey,
      hmacSignatureSecret: signature,
      hmacKeySignatureSecret: key,
    });
  } catch {
    return captchaFailure('CAPTCHA_INVALID');
  }
  if (result.expired) return captchaFailure('CAPTCHA_EXPIRED');
  if (!result.verified) return captchaFailure('CAPTCHA_INVALID');
  if (!(await (deps.firstUse ?? firstUse)(params.nonce, params.expiresAt))) return captchaFailure('CAPTCHA_REUSED');
  return { ok: true };
}

// ── Where it applies ─────────────────────────────────────────────────────────

/** Is the check switched on for this always-on purpose (sign-up, reset, guest forms …)? */
export function captchaAlwaysOn(policy: SecurityPolicy, purpose: CaptchaPurpose): boolean {
  return policy.CAPTCHA_ALWAYS.includes(purpose);
}

/** Which auth forms show the check up front (server pages pass this to the client forms). */
export async function authCaptchaFlags(): Promise<AuthCaptchaFlags> {
  const policy = await getSecurityPolicy();
  return {
    signup: captchaAlwaysOn(policy, 'signup'),
    password_reset: captchaAlwaysOn(policy, 'password_reset'),
    magic_link: captchaAlwaysOn(policy, 'magic_link'),
    verify_email: captchaAlwaysOn(policy, 'verify_email'),
    signin: policy.CAPTCHA_SIGNIN_AFTER_FAILS === 0,
  };
}

/**
 * Does a form submission need the check? Guests: when the purpose is on.
 * Signed-in customers: only with CAPTCHA_SIGNED_IN_FORMS (the quote form is
 * signed-in only, so that switch alone decides it).
 */
export function formNeedsCaptcha(policy: SecurityPolicy, purpose: 'support' | 'sell' | 'quote', signedIn: boolean): boolean {
  if (signedIn) return policy.CAPTCHA_SIGNED_IN_FORMS;
  return purpose === 'quote' ? true : captchaAlwaysOn(policy, purpose);
}

/**
 * Thrown by a public form action with a readable message: the bot check is
 * missing or failed (`captcha`: the form shows the check), or the address is
 * on a blocked / throw-away domain.
 */
export class PublicFormError extends Error {
  constructor(
    message: string,
    readonly captcha: boolean,
  ) {
    super(message);
    this.name = 'PublicFormError';
  }
}

/**
 * Bot check + blocked-domain check for the support / sell / quote forms.
 * Throws PublicFormError when the check is missing / failed or the address
 * is on a blocked or throw-away domain.
 */
export async function guardPublicForm(
  purpose: 'support' | 'sell' | 'quote',
  input: { captcha?: unknown; email?: string | null },
  signedIn: boolean,
): Promise<void> {
  const policy = await getSecurityPolicy();
  if (formNeedsCaptcha(policy, purpose, signedIn)) {
    const r = await verifyCaptcha(typeof input.captcha === 'string' ? input.captcha : null, purpose);
    if (!r.ok) throw new PublicFormError(r.message, true);
  }
  const block = input.email ? domainBlock(input.email, policy) : null;
  if (block) throw new PublicFormError(block.message, false);
}

/** Whether a page's form shows the check (server pages pass it to the client form). */
export async function formCaptchaFlag(purpose: 'support' | 'sell' | 'quote', signedIn: boolean): Promise<boolean> {
  return formNeedsCaptcha(await getSecurityPolicy(), purpose, signedIn);
}

/** Wrong-password counts that decide whether password sign-in needs the check. Pure. */
export function signInNeedsCaptcha(
  policy: Pick<SecurityPolicy, 'CAPTCHA_SIGNIN_AFTER_FAILS' | 'CAPTCHA_SIGNIN_AFTER_IP_FAILS'>,
  counts: { accountIp: number; account: number; ip: number },
): boolean {
  if (policy.CAPTCHA_SIGNIN_AFTER_FAILS === 0) return true;
  return (
    counts.accountIp >= policy.CAPTCHA_SIGNIN_AFTER_FAILS ||
    counts.account >= policy.CAPTCHA_SIGNIN_AFTER_FAILS ||
    counts.ip >= policy.CAPTCHA_SIGNIN_AFTER_IP_FAILS
  );
}

// ── One free code e-mail after a checked sign-up ─────────────────────────────

const passKey = (email: string) => `captcha:pass:${email.trim().toLowerCase()}`;

/**
 * A sign-up that passed the check may send its first verification code
 * without a second puzzle (the sign-up form sends it right after). One use,
 * 10 minutes; "Resend code" needs a new check.
 */
export async function grantCodePass(email: string): Promise<void> {
  await hitBucket(passKey(email), 10 * 60_000);
}

/** Use the pass (atomically: two parallel requests can't both use it). */
export async function consumeCodePass(email: string): Promise<boolean> {
  const key = passKey(email);
  if ((await peekBucket(key)).count < 1) return false;
  try {
    const r = await prisma.rateLimitBucket.deleteMany({ where: { key, resetAt: { gt: new Date() } } });
    return r.count === 1;
  } catch {
    return false;
  }
}
