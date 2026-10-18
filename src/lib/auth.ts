import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { magicLink, emailOTP, twoFactor } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { hashPassword } from 'better-auth/crypto';
import { prisma } from './db';
import { sendEmail } from './email';
import { escapeHtml } from './email-html';
import { ensureSettingsLoaded } from './settings';
import { DEFAULT_SITE_NAME, siteName } from './brand/identity';
import { brandedMail, mailBrandColor } from './quotes/mail';
import { clientIpFrom } from './ratelimit';
import { deviceLabel, noteSuccessfulSignIn } from './security/signin-events';
import { cleanName, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, NAME_RULE } from './auth-rules';
import { isOwnMediaUrl } from './products/image-urls';
import { safeRedirect, signInErrorURL } from './safe-redirect';
import { getSecurityPolicy } from './security/policy';
import { clearAccountSignInLocks } from './security/throttle';
import {
  CAPTCHA_HEADER,
  captchaAlwaysOn,
  consumeCodePass,
  grantCodePass,
  verifyCaptcha,
  type CaptchaPurpose,
} from './security/captcha';
import { domainBlock } from './email-guard/rules';
import { guardOutgoing } from './email-guard';

// Startup sanity check (non-fatal): surface a misconfigured production secret
// in the logs without taking the site down. A placeholder/short secret means
// session tokens are forgeable — it must be a 32+ char random value.
if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
  const s = process.env.BETTER_AUTH_SECRET || '';
  if (s.length < 32 || s.includes('change-me')) {
    console.error('[auth] SECURITY: BETTER_AUTH_SECRET is missing, <32 chars, or still the placeholder — set a strong random value in .env.');
  }
  if ((process.env.CRON_SECRET || '').includes('change-me')) {
    console.error('[auth] SECURITY: CRON_SECRET is still the placeholder — set a strong random value in .env.');
  }
}

const SITE_URL = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');

// Routes that carry the account's `email` in the body and lead to a session
// or a sign-in email — blocked up front for suspended accounts.
const SUSPENSION_GATED = ['/sign-up/email', '/email-otp/send-verification-otp', '/email-otp/verify-email'];

// Endpoints that only CONFIRM an address (e-mailed code / verification link).
// They never sign anyone in: a session always needs the password (+ the
// authenticator code where 2FA is on) or, for non-staff accounts without 2FA,
// a magic link. Enforced twice — autoSignInAfterVerification is off, and the
// session-create hook refuses a session minted on these paths.
export const VERIFY_ONLY_PATHS = ['/email-otp/verify-email', '/verify-email'];

/** Same answer as a wrong code, so the endpoint tells nobody which addresses exist. */
function invalidCodeError() {
  return new APIError('BAD_REQUEST', { message: 'Invalid OTP', code: 'INVALID_OTP' });
}

/**
 * Endpoints that e-mail an address the visitor types, and the bot check that
 * guards each (Settings → Security → Bot check). Checked here, on the
 * endpoint's own path (whatever URL variant reached it), and only for HTTP
 * requests: server code calling auth.api.* (an admin's "Send reset e-mail")
 * has no visitor to ask.
 */
const MAIL_ENDPOINT_CAPTCHA: Record<string, CaptchaPurpose> = {
  '/sign-up/email': 'signup',
  '/sign-in/magic-link': 'magic_link',
  '/request-password-reset': 'password_reset',
  '/send-verification-email': 'verify_email',
  '/email-otp/send-verification-otp': 'verify_email',
};

/**
 * Refuse blocked / throw-away domains up front (so no account is even created
 * for …@txt.att.net), then require a solved bot check where it is on. A
 * sign-up that passed the check may send its first code without a second one.
 *
 * A new code REPLACES the one already e-mailed, so when the e-mail guard
 * would hold the new one back (the address had a code moments ago) the
 * request is answered here, before a code is made: the first code keeps
 * working. Same answer as for an address without an account (no enumeration).
 * Returns that answer, or undefined to let the endpoint run.
 */
async function guardMailEndpoint(path: string, purpose: CaptchaPurpose, email: string, headers: Headers | undefined): Promise<{ success: true } | undefined> {
  const policy = await getSecurityPolicy();
  if (email) {
    const block = domainBlock(email, policy);
    if (block) {
      await auditAuth('auth.email.blocked', email, `${path}: ${block.kind} domain ${block.matched}`);
      throw new APIError('BAD_REQUEST', { message: block.message, code: 'EMAIL_DOMAIN_BLOCKED' });
    }
  }
  if (captchaAlwaysOn(policy, purpose)) {
    const payload = headers?.get(CAPTCHA_HEADER);
    const passed = !payload && path === '/email-otp/send-verification-otp' && !!email && (await consumeCodePass(email));
    if (!passed) {
      const check = await verifyCaptcha(payload, purpose);
      if (!check.ok) {
        if (check.code !== 'CAPTCHA_REQUIRED') await auditAuth('auth.captcha.failed', email || '(no e-mail)', `${path}: ${check.code}`);
        throw new APIError('FORBIDDEN', { message: check.message, code: check.code });
      }
    }
  }
  if (path === '/email-otp/send-verification-otp' && email) {
    const pre = await guardOutgoing(email, 'auth.signup-code', policy, { count: false });
    if (!pre.ok) {
      if (pre.scope === 'address') {
        await prisma.emailLog
          .create({
            data: {
              toAddr: email,
              subject: '(verification code) not sent',
              status: pre.status,
              error: `${pre.reason} — no new code made, the last one stays valid`.slice(0, 500),
              trigger: 'auth.signup-code',
              toDomain: email.split('@')[1] ?? null,
              ip: headers?.get('x-real-ip')?.slice(0, 64) ?? null,
            },
          })
          .catch(() => {});
        return { success: true };
      }
      throw new APIError(pre.status === 'blocked' ? 'BAD_REQUEST' : 'TOO_MANY_REQUESTS', { message: pre.message, code: pre.code });
    }
  }
  return undefined;
}

// better-auth endpoints that change the account on the strength of a session
// found via `sessionMiddleware`, which trusts the cookie cache (the sensitive
// ones — change-password, revoke-sessions, … — already bypass it).
const SESSION_WRITES = ['/update-user', '/update-session', '/link-social', '/unlink-account'];

function suspendedError(reason: string | null) {
  return new APIError('FORBIDDEN', { message: `Account suspended: ${reason || 'contact support'}` });
}

/**
 * Accounts that must not sign in with an e-mailed link: anyone with two-factor
 * sign-in on (the link would skip the second factor), and admins unless the
 * security policy allows it — otherwise whoever gets into an admin's mailbox
 * owns the console.
 */
async function magicLinkRefused(user: { role?: string | null; twoFactorEnabled?: boolean | null }): Promise<boolean> {
  if (user.twoFactorEnabled) return true;
  if (user.role === 'ADMIN') return !(await getSecurityPolicy()).ADMIN_MAGIC_LINK_ALLOWED;
  return false;
}

async function auditAuth(action: string, email: string, meta?: string) {
  try {
    await prisma.auditLog.create({ data: { actorEmail: email, action, target: email, meta: meta ?? null } });
  } catch {
    /* best effort */
  }
}

/** "Not you? Reset your password …" line for account security mails. */
function notYouLine(): string {
  const url = `${SITE_URL}/auth/forgot-password`;
  return `If this wasn't you, reset your password right away at <a href="${url}" style="color:${mailBrandColor()};">${url}</a> and contact support.`;
}

async function sendTwoFactorNotice(email: string, on: boolean) {
  const mail = await brandedMail((site) => {
    const subject = on ? `Two-factor sign-in is on for your ${site} account` : `Two-factor sign-in was turned off on your ${site} account`;
    const line = on
      ? 'From now on, signing in needs your password and a code from your authenticator app. Other devices were signed out. Keep your recovery codes somewhere safe.'
      : 'Your account no longer asks for an authenticator code at sign-in.';
    return {
      subject,
      heading: on ? 'Two-factor sign-in is on' : 'Two-factor sign-in was turned off',
      body: [escapeHtml(line)],
      footer: [notYouLine()],
      text: `${subject}\n\n${line}\n\nNot you? Reset your password at ${SITE_URL}/auth/forgot-password and contact support.`,
    };
  });
  await sendEmail({ to: email, trigger: 'account', ...mail }).catch((e) => console.error('[auth] two-factor notice failed:', e));
}

/**
 * Password changed on the Profile page (better-auth /change-password): audit
 * it and tell the owner, with the device — a hijacked session could otherwise
 * change the password silently. Resets by e-mailed link have their own notice
 * (onPasswordReset).
 */
async function notePasswordChanged(user: { id: string; email: string }, request: Request | undefined, othersSignedOut: boolean) {
  const ip = request ? clientIpFrom(request.headers) : 'unknown';
  const device = deviceLabel(request?.headers.get('user-agent'));
  await prisma.auditLog
    .create({
      data: {
        actorEmail: user.email,
        actorId: user.id,
        ip: ip === 'unknown' ? null : ip,
        action: 'auth.password.changed',
        target: user.id,
        meta: `device=${device}; other sessions ${othersSignedOut ? 'signed out' : 'kept'}`,
      },
    })
    .catch(() => {});
  const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });
  const mail = await brandedMail((site) => {
    const line = `The password on your ${site} account was just changed on the Profile page${othersSignedOut ? ', and every other device that was signed in has been signed out' : ''}.`;
    return {
      subject: `Your ${site} password was changed`,
      heading: 'Your password was changed',
      body: [
        escapeHtml(line),
        `<p style="margin:0 0 12px;"><strong>${escapeHtml(device)}</strong><br>IP address ${escapeHtml(ip)}<br>${escapeHtml(when)} (Amsterdam time)</p>`,
      ],
      footer: [notYouLine()],
      text: `${line}\n${device}, IP ${ip}, ${when} (Amsterdam time).\n\nIf this wasn't you, reset your password right away at ${SITE_URL}/auth/forgot-password and contact support.`,
    };
  });
  await sendEmail({ to: user.email, trigger: 'account', ...mail }).catch((e) => console.error('[auth] password-changed notice failed:', e));
}

/**
 * The account a request is signed in to, read from its session cookie (null:
 * not signed in). The cookie's token is the session secret; its signature only
 * guards against tampering, which a wrong token can't survive either.
 */
async function sessionUserId(request: Request | undefined): Promise<string | null> {
  const cookie = request?.headers.get('cookie') ?? '';
  const m = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/.exec(cookie);
  const token = m ? decodeURIComponent(m[1]).split('.')[0] : '';
  if (!token) return null;
  const row = await prisma.session.findUnique({ where: { token }, select: { userId: true, expiresAt: true } }).catch(() => null);
  return row && row.expiresAt > new Date() ? row.userId : null;
}

const AVATAR_RULE = 'Profile photos can only be changed by uploading one on your Profile page.';
// /api/avatar-upload stores `${S3_PUBLIC_URL}/products/avatars/<userId>-<stamp>.<ext>`.
const AVATAR_FILE = /\/products\/avatars\/([^/]+)$/;

/**
 * user.image as written through better-auth (/update-user, /sign-up/email).
 * Photos are set by /api/avatar-upload, which writes the column directly;
 * here the field may only be cleared or point at one of the account's own
 * uploads — never javascript:/data: or someone else's host. `ownerId` is the
 * signed-in account; without one (sign-up) nothing has been uploaded yet.
 */
function cleanAvatar(value: unknown, ownerId: string | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  const file =
    ownerId && typeof value === 'string' && isOwnMediaUrl(value)
      ? AVATAR_FILE.exec(new URL(value, 'http://relative.invalid').pathname)?.[1]
      : undefined;
  if (!file?.startsWith(`${ownerId}-`)) throw new APIError('BAD_REQUEST', { message: AVATAR_RULE });
  return value as string;
}

// What the person entering a verification code chose: the sign-up and sign-in
// code steps send the password (and the sign-up name) along with the code.
// Keyed by the in-flight request so beforeEmailVerification — which
// better-auth only calls once the code has checked out — can apply it.
const chosenAtVerification = new WeakMap<Request, { password?: unknown; name?: unknown }>();

/**
 * Pre-account takeover guard. Nothing proves who chose an unverified
 * account's password: anyone can register someone else's address and wait
 * for the owner to verify it. So the first time the address IS proven (code,
 * magic link, verification link) everything set up before that is dropped:
 * all existing sessions are signed out, and the password becomes the one the
 * verifier typed — or, when they typed none (magic link), is removed so the
 * owner sets one via "Forgot password". A sign-up name sent with the code
 * replaces the earlier one too. Reports whether a password was removed, so
 * the owner can be told (they may well have chosen it themselves).
 */
async function claimUnverifiedAccount(
  userId: string,
  chosen?: { password?: unknown; name?: unknown },
): Promise<{ passwordRemoved: boolean }> {
  const password =
    typeof chosen?.password === 'string' &&
    chosen.password.length >= MIN_PASSWORD_LENGTH &&
    chosen.password.length <= MAX_PASSWORD_LENGTH
      ? chosen.password
      : null;
  const hash = password ? await hashPassword(password) : null;
  const name = cleanName(chosen?.name);
  const passwordRemoved = !hash && (await hasPassword(userId));
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { userId } }),
    prisma.account.updateMany({ where: { userId, providerId: 'credential' }, data: { password: hash } }),
    ...(name ? [prisma.user.update({ where: { id: userId }, data: { name } })] : []),
  ]);
  return { passwordRemoved };
}

async function hasPassword(userId: string): Promise<boolean> {
  const count = await prisma.account.count({
    where: { userId, providerId: 'credential', password: { not: null } },
  });
  return count > 0;
}

// Added to the magic-link / verification-link email of an unverified account
// that has a password: following the link verifies the address, and
// claimUnverifiedAccount then removes that password.
const PASSWORD_REMOVAL_NOTE =
  'This address hasn’t been confirmed yet, so opening the link confirms it and, for your security, removes the password set on the account before then. After signing in, set a new one with “Forgot password” on the sign-in page.';

/** encodeURIComponent that also escapes !'()*~, which better-auth refuses in a relative callbackURL. */
function encodeStrict(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Magic-link callbackURL that lands on the "your email is verified, set a
 * password" notice (src/app/auth/verified) and then continues to where the
 * link was going. better-auth URL-decodes callbackURL once more before
 * redirecting, hence the double encoding.
 */
function passwordRemovedNoticeURL(callbackURL: string): string {
  let target = '/auth/continue';
  try {
    target = safeRedirect(decodeURIComponent(callbackURL));
  } catch {}
  return `/auth/verified?redirect=${encodeStrict(encodeStrict(target))}`;
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  // The brand at boot (Settings → Brand). The authenticator-app account name
  // follows a later change: /two-factor/enable gets the live SITE_NAME below.
  appName: siteName(),

  emailAndPassword: {
    enabled: true,
    // An unverified account can't sign in with its password (403
    // EMAIL_NOT_VERIFIED); the sign-in form then mails a code instead.
    requireEmailVerification: true,
    // No session is issued on sign-up — the sign-up form emails a 5-digit
    // code; the code only confirms the address, then the form signs in with
    // the password just typed (normal password path: throttle, 2FA).
    autoSignIn: false,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxPasswordLength: MAX_PASSWORD_LENGTH,
    // A reset is how a stolen or squatted account is recovered: sign out
    // every other session, not just the browser that did the reset.
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: async ({ user }) => {
      // The reset link reached the inbox, so the address is proven.
      if (!user.emailVerified) {
        await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
      }
      // …and so is the owner: lift any brute-force pause on the account.
      await clearAccountSignInLocks(user.email);
      await auditAuth('auth.password.reset', user.email);
      const mail = await brandedMail((site) => ({
        subject: `Your ${site} password was changed`,
        heading: 'Your password was changed',
        body: [`The password on your ${escapeHtml(site)} account was just reset, and every device that was signed in has been signed out.`],
        footer: [notYouLine()],
        text: `The password on your ${site} account was just reset and all devices were signed out. If this wasn't you, reset it again at ${SITE_URL}/auth/forgot-password and contact support.`,
      }));
      await sendEmail({ to: user.email, trigger: 'account', ...mail }).catch((e) => console.error('[auth] password-changed notice failed:', e));
    },
    sendResetPassword: async ({ user, url }, request) => {
      const mail = await brandedMail((site) => ({
        subject: `Reset your ${site} password`,
        heading: 'Reset your password',
        body: [
          `Hi ${escapeHtml(user.name || 'there')},`,
          `We received a request to reset the password on your ${escapeHtml(site)} account. Click the button below — the link expires in 1 hour.`,
        ],
        cta: { href: url, label: 'Reset password' },
        footer: ["If you didn't request this, you can safely ignore this e-mail — your password won't change."],
        text: `Reset your ${site} password: ${url}\n\nThis link expires in 1 hour. If you didn't request this, ignore the e-mail.`,
      }));
      await sendEmail({
        to: user.email,
        // Asked for by the account itself while signed in ("Email me a link to
        // set a password" right after a sign-in link): not an anonymous
        // trigger, so the per-address wait the sign-in link just started
        // doesn't silently hold it back. Anyone else: the visitor limits.
        trigger: (await sessionUserId(request)) === user.id ? 'account' : 'auth.password-reset',
        ...mail,
      });
    },
    resetPasswordTokenExpiresIn: 60 * 60, // 1 hour
  },

  emailVerification: {
    sendOnSignUp: false,
    // Confirming the address never signs in (security finding: an e-mail code
    // minted a full session for verified admins, skipping password AND 2FA).
    // The code screen signs in with the password afterwards (VerifyEmailStep).
    autoSignInAfterVerification: false,
    expiresIn: 60 * 60, // 1 hour
    // Runs once the code / link has checked out, before the account is
    // marked verified and the verifier's session is created.
    beforeEmailVerification: async (user, request) => {
      if (user.emailVerified) return;
      await claimUnverifiedAccount(user.id, request ? chosenAtVerification.get(request) : undefined);
    },
    sendVerificationEmail: async ({ user, url }) => {
      const note = !user.emailVerified && (await hasPassword(user.id)) ? PASSWORD_REMOVAL_NOTE : null;
      const mail = await brandedMail((site) => ({
        subject: `Verify your ${site} e-mail`,
        heading: 'Confirm your e-mail',
        body: [
          `Hi ${escapeHtml(user.name || 'there')},`,
          'Click the button below to confirm that this e-mail address belongs to you. The link expires in 1 hour.',
          ...(note ? [note] : []),
        ],
        cta: { href: url, label: 'Verify my e-mail' },
        footer: ["If you didn't request this, you can safely ignore this e-mail."],
        text: `Verify your ${site} e-mail: ${url}\n\nThis link expires in 1 hour. If you didn't request this, ignore the e-mail.${note ? `\n\n${note}` : ''}`,
      }));
      await sendEmail({ to: user.email, trigger: 'auth.verify-link', ...mail });
    },
  },

  user: {
    additionalFields: {
      // Roles are read-only from client; server-side flows promote BUYER → SELLER
      // via a separate "become a seller" endpoint (Phase 4).
      role: {
        type: 'string',
        defaultValue: 'BUYER',
        input: false,
      },
      companyId: {
        type: 'string',
        required: false,
        input: false,
      },
    },
  },

  databaseHooks: {
    user: {
      // Names are trimmed and 2–120 chars on every write path (sign-up,
      // Profile → update-user), not just in the forms. The photo URL is
      // limited to the account's own uploads (cleanAvatar).
      create: {
        before: async (user) => {
          const name = cleanName(user.name);
          if (!name) throw new APIError('BAD_REQUEST', { message: NAME_RULE });
          return { data: { ...user, name, image: cleanAvatar(user.image, null) } };
        },
      },
      update: {
        before: async (data, ctx) => {
          if (data.name === undefined && data.image === undefined) return;
          const next = { ...data };
          if (data.name !== undefined) {
            const name = cleanName(data.name);
            if (!name) throw new APIError('BAD_REQUEST', { message: NAME_RULE });
            next.name = name;
          }
          if (data.image !== undefined) next.image = cleanAvatar(data.image, ctx?.context.session?.user.id ?? null);
          return { data: next };
        },
      },
    },
    session: {
      create: {
        // The one choke point every session passes through (password, code,
        // magic link, verification link): suspended or unverified accounts
        // never get one, whichever route they come in by.
        before: async (session, ctx) => {
          // Confirming an e-mail address is not a sign-in, whatever the
          // account (password + 2FA always apply) — see VERIFY_ONLY_PATHS.
          const path = (ctx as { path?: string } | null | undefined)?.path ?? '';
          if (VERIFY_ONLY_PATHS.includes(path)) {
            await auditAuth('auth.session.refused', session.userId, `session requested on ${path}`);
            throw new APIError('FORBIDDEN', { message: 'Your email address is confirmed. Sign in with your password to continue.' });
          }
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { emailVerified: true, suspendedAt: true, suspendedReason: true },
          });
          if (user?.suspendedAt) throw suspendedError(user.suspendedReason);
          if (user && !user.emailVerified) {
            throw new APIError('FORBIDDEN', { message: 'Please verify your email address before signing in.' });
          }
        },
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh once per day
    cookieCache: {
      enabled: true,
      // Short cache so an admin role change (promote/ban/demote) takes
      // effect within ~1 min instead of being stale for 5. requireSession
      // (src/lib/auth-server.ts) bypasses it, so /app and /admin see a
      // sign-out / revoked session immediately.
      maxAge: 60, // 1 minute
    },
  },

  // better-auth's own limiter (per IP, in memory) is off for password
  // sign-in: its rule (3 requests, counter only resets after 10 quiet
  // seconds) blocks a whole university behind one address once its people
  // sign in steadily. The real brute-force policy — wrong passwords per
  // account + network and per IP, persistent, admin-configurable — is in
  // src/app/api/auth/[...all]/route.ts.
  rateLimit: {
    customRules: {
      '/sign-in/email': false,
    },
  },

  advanced: {
    // Key better-auth's built-in rate limiter (and session IPs) on the address
    // nginx sets from the TCP peer. The default, the left-most X-Forwarded-For
    // entry, is whatever the client sends — rotating it bypassed the limiter.
    // Same trust rule as clientIp() in src/lib/ratelimit.ts.
    ipAddress: { ipAddressHeaders: ['x-real-ip'] },
  },

  disabledPaths: [
    // Email-OTP sign-in verifies an address without the claim step above and
    // would create accounts with no name / Terms; the UI never uses it.
    '/sign-in/email-otp',
    // Password reset is by emailed link (/request-password-reset). The OTP
    // variants are unused and mailed owners the sign-up code email.
    '/email-otp/request-password-reset',
    '/forget-password/email-otp',
    '/email-otp/reset-password',
    // Unused by the UI; it answered USER_NOT_FOUND vs INVALID_OTP, which told
    // anyone whether an address has an account (enumeration).
    '/email-otp/check-verification-otp',
    // E-mail change by code is not offered (changeEmail is off) — closed too.
    '/email-otp/request-email-change',
    '/email-otp/change-email',
  ],

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // GET /magic-link/verify carries only a token, so resolve which account
      // it signs into: refuse a suspended one with a readable message (rather
      // than a JSON error page) and run the first-verification claim, since
      // following the link proves the address.
      if (ctx.path === '/magic-link/verify') {
        const query = (ctx.query ?? {}) as { token?: string; callbackURL?: string; errorCallbackURL?: string };
        const next = { ...query };
        const row = query.token ? await ctx.context.internalAdapter.findVerificationValue(query.token) : null;
        if (row && row.expiresAt > new Date()) {
          let email = '';
          try {
            email = String((JSON.parse(row.value) as { email?: string }).email ?? '').toLowerCase();
          } catch {}
          const user = email
            ? await prisma.user.findUnique({
                where: { email },
                select: { id: true, emailVerified: true, suspendedAt: true, role: true, twoFactorEnabled: true },
              })
            : null;
          if (user?.suspendedAt) throw ctx.redirect('/auth/sign-in?error=ACCOUNT_SUSPENDED');
          // A link mailed before the account got 2FA / admin rights (or before
          // this rule existed) must not sign it in either.
          if (user && (await magicLinkRefused(user))) {
            await ctx.context.internalAdapter.deleteVerificationByIdentifier(query.token!).catch(() => {});
            await auditAuth('auth.magiclink.refused', email, 'link opened for an admin / 2FA account');
            throw ctx.redirect('/auth/sign-in?error=MAGIC_LINK_DISABLED');
          }
          if (user && !user.emailVerified) {
            const { passwordRemoved } = await claimUnverifiedAccount(user.id);
            // The password they chose at sign-up is gone: say so and offer
            // to set one, instead of a silent "Invalid email or password"
            // on their next password sign-in.
            if (passwordRemoved && query.callbackURL) next.callbackURL = passwordRemovedNoticeURL(query.callbackURL);
          }
        }
        // Links without an error target (older emails, hand-edited URLs) had
        // ?error= appended to the destination page, which never shows it.
        if (!query.errorCallbackURL) next.errorCallbackURL = signInErrorURL(query.callbackURL);
        return { context: { query: next } };
      }

      const captchaPurpose = MAIL_ENDPOINT_CAPTCHA[ctx.path];
      if (captchaPurpose && ctx.request) {
        const raw = (ctx.body ?? {}) as { email?: unknown };
        const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase().slice(0, 254) : '';
        const answered = await guardMailEndpoint(ctx.path, captchaPurpose, email, ctx.headers ?? ctx.request.headers);
        if (answered) return answered;
      }

      // Session-backed writes inside better-auth (Profile name / photo via
      // update-user, …) re-read the session row instead of trusting the ≤60s
      // cookie cache, so a signed-out, revoked or suspended session can't
      // keep changing the account. (Password / email changes already do.)
      if (SESSION_WRITES.includes(ctx.path)) {
        return { context: { query: { ...(ctx.query ?? {}), disableCookieCache: true } } };
      }

      // The account name the authenticator app shows: the live brand
      // (Settings → Brand), not the one the server booted with.
      if (ctx.path === '/two-factor/enable') {
        await ensureSettingsLoaded();
        return { context: { body: { ...((ctx.body ?? {}) as Record<string, unknown>), issuer: siteName() } } };
      }

      // "Trust this device for 30 days" would skip the second factor on the
      // next sign-ins; not offered (admins must enter a code every sign-in).
      if (ctx.path.startsWith('/two-factor/verify-')) {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (body.trustDevice) return { context: { body: { ...body, trustDevice: false } } };
        return;
      }

      if (!ctx.path.startsWith('/sign-in/') && !SUSPENSION_GATED.includes(ctx.path)) return;
      const body = (ctx.body ?? {}) as { email?: unknown; password?: unknown; name?: unknown; type?: unknown };
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email) {
        const user = await prisma.user.findUnique({
          where: { email },
          select: { suspendedAt: true, suspendedReason: true },
        });
        if (user?.suspendedAt) throw suspendedError(user.suspendedReason);
      }
      // Only email-confirmation codes are used. Sign-in and password-reset
      // codes have nothing left to redeem them (disabledPaths) and would just
      // mail the owner a code they never asked for.
      if (ctx.path === '/email-otp/send-verification-otp' && body.type !== 'email-verification') {
        throw new APIError('BAD_REQUEST', { message: 'Invalid code type.' });
      }
      if (ctx.path === '/email-otp/verify-email') {
        // An already confirmed address has nothing to confirm: no code was
        // ever e-mailed for it (sendVerificationOTP below), so a "correct" code
        // can only be guessed or leaked. Same answer as a wrong code.
        if (email) {
          const owner = await prisma.user.findUnique({ where: { email }, select: { emailVerified: true } });
          if (owner?.emailVerified) {
            await prisma.verification.deleteMany({ where: { identifier: `email-verification-otp-${email}` } }).catch(() => {});
            await auditAuth('auth.otp.refused', email, 'verification code submitted for an already verified account');
            throw invalidCodeError();
          }
        }
        if (ctx.request) chosenAtVerification.set(ctx.request, { password: body.password, name: body.name });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // A sign-in by e-mailed link: audit it and run the new-device alert,
      // like a password sign-in (src/app/api/auth/[...all]/route.ts). The
      // link answers with a redirect either way; a session was only made when
      // it signed someone in.
      if (ctx.path === '/magic-link/verify') {
        const made = ctx.context.newSession;
        if (made?.user) {
          const headers = ctx.request?.headers ?? ctx.headers;
          await noteSuccessfulSignIn(
            { id: made.user.id, email: made.user.email },
            headers ? clientIpFrom(headers) : 'unknown',
            headers?.get('user-agent') ?? null,
            'magic link',
          );
        }
        return;
      }
      // Password changed on the Profile page: audit + tell the owner.
      if (ctx.path === '/change-password') {
        const returned = ctx.context.returned;
        const user = ctx.context.session?.user as { id: string; email: string } | undefined;
        if (user && returned && !(returned instanceof APIError)) {
          const revoke = !!((ctx.body ?? {}) as { revokeOtherSessions?: unknown }).revokeOtherSessions;
          await notePasswordChanged(user, ctx.request, revoke);
        }
        return;
      }
      // A sign-up that passed the bot check: its code e-mail (sent by the form
      // right after) needs no second check. Only when sign-up has the check on.
      if (ctx.path === '/sign-up/email') {
        const done = ctx.context.returned;
        const raw = (ctx.body ?? {}) as { email?: unknown };
        if (ctx.request && done && !(done instanceof APIError) && typeof raw.email === 'string') {
          const policy = await getSecurityPolicy();
          if (captchaAlwaysOn(policy, 'signup')) await grantCodePass(raw.email);
        }
        return;
      }
      // Two-factor switched on or off: audit it, tell the owner, and when it
      // was just switched on sign out every other session (opened without it).
      if (ctx.path !== '/two-factor/verify-totp' && ctx.path !== '/two-factor/disable') return;
      const returned = ctx.context.returned;
      if (!returned || returned instanceof APIError) return;
      const user = ctx.context.session?.user as { id: string; email: string; twoFactorEnabled?: boolean | null } | undefined;
      if (!user) return; // a sign-in code check, not a settings change
      if (ctx.path === '/two-factor/verify-totp') {
        if (user.twoFactorEnabled) return; // already on: a step-up check
        // better-auth replaced this browser's session while switching 2FA on;
        // the new one is in the Set-Cookie of this response (the JSON body
        // still carries the old, already deleted token). Keep that one.
        const setCookie = ctx.context.responseHeaders?.get('set-cookie') ?? '';
        const keep = /better-auth\.session_token=([^;]+)/.exec(setCookie)?.[1];
        const keepToken = keep ? decodeURIComponent(keep).split('.')[0] : null;
        const dropped = await prisma.session.deleteMany({
          where: keepToken
            ? { userId: user.id, NOT: { token: keepToken } }
            : // Fallback: keep sessions created during this request.
              { userId: user.id, createdAt: { lt: new Date(Date.now() - 15_000) } },
        });
        await auditAuth('auth.2fa.enabled', user.email, `other sessions signed out: ${dropped.count}`);
        await sendTwoFactorNotice(user.email, true);
      } else {
        await auditAuth('auth.2fa.disabled', user.email);
        await sendTwoFactorNotice(user.email, false);
      }
    }),
  } satisfies BetterAuthOptions['hooks'],

  plugins: [
    magicLink({
      // Sign-in links are for existing accounts only; new visitors go through
      // sign-up (name + Terms). Unknown addresses get a "no account" email.
      disableSignUp: true,
      expiresIn: 60 * 10, // 10 minutes
      sendMagicLink: async ({ email, url }) => {
        const exists = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
          select: { id: true, emailVerified: true, role: true, twoFactorEnabled: true },
        });
        if (!exists) {
          const mail = await brandedMail((site) => ({
            subject: `Sign-in request for ${site}`,
            heading: `No ${site} account yet`,
            body: [`Someone asked for a sign-in link for this address, but there's no ${escapeHtml(site)} account for it.`],
            cta: { href: `${SITE_URL}/auth/sign-up`, label: 'Create an account' },
            footer: ["If you didn't request this, you can safely ignore the e-mail."],
            text: `There's no ${site} account for this address. Create one at ${SITE_URL}/auth/sign-up\n\nIf you didn't request this, ignore the e-mail.`,
          }));
          await sendEmail({ to: email, trigger: 'auth.notice', ...mail });
          return;
        }
        if (await magicLinkRefused(exists)) {
          // Same answer to the requester as a real link ("check your email"),
          // so this can't be used to find admin addresses; the owner is told
          // how to sign in instead.
          await auditAuth('auth.magiclink.refused', email, 'requested for an admin / 2FA account');
          const mail = await brandedMail((site) => ({
            subject: `Sign-in links are switched off for your ${site} account`,
            heading: 'Use your password and authenticator app',
            body: [
              'Someone asked for an e-mailed sign-in link for this address. For your security, this account can only sign in with its password and a code from your authenticator app, so no link was sent.',
              `<p style="margin:0 0 12px;"><a href="${SITE_URL}/auth/sign-in" style="color:${mailBrandColor()};">Sign in</a> · <a href="${SITE_URL}/auth/forgot-password" style="color:${mailBrandColor()};">Forgot password</a></p>`,
            ],
            footer: ["If you didn't ask for this, you can ignore this e-mail — nothing has changed."],
            text: `For your security this ${site} account signs in with its password and an authenticator code only, so no sign-in link was sent. Sign in: ${SITE_URL}/auth/sign-in — Forgot password: ${SITE_URL}/auth/forgot-password\n\nIf you didn't ask for this, ignore this e-mail.`,
          }));
          await sendEmail({ to: email, trigger: 'auth.notice', ...mail });
          return;
        }
        const note = !exists.emailVerified && (await hasPassword(exists.id)) ? PASSWORD_REMOVAL_NOTE : null;
        const mail = await brandedMail((site) => ({
          subject: `Your ${site} sign-in link`,
          heading: `Sign in to ${site}`,
          body: ['Click the button below to sign in. The link expires in 10 minutes and works once.', ...(note ? [note] : [])],
          cta: { href: url, label: `Sign in to ${site}` },
          footer: ["If you didn't request this, you can safely ignore the e-mail."],
          text: `Sign in to ${site}: ${url}\n\nThis link expires in 10 minutes.${note ? `\n\n${note}` : ''}`,
        }));
        await sendEmail({ to: email, trigger: 'auth.magic-link', ...mail });
      },
    }),
    // 5-digit e-mail verification code, used by sign-up and by sign-in for
    // accounts that haven't verified their address yet.
    emailOTP({
      otpLength: 5,
      expiresIn: 60 * 10, // 10 minutes
      allowedAttempts: 5,
      disableSignUp: true,
      // Only a hash of the code is kept: a database / log leak gives no code.
      storeOTP: 'hashed',
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type === 'email-verification') {
          const existing = await prisma.user.findUnique({ where: { email }, select: { emailVerified: true } });
          if (existing?.emailVerified) {
            // better-auth stored a code before calling us; it is never
            // e-mailed, so remove it (nothing redeemable is left behind).
            await prisma.verification.deleteMany({ where: { identifier: `email-verification-otp-${email.toLowerCase()}` } }).catch(() => {});
            // Sign-up with an address that already has an account (sign-up
            // answers as if it were new, so it can't be used to probe which
            // addresses are registered). A code would only sign the person in
            // and silently drop the password they just typed — explain instead.
            const mail = await brandedMail((site) => ({
              subject: `You already have a ${site} account`,
              heading: 'You already have an account',
              body: [
                `Someone (hopefully you) tried to create a ${escapeHtml(site)} account with this address, but it already has one.`,
                `<p style="margin:0 0 12px;"><a href="${SITE_URL}/auth/sign-in" style="color:${mailBrandColor()};">Sign in</a>, or <a href="${SITE_URL}/auth/forgot-password" style="color:${mailBrandColor()};">reset your password</a> if you don't remember it.</p>`,
              ],
              footer: ["If this wasn't you, you can safely ignore this e-mail — nothing has changed."],
              text: `This address already has a ${site} account. Sign in at ${SITE_URL}/auth/sign-in or reset your password at ${SITE_URL}/auth/forgot-password.\n\nIf this wasn't you, ignore this e-mail — nothing has changed.`,
            }));
            await sendEmail({ to: email, trigger: 'auth.notice', ...mail });
            return;
          }
        }
        const mail = await brandedMail((site) => ({
          subject: `${otp} is your ${site} verification code`,
          heading: 'Confirm your e-mail',
          body: [
            `Enter this code to confirm your e-mail address for your ${escapeHtml(site)} account:`,
            `<p style="font-size:34px;font-weight:800;letter-spacing:8px;color:${mailBrandColor()};background:#f3f4f6;border-radius:12px;padding:16px;text-align:center;margin:20px 0;">${otp}</p>`,
          ],
          footer: ["This code expires in 10 minutes. If you didn't ask for it, you can safely ignore this e-mail."],
          text: `Your ${site} verification code is ${otp}. It expires in 10 minutes.`,
        }));
        await sendEmail({ to: email, trigger: 'auth.signup-code', ...mail });
      },
    }),
    // TOTP authenticator app + 10 one-time recovery codes. Required for the
    // roles in Settings → Security (admins by default) — see requireSession.
    twoFactor({
      // Fallback only: /two-factor/enable is given the live SITE_NAME (hooks.before).
      issuer: process.env.SITE_NAME?.trim() || DEFAULT_SITE_NAME,
      backupCodeOptions: { amount: 10, length: 10 },
      // The "enter your code" step after the password stays open 10 minutes.
      twoFactorCookieMaxAge: 600,
    }),
    nextCookies(), // must be last
  ],
});

export type Session = typeof auth.$Infer.Session;
