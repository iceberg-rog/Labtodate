import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { magicLink, emailOTP } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { hashPassword } from 'better-auth/crypto';
import { prisma } from './db';
import { sendEmail } from './email';
import { escapeHtml } from './email-html';
import { cleanName, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, NAME_RULE } from './auth-rules';
import { safeRedirect, signInErrorURL } from './safe-redirect';

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

// better-auth endpoints that change the account on the strength of a session
// found via `sessionMiddleware`, which trusts the cookie cache (the sensitive
// ones — change-password, revoke-sessions, … — already bypass it).
const SESSION_WRITES = ['/update-user', '/update-session', '/link-social', '/unlink-account'];

function suspendedError(reason: string | null) {
  return new APIError('FORBIDDEN', { message: `Account suspended: ${reason || 'contact support'}` });
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
  appName: 'lab2date',

  emailAndPassword: {
    enabled: true,
    // An unverified account can't sign in with its password (403
    // EMAIL_NOT_VERIFIED); the sign-in form then mails a code instead.
    requireEmailVerification: true,
    // No session is issued on sign-up — the sign-up form emails a 5-digit
    // code and verifying it (autoSignInAfterVerification) signs the user in.
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
      await sendEmail({
        to: user.email,
        subject: 'Your lab2date password was changed',
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;">
            <h2 style="color:#0E4F40;">Your password was changed</h2>
            <p>The password on your lab2date account was just reset, and every device that was signed in has been signed out.</p>
            <p style="color:#6b7280;font-size:13px;">If this wasn't you, reset your password again right away at <a href="${SITE_URL}/auth/forgot-password">${SITE_URL}/auth/forgot-password</a> and contact support.</p>
          </div>
        `,
        text: `The password on your lab2date account was just reset and all devices were signed out. If this wasn't you, reset it again at ${SITE_URL}/auth/forgot-password and contact support.`,
      }).catch((e) => console.error('[auth] password-changed notice failed:', e));
    },
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: 'Reset your lab2date password',
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;">
            <h2 style="color:#0E4F40;">Reset your password</h2>
            <p>Hi ${escapeHtml(user.name || 'there')},</p>
            <p>We received a request to reset the password on your lab2date account. Click the button below — the link expires in 1 hour.</p>
            <p style="margin:24px 0;">
              <a href="${escapeHtml(url)}" style="background:#0E4F40;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
                Reset password
              </a>
            </p>
            <p style="color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
          </div>
        `,
        text: `Reset your lab2date password: ${url}\n\nThis link expires in 1 hour. If you didn't request this, ignore the email.`,
      });
    },
    resetPasswordTokenExpiresIn: 60 * 60, // 1 hour
  },

  emailVerification: {
    sendOnSignUp: false,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60, // 1 hour
    // Runs once the code / link has checked out, before the account is
    // marked verified and the verifier's session is created.
    beforeEmailVerification: async (user, request) => {
      if (user.emailVerified) return;
      await claimUnverifiedAccount(user.id, request ? chosenAtVerification.get(request) : undefined);
    },
    sendVerificationEmail: async ({ user, url }) => {
      const note = !user.emailVerified && (await hasPassword(user.id)) ? PASSWORD_REMOVAL_NOTE : null;
      await sendEmail({
        to: user.email,
        subject: 'Verify your lab2date email',
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;">
            <h2 style="color:#0E4F40;">Confirm your email</h2>
            <p>Hi ${escapeHtml(user.name || 'there')},</p>
            <p>Click the button below to confirm that this email belongs to you. The link expires in 1 hour.</p>
            <p style="margin:24px 0;">
              <a href="${escapeHtml(url)}" style="background:#0E4F40;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
                Verify my email
              </a>
            </p>
            ${note ? `<p style="color:#374151;">${note}</p>` : ''}
            <p style="color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
          </div>
        `,
        text: `Verify your lab2date email: ${url}\n\nThis link expires in 1 hour. If you didn't request this, ignore the email.${note ? `\n\n${note}` : ''}`,
      });
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
      // Profile → update-user), not just in the forms.
      create: {
        before: async (user) => {
          const name = cleanName(user.name);
          if (!name) throw new APIError('BAD_REQUEST', { message: NAME_RULE });
          return { data: { ...user, name } };
        },
      },
      update: {
        before: async (data) => {
          if (data.name === undefined) return;
          const name = cleanName(data.name);
          if (!name) throw new APIError('BAD_REQUEST', { message: NAME_RULE });
          return { data: { ...data, name } };
        },
      },
    },
    session: {
      create: {
        // The one choke point every session passes through (password, code,
        // magic link, verification link): suspended or unverified accounts
        // never get one, whichever route they come in by.
        before: async (session) => {
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
                select: { id: true, emailVerified: true, suspendedAt: true },
              })
            : null;
          if (user?.suspendedAt) throw ctx.redirect('/auth/sign-in?error=ACCOUNT_SUSPENDED');
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

      // Session-backed writes inside better-auth (Profile name / photo via
      // update-user, …) re-read the session row instead of trusting the ≤60s
      // cookie cache, so a signed-out, revoked or suspended session can't
      // keep changing the account. (Password / email changes already do.)
      if (SESSION_WRITES.includes(ctx.path)) {
        return { context: { query: { ...(ctx.query ?? {}), disableCookieCache: true } } };
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
      if (ctx.path === '/email-otp/verify-email' && ctx.request) {
        chosenAtVerification.set(ctx.request, { password: body.password, name: body.name });
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
          select: { id: true, emailVerified: true },
        });
        if (!exists) {
          await sendEmail({
            to: email,
            subject: 'Sign-in request for lab2date',
            html: `
              <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
                <h2 style="color: #047857;">No lab2date account yet</h2>
                <p>Someone asked for a sign-in link for this address, but there's no lab2date account for it.</p>
                <p>To get started, <a href="${SITE_URL}/auth/sign-up">create an account</a>.</p>
                <p style="color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore the email.</p>
              </div>
            `,
            text: `There's no lab2date account for this address. Create one at ${SITE_URL}/auth/sign-up\n\nIf you didn't request this, ignore the email.`,
          });
          return;
        }
        const note = !exists.emailVerified && (await hasPassword(exists.id)) ? PASSWORD_REMOVAL_NOTE : null;
        await sendEmail({
          to: email,
          subject: 'Your lab2date sign-in link',
          html: `
            <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
              <h2 style="color: #047857;">Sign in to lab2date</h2>
              <p>Click the link below to sign in. It expires in 10 minutes.</p>
              <p style="margin: 24px 0;">
                <a href="${escapeHtml(url)}"
                   style="background:#047857;color:white;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">
                  Sign in to lab2date
                </a>
              </p>
              ${note ? `<p style="color:#374151;">${note}</p>` : ''}
              <p style="color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore the email.</p>
            </div>
          `,
          text: `Sign in to lab2date: ${url}\n\nThis link expires in 10 minutes.${note ? `\n\n${note}` : ''}`,
        });
      },
    }),
    // 5-digit e-mail verification code, used by sign-up and by sign-in for
    // accounts that haven't verified their address yet.
    emailOTP({
      otpLength: 5,
      expiresIn: 60 * 10, // 10 minutes
      allowedAttempts: 5,
      disableSignUp: true,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type === 'email-verification') {
          const existing = await prisma.user.findUnique({ where: { email }, select: { emailVerified: true } });
          if (existing?.emailVerified) {
            // Sign-up with an address that already has an account (sign-up
            // answers as if it were new, so it can't be used to probe which
            // addresses are registered). A code would only sign the person in
            // and silently drop the password they just typed — explain instead.
            await sendEmail({
              to: email,
              subject: 'You already have a lab2date account',
              html: `
                <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;">
                  <h2 style="color:#0E4F40;margin:0 0 8px;">You already have an account</h2>
                  <p style="color:#374151;">Someone (hopefully you) tried to create a lab2date account with this address, but it already has one.</p>
                  <p style="color:#374151;"><a href="${SITE_URL}/auth/sign-in">Sign in</a>, or <a href="${SITE_URL}/auth/forgot-password">reset your password</a> if you don't remember it.</p>
                  <p style="color:#6b7280;font-size:13px;">If this wasn't you, you can safely ignore this email — nothing has changed.</p>
                </div>
              `,
              text: `This address already has a lab2date account. Sign in at ${SITE_URL}/auth/sign-in or reset your password at ${SITE_URL}/auth/forgot-password.\n\nIf this wasn't you, ignore this email — nothing has changed.`,
            });
            return;
          }
        }
        await sendEmail({
          to: email,
          subject: `${otp} is your lab2date verification code`,
          html: `
            <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#0E4F40;margin:0 0 8px;">Confirm your email</h2>
              <p style="color:#374151;">Enter this code to finish creating your lab2date account:</p>
              <p style="font-size:34px;font-weight:800;letter-spacing:8px;color:#0E4F40;background:#f3f4f6;border-radius:12px;padding:16px;text-align:center;margin:20px 0;">${otp}</p>
              <p style="color:#6b7280;font-size:13px;">This code expires in 10 minutes. If you didn't sign up, you can safely ignore this email.</p>
            </div>
          `,
          text: `Your lab2date verification code is ${otp}. It expires in 10 minutes.`,
        });
      },
    }),
    nextCookies(), // must be last
  ],
});

export type Session = typeof auth.$Infer.Session;
