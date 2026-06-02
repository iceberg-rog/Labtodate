import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { magicLink } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { prisma } from './db';
import { sendEmail } from './email';

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  appName: 'lab2date',

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 12, // raised from 8 (BUG-006) — payment-handling marketplace
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: 'Reset your lab2date password',
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;">
            <h2 style="color:#0E4F40;">Reset your password</h2>
            <p>Hi ${user.name || 'there'},</p>
            <p>We received a request to reset the password on your lab2date account. Click the button below — the link expires in 1 hour.</p>
            <p style="margin:24px 0;">
              <a href="${url}" style="background:#0E4F40;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
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

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh once per day
    cookieCache: {
      enabled: true,
      // Short cache so an admin role change (promote/ban/demote) takes
      // effect within ~1 min instead of being stale for 5.
      maxAge: 60, // 1 minute
    },
  },

  hooks: {
    // Block sign-in for suspended accounts before a session is issued.
    before: createAuthMiddleware(async (ctx) => {
      const path = ctx.path;
      const looksLikeSignIn =
        path.startsWith('/sign-in') ||
        path.startsWith('/magic-link') ||
        path === '/email-otp/verify';
      if (!looksLikeSignIn) return;
      const email =
        typeof ctx.body === 'object' && ctx.body && 'email' in ctx.body
          ? String((ctx.body as { email?: string }).email ?? '').toLowerCase()
          : '';
      if (!email) return;
      const user = await prisma.user.findUnique({
        where: { email },
        select: { suspendedAt: true, suspendedReason: true },
      });
      if (user?.suspendedAt) {
        throw new APIError('FORBIDDEN', {
          message: `Account suspended: ${user.suspendedReason || 'contact support'}`,
        });
      }
    }),
  } satisfies BetterAuthOptions['hooks'],

  plugins: [
    magicLink({
      expiresIn: 60 * 10, // 10 minutes
      sendMagicLink: async ({ email, url }) => {
        await sendEmail({
          to: email,
          subject: 'Your lab2date sign-in link',
          html: `
            <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
              <h2 style="color: #047857;">Sign in to lab2date</h2>
              <p>Click the link below to sign in. It expires in 10 minutes.</p>
              <p style="margin: 24px 0;">
                <a href="${url}"
                   style="background:#047857;color:white;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">
                  Sign in to lab2date
                </a>
              </p>
              <p style="color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore the email.</p>
            </div>
          `,
          text: `Sign in to lab2date: ${url}\n\nThis link expires in 10 minutes.`,
        });
      },
    }),
    nextCookies(), // must be last
  ],
});

export type Session = typeof auth.$Infer.Session;
