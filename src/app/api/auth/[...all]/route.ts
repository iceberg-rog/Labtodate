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
import { emailTransportStatus, sendEmail } from '@/lib/email';
import { ensureSettingsLoaded } from '@/lib/settings';
import { escapeHtml } from '@/lib/email-html';
import { alertSuperAdmins } from '@/lib/security/alerts';
import { noteSuccessfulSignIn } from '@/lib/security/signin-events';

const handlers = toNextJsHandler(auth.handler);

export const GET = handlers.GET;

// BUG-025 / invariant A14: per-IP limits on the credential-sensitive auth POST
// endpoints (email enumeration, sign-up spam, email bombing via
// magic-link/forgot-password). Counters are persistent (Postgres). Password
// sign-in has its own per-account + per-network policy below (A33). The first
// matching rule wins, so specific paths come first.
const LIMITS: Array<{ match: RegExp; bucket: string; max: number; windowMs: number }> = [
  { match: /\/magic-link\b/, bucket: 'auth:magic', max: 5, windowMs: 15 * 60_000 },
  { match: /\/sign-up\b/, bucket: 'auth:sign-up', max: 5, windowMs: 60 * 60_000 },
  // better-auth 1.6 calls the forgot-password endpoint /request-password-reset.
  { match: /\/(request-password-reset|forget-password|forgot-password)\b/, bucket: 'auth:forgot', max: 5, windowMs: 15 * 60_000 },
  { match: /\/reset-password\b/, bucket: 'auth:reset', max: 5, windowMs: 15 * 60_000 },
  { match: /\/send-verification-email\b/, bucket: 'auth:verify-email', max: 5, windowMs: 15 * 60_000 },
  // Email-OTP send is a cost + email-bombing lever (each hit emails an
  // arbitrary address). Verify is capped too so a single IP can't grind codes.
  { match: /\/email-otp\/send/, bucket: 'auth:otp-send', max: 5, windowMs: 15 * 60_000 },
  { match: /\/email-otp\/verify/, bucket: 'auth:otp-verify', max: 20, windowMs: 15 * 60_000 },
  // Second-factor codes: per IP here, per pending sign-in (account) below.
  { match: /\/two-factor\/verify-/, bucket: 'auth:2fa-verify', max: 30, windowMs: 15 * 60_000 },
];

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
    await sendEmail({
      to: email,
      subject: 'Sign-in to your lab2date account was paused',
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#0E4F40;">Too many wrong passwords</h2>
        <p>Hi ${escapeHtml(user.name || 'there')},</p>
        <p>Someone entered a wrong password for your account several times${block.scope === 'account-ip' ? ` from the network ${escapeHtml(ip)}` : ' from several networks'}. To protect the account, password sign-in is paused for ${mins} minutes${block.scope === 'account-ip' ? ' from that network' : ''}.</p>
        <p>Was it you? Reset your password to get in right away: <a href="${site}/auth/forgot-password">${site}/auth/forgot-password</a></p>
        <p style="color:#6b7280;font-size:13px;">Wasn’t you? Your password was not accepted. Resetting it to a new, strong one is still a good idea.</p>
      </div>`,
      text: `Too many wrong passwords were entered for your lab2date account. Password sign-in is paused for ${mins} minutes. Reset your password to get in right away: ${site}/auth/forgot-password`,
    }).catch(() => {});
  }
  if (user.role === 'ADMIN') {
    await alertSuperAdmins('Sign-in paused for an admin account', [
      `${email}: too many wrong passwords (${block.scope === 'account-ip' ? `from ${ip}` : 'from several networks'}).`,
      `Password sign-in is paused until ${block.until.toISOString()}.`,
    ]);
  }
}

/** Password sign-in with the brute-force policy from Settings → Security (A33). */
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
  const res = await handlers.POST(req);
  if (res.status === 401) {
    await auditAs({ email, ip }, 'auth.signin.failed', email || undefined, 'wrong email or password');
    const locked = await recordSignInFailure(policy, email, ip);
    if (locked) await notifyLockout(email, locked, ip);
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
  const support = (process.env.SUPPORT_EMAIL || '').trim();
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
  const res = await next();
  if (res.status !== 200 || !email || /sign-up/.test(pathname)) return res;
  const failed = await prisma.emailLog
    .findFirst({
      where: { toAddr: email, createdAt: { gte: since }, status: { not: 'sent' } },
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
  const { pathname } = new URL(req.url);
  if (MAIL_PATHS.test(pathname)) {
    const rule = LIMITS.find((r) => r.match.test(pathname));
    if (rule) {
      const hit = await allowHit(`rl:${rule.bucket}:${clientIpFrom(req.headers)}`, rule.max, rule.windowMs);
      if (!hit.allowed) return tooMany('Too many attempts. Please wait a few minutes and try again.', 'TOO_MANY_ATTEMPTS', hit.resetAt);
    }
    return withMailCheck(req, pathname, () => handlers.POST(req));
  }
  if (/\/sign-in\/email$/.test(pathname)) return passwordSignIn(req);
  const rule = LIMITS.find((r) => r.match.test(pathname));
  if (rule) {
    const hit = await allowHit(`rl:${rule.bucket}:${clientIpFrom(req.headers)}`, rule.max, rule.windowMs);
    if (!hit.allowed) {
      // Better-Auth clients surface `message` from JSON error bodies.
      return tooMany('Too many attempts. Please wait a few minutes and try again.', 'TOO_MANY_ATTEMPTS', hit.resetAt);
    }
  }
  if (/\/two-factor\/verify-(totp|backup-code)$/.test(pathname)) return twoFactorVerify(req);
  return handlers.POST(req);
}
