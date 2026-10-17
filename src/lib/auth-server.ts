import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, type Session } from './auth';
import { prisma } from './db';
import { capsAllow, type Capability } from './capabilities';
import { rateLimit } from './ratelimit';
import { getSecurityPolicy } from './security/policy';
import { mailRefusals, type EmailBlockedError } from './email';

/**
 * Read the current session in a server component / server action / route handler.
 * Returns null if not signed in, if the account hasn't verified its email
 * (such sessions predate verification being enforced and must not be usable)
 * or if it is suspended. Same check as getActiveSession: server actions and
 * API routes authorize writes with this, and pages use it to decide whether to
 * show signed-in-only forms, so it must never trust the ≤60s cookie cache —
 * a signed-out or suspended session used to keep writing for up to a minute.
 */
export async function getServerSession(): Promise<Session | null> {
  return getActiveSession();
}

/** Security facts about the current session (see {@link getSessionSecurity}). */
export type SessionSecurity = {
  sessionId: string;
  role: string;
  /** The account's role must use an authenticator app (policy). */
  twoFactorRequired: boolean;
  twoFactorEnabled: boolean;
  /** Required but not set up yet: the account can only reach the set-up page. */
  twoFactorMissing: boolean;
  stepUpAt: Date | null;
};

const LAST_ACTIVE_WRITE_MS = 60_000;

type Active = { session: Session; security: SessionSecurity };

/**
 * The current session, re-read from the session row instead of trusting the
 * ≤60s cookie cache, and refusing suspended accounts — so a sign-out, revoked
 * session or suspension takes effect immediately. Also applies the admin
 * session policy (absolute lifetime + idle timeout from Settings → Security):
 * an expired admin session is deleted and treated as signed out.
 * Cached per request (layout + page + capability checks share one lookup).
 */
const loadActive = cache(async (): Promise<Active | null> => {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
  if (!session?.user.emailVerified) return null;
  const row = await prisma.session.findUnique({
    where: { id: session.session.id },
    select: {
      createdAt: true,
      lastActiveAt: true,
      stepUpAt: true,
      user: { select: { suspendedAt: true, role: true, twoFactorEnabled: true } },
    },
  });
  if (!row || row.user.suspendedAt) return null;
  const policy = await getSecurityPolicy();
  const now = Date.now();
  if (row.user.role === 'ADMIN') {
    const ageMs = now - row.createdAt.getTime();
    const idleMs = now - (row.lastActiveAt ?? row.createdAt).getTime();
    const tooOld = policy.ADMIN_SESSION_ABSOLUTE_HOURS > 0 && ageMs > policy.ADMIN_SESSION_ABSOLUTE_HOURS * 3600_000;
    const idle = policy.ADMIN_IDLE_TIMEOUT_MIN > 0 && idleMs > policy.ADMIN_IDLE_TIMEOUT_MIN * 60_000;
    if (tooOld || idle) {
      await prisma.session.deleteMany({ where: { id: session.session.id } }).catch(() => {});
      await prisma.auditLog
        .create({
          data: {
            actorEmail: session.user.email,
            actorId: session.user.id,
            action: tooOld ? 'auth.session.expired_absolute' : 'auth.session.expired_idle',
            target: session.user.id,
            meta: tooOld
              ? `admin session older than ${policy.ADMIN_SESSION_ABSOLUTE_HOURS}h`
              : `idle ${Math.round(idleMs / 60_000)} min (limit ${policy.ADMIN_IDLE_TIMEOUT_MIN})`,
          },
        })
        .catch(() => {});
      return null;
    }
  }
  if (!row.lastActiveAt || now - row.lastActiveAt.getTime() > LAST_ACTIVE_WRITE_MS) {
    await prisma.session
      .update({ where: { id: session.session.id }, data: { lastActiveAt: new Date(now) } })
      .catch(() => {});
  }
  const twoFactorRequired = policy.TWO_FACTOR_REQUIRED_ROLES.includes(row.user.role);
  const twoFactorEnabled = !!row.user.twoFactorEnabled;
  return {
    session,
    security: {
      sessionId: session.session.id,
      role: row.user.role,
      twoFactorRequired,
      twoFactorEnabled,
      twoFactorMissing: twoFactorRequired && !twoFactorEnabled,
      stepUpAt: row.stepUpAt,
    },
  };
});

export const getActiveSession = cache(async (): Promise<Session | null> => (await loadActive())?.session ?? null);

/** 2FA / step-up facts for the current session, or null when signed out. */
export async function getSessionSecurity(): Promise<SessionSecurity | null> {
  return (await loadActive())?.security ?? null;
}

/** Where an account that must set up 2FA is sent. */
export function twoFactorSetupUrl(redirectTo?: string): string {
  return `/auth/two-factor/setup${redirectTo ? `?redirect=${encodeURIComponent(redirectTo)}` : ''}`;
}

/**
 * Require a session in a server component. Redirects to /auth/sign-in if missing.
 * Optionally checks role. Accounts whose role must use two-factor sign-in
 * (Settings → Security) are sent to the set-up page until they have done so —
 * this is the gate in front of every /admin page and admin action.
 */
export async function requireSession(opts?: {
  roles?: readonly ('BUYER' | 'SELLER' | 'ADMIN')[];
  redirectTo?: string;
}): Promise<Session> {
  const active = await loadActive();
  if (!active) {
    const signInUrl = new URL('/auth/sign-in', process.env.BETTER_AUTH_URL || 'http://localhost:3000');
    if (opts?.redirectTo) signInUrl.searchParams.set('redirect', opts.redirectTo);
    redirect(signInUrl.pathname + signInUrl.search);
  }
  const { session, security } = active;
  if (security.twoFactorMissing) redirect(twoFactorSetupUrl(opts?.redirectTo));
  if (opts?.roles && !opts.roles.includes(session.user.role as 'BUYER' | 'SELLER' | 'ADMIN')) {
    redirect('/app?error=forbidden');
  }
  return session;
}

const ADMIN_RESET_WINDOW_MS = 15 * 60_000;

/**
 * Admin "Send reset email": mails the account a password-reset link through
 * better-auth in-process. Over HTTP it went through the public forgot-password
 * limit, keyed per client IP, where every server-side call shares one address —
 * so five resets locked the button for all admins. It has its own caps
 * instead: a few emails per account (so no inbox can be flooded) and a ceiling
 * per admin. Throws an Error with a readable message when refused or failed.
 */
export async function sendAdminPasswordReset(adminId: string, user: { id: string; email: string }): Promise<void> {
  try {
    await rateLimit(`admin-reset:by:${adminId}`, 50, ADMIN_RESET_WINDOW_MS);
  } catch {
    throw new Error('You’ve sent a lot of reset emails in the last 15 minutes. Wait a few minutes and try again.');
  }
  try {
    await rateLimit(`admin-reset:to:${user.id}`, 5, ADMIN_RESET_WINDOW_MS);
  } catch {
    throw new Error(
      `${user.email} was already sent several reset emails in the last 15 minutes. Ask them to check spam, or try again later.`,
    );
  }
  const refusals: EmailBlockedError[] = [];
  const h = await headers();
  await mailRefusals.run(refusals, () =>
    auth.api.requestPasswordReset({
      body: { email: user.email, redirectTo: '/auth/reset-password' },
      headers: h,
    }),
  );
  // better-auth swallows mail errors; the e-mail guards say why it was held back.
  if (refusals.length) throw new Error(`Not sent to ${user.email}: ${refusals[0].userMessage}`);
}

/**
 * Fetch the current admin's capability set (empty if not an admin, or if the
 * admin still has to set up two-factor sign-in — so API routes that check
 * capabilities refuse them too).
 */
export const getAdminCaps = cache(async (): Promise<string[]> => {
  const active = await loadActive();
  if (!active || active.session.user.role !== 'ADMIN' || active.security.twoFactorMissing) return [];
  const row = await prisma.user.findUnique({
    where: { id: active.session.user.id },
    select: { adminCaps: true },
  });
  return row?.adminCaps ?? [];
});

/** Non-throwing check: does the current admin have a capability? */
export async function hasCapability(cap: Capability | string): Promise<boolean> {
  return capsAllow(await getAdminCaps(), cap);
}

/**
 * Require a specific admin capability. Redirects to /admin?forbidden=<cap>
 * for logged-in admins missing the cap, or to sign-in if not logged in.
 */
export async function requireCapability(
  cap: Capability | string,
  opts?: { redirectTo?: string },
): Promise<Session> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: opts?.redirectTo ?? '/admin' });
  const caps = await getAdminCaps();
  if (!capsAllow(caps, cap)) {
    redirect(`/admin?forbidden=${encodeURIComponent(cap)}`);
  }
  return session;
}
