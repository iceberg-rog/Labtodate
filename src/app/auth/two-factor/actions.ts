'use server';

import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { getActiveSession, getSessionSecurity } from '@/lib/auth-server';
import { auditAs } from '@/lib/observability';
import { clientIpFrom } from '@/lib/ratelimit';
import { getSecurityPolicy } from '@/lib/security/policy';

/**
 * After the authenticator was verified (better-auth's after-hook in
 * src/lib/auth.ts has already signed out the other sessions, audited it and
 * e-mailed the owner): setting it up counts as a fresh confirmation for this
 * session, so the next dangerous admin action doesn't ask again right away.
 */
export async function finishTwoFactorSetup(): Promise<{ ok: boolean; message: string }> {
  const session = await getActiveSession();
  const sec = await getSessionSecurity();
  if (!session || !sec) return { ok: false, message: 'Your session ended — sign in again.' };
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { twoFactorEnabled: true } });
  if (!user?.twoFactorEnabled) return { ok: false, message: 'Two-factor sign-in is not switched on yet — enter a code from the app first.' };
  await prisma.session.update({ where: { id: sec.sessionId }, data: { stepUpAt: new Date() } });
  return { ok: true, message: 'Other devices that were signed in to your account have been signed out.' };
}

/** Whether the current account may switch 2FA off (not when its role requires it). */
export async function canDisableTwoFactor(): Promise<boolean> {
  const sec = await getSessionSecurity();
  if (!sec) return false;
  const policy = await getSecurityPolicy();
  return !policy.TWO_FACTOR_REQUIRED_ROLES.includes(sec.role);
}

/** Sign out every other device of the current account. */
export async function signOutOtherSessions(): Promise<{ ok: boolean; message: string }> {
  const session = await getActiveSession();
  const sec = await getSessionSecurity();
  if (!session || !sec) return { ok: false, message: 'Your session ended — sign in again.' };
  const r = await prisma.session.deleteMany({ where: { userId: session.user.id, NOT: { id: sec.sessionId } } });
  await auditAs({ email: session.user.email, id: session.user.id, ip: clientIpFrom(await headers()) }, 'auth.sessions.revoked_others', session.user.id, `${r.count}`);
  return { ok: true, message: r.count ? `Signed out ${r.count} other session${r.count === 1 ? '' : 's'}.` : 'No other sessions were signed in.' };
}

/** Sign out one specific device of the current account. */
export async function signOutSession(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = await getActiveSession();
  if (!session) return { ok: false, message: 'Your session ended — sign in again.' };
  const r = await prisma.session.deleteMany({ where: { id: String(sessionId), userId: session.user.id } });
  if (r.count) {
    await auditAs({ email: session.user.email, id: session.user.id, ip: clientIpFrom(await headers()) }, 'auth.session.revoked', session.user.id);
  }
  return r.count ? { ok: true, message: 'That device was signed out.' } : { ok: false, message: 'That session no longer exists.' };
}
