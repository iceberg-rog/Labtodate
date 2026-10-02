import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, type Session } from './auth';
import { prisma } from './db';
import { capsAllow, type Capability } from './capabilities';

/**
 * Read the current session in a server component / server action / route handler.
 * Returns null if not signed in, or if the account hasn't verified its email
 * (such sessions predate verification being enforced and must not be usable).
 * May be up to a minute stale (cookie cache) — see getActiveSession.
 */
export async function getServerSession(): Promise<Session | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user.emailVerified) return null;
  return session;
}

/**
 * Like getServerSession, but re-reads the session row instead of trusting the
 * ≤60s cookie cache, and refuses suspended accounts — so a sign-out, revoked
 * session or suspension takes effect immediately. Used by requireSession and
 * by the sign-in / sign-up pages' "already signed in" redirect, which must
 * agree with requireSession or the two would bounce a user between them.
 * Cached per request (layout + page both call requireSession).
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
