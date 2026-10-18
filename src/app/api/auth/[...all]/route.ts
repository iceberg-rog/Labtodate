import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';
import { prisma } from '@/lib/db';
import { allowHit } from '@/lib/security/throttle';
import { clientIpFrom } from '@/lib/ratelimit';
import { getSecurityPolicy } from '@/lib/security/policy';
import {
  checkSignIn,
  recordSignInFailure,
  recordSignInSuccess,
  signInBlockMessage,
  activeLock,
  recordCodeFailure,
  clearBuckets,
  minutesUntil,
  type SignInBlock,
} from '@/lib/security/throttle';
import { auditAs } from '@/lib/observability';
import { emailTransportStatus, mailRefusals, sendEmail, type EmailBlockedError } from '@/lib/email';
import { ensureSettingsLoaded } from '@/lib/settings';
import { escapeHtml } from '@/lib/email-html';
import { brandedMail } from '@/lib/quotes/mail';
import { legalIdentity } from '@/lib/brand/identity';
import { alertSuperAdmins } from '@/lib/security/alerts';
import { noteSuccessfulSignIn } from '@/lib/security/signin-events';
import { CAPTCHA_HEADER, signInNeedsCaptcha, verifyCaptcha } from '@/lib/security/captcha';
import { peekBucket, signInKeys } from '@/lib/security/throttle';
import type { SecurityPolicy } from '@/lib/security/policy';
import { canonicalAuthPath } from '@/lib/security/auth-paths';

const handlers = toNextJsHandler(auth.handler);

export const GET = handlers.GET;

// BUG-025 / invariant A14: per-IP limits on the credential-sensitive auth POST
// endpoints (email enumeration, sign-up spam, email bombing via
// magic-link/forgot-password). Counters are persistent (Postgres). Password
// sign-in has its own per-account + per-network policy below (A33). The first
// matching rule wins, so specific paths come first. The e-mail-sending ones
// read their numbers from Settings → Security (MAIL_IP_*).
type Limit = { match: RegExp; bucket: string; max: (p: SecurityPolicy) => number; windowMs: number };
const LIMITS: Limit[] = [
  { match: /\/magic-link\b/, bucket: 'auth:magic', max: (p) => p.MAIL_IP_REQUESTS_PER_15MIN, windowMs: 15 * 60_000 },
  { match: /\/sign-up\b/, bucket: 'auth:sign-up', max: (p) => p.MAIL_IP_SIGNUPS_PER_HOUR, windowMs: 60 * 60_000 },
  // better-auth 1.6 calls the forgot-password endpoint /request-password-reset.
  { match: /\/(request-password-reset|forget-password|forgot-password)\b/, bucket: 'auth:forgot', max: (p) => p.MAIL_IP_REQUESTS_PER_15MIN, windowMs: 15 * 60_000 },
  { match: /\/reset-password\b/, bucket: 'auth:reset', max: () => 5, windowMs: 15 * 60_000 },
  { match: /\/send-verification-email\b/, bucket: 'auth:verify-email', max: (p) => p.MAIL_IP_REQUESTS_PER_15MIN, windowMs: 15 * 60_000 },
  // Email-OTP send is a cost + email-bombing lever (each hit emails an
  // arbitrary address). Verify is capped too so a single IP can't grind codes.
  { match: /\/email-otp\/send/, bucket: 'auth:otp-send', max: (p) => p.MAIL_IP_REQUESTS_PER_15MIN, windowMs: 15 * 60_000 },
  { match: /\/email-otp\/verify/, bucket: 'auth:otp-verify', max: () => 20, windowMs: 15 * 60_000 },
  // Second-factor codes: per IP here, per pending sign-in (account) below.
  { match: /\/two-factor\/verify-/, bucket: 'auth:2fa-verify', max: () => 30, windowMs: 15 * 60_000 },
];

async function ipLimit(pathname: string, ip: string): Promise<Response | null> {
  const rule = LIMITS.find((r) => r.match.test(pathname));
  if (!rule) return null;
  const hit = await allowHit(`rl:${rule.bucket}:${ip}`, rule.max(await getSecurityPolicy()), rule.windowMs);
  // Better-Auth clients surface `message` from JSON error bodies.
  return hit.allowed ? null : tooMany('Too many attempts. Please wait a few minutes and try again.', 'TOO_MANY_ATTEMPTS', hit.resetAt);
}

function tooMany(message: string, code = 'TOO_MANY_ATTEMPTS', retryAt?: Date) {
  return Response.json(
    { message, code },
    {
      status: 429,
      headers: retryAt ? { 'Retry-After': String(Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000))) } : undefined,
    },
  );
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.clone().json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Mail the account owner that password sign-in was paused (and say how to get in). */
async function notifyLockout(email: string, block: SignInBlock, ip: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true, name: true } });
  await auditAs({ email, id: user?.id ?? null, ip }, 'auth.lockout', email, `${block.scope} until ${block.until.toISOString()}`);
  if (!user) return; // unknown address: nothing to tell anyone
  const policy = await getSecurityPolicy();
  const site = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
  const mins = minutesUntil(block.until);
  if (policy.LOCKOUT_EMAIL_ENABLED) {
    const reset = `${site}/auth/forgot-password`;
    const mail = await brandedMail((brand) => ({
      subject: `Sign-in to your ${brand} account was paused`,
      heading: 'Too many wrong passwords',
      body: [
        `Hi ${escapeHtml(user.name || 'there')},`,
        `Someone entered a wrong password for your account several times${block.scope === 'account-ip' ? ` from the network ${escapeHtml(ip)}` : ' from several networks'}. To protect the account, password sign-in is paused for ${mins} minutes${block.scope === 'account-ip' ? ' from that network' : ''}.`,
        'Was it you? Reset your password to get in right away.',
      ],
      cta: { href: reset, label: 'Reset my password' },
      footer: ['Wasn’t you? Your password was not accepted. Resetting it to a new, strong one is still a good idea.'],
      text: `Too many wrong passwords were entered for your ${brand} account. Password sign-in is paused for ${mins} minutes. Reset your password to get in right away: ${reset}`,
    }));
    await sendEmail({
      to: email,
      // Caused by whoever typed the wrong passwords, not by the owner.
      trigger: 'auth.notice',
      // It tells the owner to ask for a reset link right away: it must not
      // start the per-address wait that would silently hold that link back
      // (the daily and hourly limits still count it).
      skipCooldown: true,
      ...mail,
    }).catch(() => {});
  }
  if (user.role === 'ADMIN') {
    await alertSuperAdmins('Sign-in paused for an admin account', [
      `${email}: too many wrong passwords (${block.scope === 'account-ip' ? `from ${ip}` : 'from several networks'}).`,
      `Password sign-in is paused until ${block.until.toISOString()}.`,
    ]);
  }
}

/** Wrong passwords so far that decide the sign-in bot check (counted by recordSignInFailure). */
async function signInFailCounts(email: string, ip: string) {
  const [accountIp, account, perIp] = await Promise.all([
    email ? peekBucket(signInKeys.accountIp(email, ip)) : Promise.resolve({ count: 0 }),
    email ? peekBucket(signInKeys.account(email)) : Promise.resolve({ count: 0 }),
    peekBucket(signInKeys.ip(ip)),
  ]);
  return { accountIp: accountIp.count, account: account.count, ip: perIp.count };
}

/** The same JSON error with `captchaRequired: true`, so the form shows the check before the next try. */
async function withCaptchaFlag(res: Response): Promise<Response> {
  const body = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return res;
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify({ ...body, captchaRequired: true }), { status: res.status, statusText: res.statusText, headers });
}

/**
 * Password sign-in with the brute-force policy from Settings → Security (A33)
 * and the progressive bot check: after CAPTCHA_SIGNIN_AFTER_FAILS wrong
 * passwords for the account (or CAPTCHA_SIGNIN_AFTER_IP_FAILS from the
 * network) every further try needs a solved check.
 */
async function passwordSignIn(req: Request): Promise<Response> {
  const ip = clientIpFrom(req.headers);
  const body = await readJson(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
  const policy = await getSecurityPolicy();
  const block = await checkSignIn(policy, email, ip);
  if (block) {
    await auditAs({ email, ip }, 'auth.signin.blocked', email || undefined, block.scope);
    return tooMany(signInBlockMessage(block), block.scope === 'ip' ? 'TOO_MANY_ATTEMPTS' : 'ACCOUNT_LOCKED', block.until);
  }
  if (signInNeedsCaptcha(policy, await signInFailCounts(email, ip))) {
    const check = await verifyCaptcha(req.headers.get(CAPTCHA_HEADER), 'signin');
    if (!check.ok) {
      if (check.code !== 'CAPTCHA_REQUIRED') await auditAs({ email, ip }, 'auth.captcha.failed', email || undefined, `/sign-in/email: ${check.code}`);
      return Response.json({ code: check.code, message: check.message, captchaRequired: true }, { status: 403 });
    }
  }
  const res = await handlers.POST(req);
  if (res.status === 401) {
    await auditAs({ email, ip }, 'auth.signin.failed', email || undefined, 'wrong email or password');
    const locked = await recordSignInFailure(policy, email, ip);
    if (locked) await notifyLockout(email, locked, ip);
    if (signInNeedsCaptcha(policy, await signInFailCounts(email, ip))) return withCaptchaFlag(res);
  } else if (res.status === 200 || (res.status === 403 && email)) {
    // 200: password right (signed in, or the second-factor step comes next).
    // 403: right password but e-mail not verified / suspended — not a guess.
    if (res.status === 200) {
      await recordSignInSuccess(email, ip);
      // Signed in now (no second factor pending): audit + new-device e-mail.
      const data = (await res.clone().json().catch(() => null)) as { twoFactorRedirect?: boolean; user?: { id: string; email: string } } | null;
      if (data?.user && !data.twoFactorRedirect) {
        await noteSuccessfulSignIn(data.user, ip, req.headers.get('user-agent'), 'password');
      }
    }
  }
  return res;
}

/** The pending sign-in a second-factor code belongs to (better-auth's two_factor cookie). */
async function pendingTwoFactorUser(req: Request): Promise<string | null> {
  const cookie = req.headers.get('cookie') ?? '';
  const m = /(?:^|;\s*)(?:__Secure-)?better-auth\.two_factor=([^;]+)/.exec(cookie);
  if (!m) return null;
  const identifier = decodeURIComponent(m[1]).split('.')[0];
  if (!identifier) return null;
  const row = await prisma.verification.findFirst({ where: { identifier }, select: { value: true } }).catch(() => null);
  return row?.value ?? null;
}

/** Wrong second-factor codes at sign-in: 5 per 15 minutes pause that account's code step. */
async function twoFactorVerify(req: Request): Promise<Response> {
  const ip = clientIpFrom(req.headers);
  const userId = await pendingTwoFactorUser(req);
  const key = userId ? `2fa:acct:${userId}` : null;
  if (key) {
    const lock = await activeLock(key);
    if (lock) {
      return tooMany(`Too many wrong codes. Sign in again in ${minutesUntil(lock)} minutes.`, 'TWO_FACTOR_LOCKED', lock);
    }
  }
  const res = await handlers.POST(req);
  if (!key) return res;
  const user = await prisma.user.findUnique({ where: { id: userId! }, select: { email: true, role: true } });
  if (res.status === 401 || res.status === 400) {
    await auditAs({ email: user?.email, id: userId, ip }, 'auth.2fa.failed', userId!, 'wrong code at sign-in');
    const locked = await recordCodeFailure(key);
    if (locked && user) {
      await auditAs({ email: user.email, id: userId, ip }, 'auth.2fa.locked', userId!, `until ${locked.toISOString()}`);
      if (user.role === 'ADMIN') {
        await alertSuperAdmins('Repeated wrong authenticator codes', [
          `Someone with the correct password for ${user.email} entered 5 wrong authenticator codes from ${ip}.`,
          'The password may be compromised — consider resetting it and suspending the account until checked.',
        ]);
      }
    }
  } else if (res.status === 200) {
    await clearBuckets([key]);
    if (user) await noteSuccessfulSignIn({ id: userId!, email: user.email }, ip, req.headers.get('user-agent'), 'password + second factor');
  }
  return res;
}

// Endpoints whose whole point is an e-mail. better-auth runs the mail senders
// "in the background" and swallows their errors, so without this the person
// is told "check your e-mail" when nothing was sent (A32).
const MAIL_PATHS = /\/(sign-up\/email|email-otp\/send-verification-otp|request-password-reset|sign-in\/magic-link|send-verification-email)$/;

function supportLine(): string {
  // Only a real address (a placeholder such as support@….local reads as unset).
  const support = legalIdentity().supportEmail;
  return support ? ` Please contact ${support}.` : '';
}

/** Refuse up front when no mail transport is configured; report a failed send after. */
async function withMailCheck(req: Request, pathname: string, next: () => Promise<Response>): Promise<Response> {
  await ensureSettingsLoaded();
  const transport = emailTransportStatus();
  const body = await readJson(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
  if (!transport.configured) {
    await prisma.emailLog
      .create({
        data: {
          toAddr: email || '(unknown)',
          subject: `(${pathname.split('/api/auth')[1] ?? pathname}) not sent`,
          status: 'not_configured',
          error: `Email is not configured: ${transport.problem ?? 'no mail transport'}`.slice(0, 500),
        },
      })
      .catch(() => {});
    const what = /sign-up/.test(pathname)
      ? 'Sign-up is unavailable right now because we can’t send the confirmation e-mail.'
      : 'We can’t send e-mail right now, so no code or link could be sent.';
    return Response.json({ code: 'EMAIL_NOT_CONFIGURED', message: `${what}${supportLine()}` }, { status: 503 });
  }
  const since = new Date(Date.now() - 1000);
  const refusals: EmailBlockedError[] = [];
  const res = await mailRefusals.run(refusals, next);
  if (res.status !== 200 || !email || /sign-up/.test(pathname)) return res;
  // Held back by the e-mail guards (src/lib/email-guard). A refusal about this
  // one address (its wait, daily cap, suppression) answers like a sent e-mail:
  // these endpoints only mail existing accounts for some addresses, so "please
  // wait" would tell anyone which addresses are registered. Domain- and
  // site-wide refusals reveal nothing and are explained.
  const shown = refusals.find((r) => r.scope !== 'address');
  if (shown) {
    return Response.json(
      { code: shown.code, message: shown.userMessage },
      {
        status: shown.status === 'blocked' ? 400 : 429,
        headers: shown.retryAfterSec ? { 'Retry-After': String(shown.retryAfterSec) } : undefined,
      },
    );
  }
  if (refusals.length) return res;
  const failed = await prisma.emailLog
    .findFirst({
      // Real send failures only: guard refusals (blocked / throttled /
      // suppressed) were handled above and must not read as "refused".
      where: { toAddr: email, createdAt: { gte: since }, status: { in: ['failed', 'not_configured'] } },
      orderBy: { createdAt: 'desc' },
      select: { error: true },
    })
    .catch(() => null);
  if (failed) {
    return Response.json(
      {
        code: 'EMAIL_SEND_FAILED',
        message: `The e-mail could not be sent just now (our mail server refused it). Please try again in a few minutes.${supportLine()}`,
      },
      { status: 502 },
    );
  }
  return res;
}

export async function POST(req: Request) {
  // Matched on the path better-auth routes by ("/sign-in/email/" is the same
  // endpoint), so a trailing slash can't skip the limits below.
  const pathname = canonicalAuthPath(new URL(req.url).pathname);
  const ip = clientIpFrom(req.headers);
  if (MAIL_PATHS.test(pathname)) {
    const limited = await ipLimit(pathname, ip);
    if (limited) return limited;
    return withMailCheck(req, pathname, () => handlers.POST(req));
  }
  if (/\/sign-in\/email$/.test(pathname)) return passwordSignIn(req);
  const limited = await ipLimit(pathname, ip);
  if (limited) return limited;
  if (/\/two-factor\/verify-(totp|backup-code)$/.test(pathname)) return twoFactorVerify(req);
  return handlers.POST(req);
}
