import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, type Session } from './auth';
import { prisma } from './db';
import { capsAllow, type Capability } from './capabilities';
import { rateLimit } from './ratelimit';

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

/**
 * The current session, re-read from the session row instead of trusting the
 * ≤60s cookie cache, and refusing suspended accounts — so a sign-out, revoked
 * session or suspension takes effect immediately. Behind getServerSession,
 * requireSession and the sign-in / sign-up pages' "already signed in"
 * redirect, which must all agree or they would bounce a user between them.
 * Cached per request (layout + page + capability checks share one lookup).
 */
export const getActiveSession = cache(async (): Promise<Session | null> => {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
  if (!session?.user.emailVerified) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { suspendedAt: true },
  });
  if (!user || user.suspendedAt) return null;
  return session;
});

/**
 * Require a session in a server component. Redirects to /auth/sign-in if missing.
 * Optionally checks role.
 */
export async function requireSession(opts?: {
  roles?: readonly ('BUYER' | 'SELLER' | 'ADMIN')[];
  redirectTo?: string;
}): Promise<Session> {
  const session = await getActiveSession();
  if (!session) {
    const signInUrl = new URL('/auth/sign-in', process.env.BETTER_AUTH_URL || 'http://localhost:3000');
    if (opts?.redirectTo) signInUrl.searchParams.set('redirect', opts.redirectTo);
    redirect(signInUrl.pathname + signInUrl.search);
  }
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
  await auth.api.requestPasswordReset({
    body: { email: user.email, redirectTo: '/auth/reset-password' },
    headers: await headers(),
  });
}

/** Fetch the current admin's capability set (empty if not an admin). */
export async function getAdminCaps(): Promise<string[]> {
  const session = await getServerSession();
  if (!session || session.user.role !== 'ADMIN') return [];
  const row = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { adminCaps: true },
  });
  return row?.adminCaps ?? [];
}

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
