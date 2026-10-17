import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getActiveSession, getSessionSecurity } from '@/lib/auth-server';
import { auditAs } from '@/lib/observability';
import { clientIpFrom } from '@/lib/ratelimit';
import { getSecurityPolicy, STEP_UP_ACTION_LABELS, type StepUpAction } from './policy';
import { activeLock, clearBuckets, minutesUntil, recordCodeFailure } from './throttle';
import { alertSuperAdmins } from './alerts';

/**
 * Step-up re-authentication: before a dangerous admin action the person must
 * have confirmed a fresh authenticator code (or, without 2FA, their password)
 * on THIS session within STEP_UP_MAX_AGE_MIN. Which actions ask is a policy
 * (Settings → Security → STEP_UP_ACTIONS).
 *
 * Server actions call {@link stepUpRequired} first and return its result
 * unchanged; the client (useStepUp / StepUpDialog) then asks for the code,
 * calls confirmStepUp and retries the action.
 */
export type StepUpRequired = { ok: false; stepUp: true; method: 'totp' | 'password'; message: string };

export async function stepUpRequired(action: StepUpAction): Promise<StepUpRequired | null> {
  const policy = await getSecurityPolicy();
  if (!policy.STEP_UP_ACTIONS.includes(action)) return null;
  const sec = await getSessionSecurity();
  const method = sec?.twoFactorEnabled ? 'totp' : 'password';
  if (sec?.stepUpAt && Date.now() - sec.stepUpAt.getTime() <= policy.STEP_UP_MAX_AGE_MIN * 60_000) return null;
  return {
    ok: false,
    stepUp: true,
    method,
    message:
      method === 'totp'
        ? `Confirm with a code from your authenticator app to ${STEP_UP_ACTION_LABELS[action].toLowerCase()}.`
        : `Confirm your password to ${STEP_UP_ACTION_LABELS[action].toLowerCase()}.`,
  };
}

/** Is the current session's step-up still fresh (for "verified for N more minutes" UI)? */
export async function stepUpFreshUntil(): Promise<Date | null> {
  const policy = await getSecurityPolicy();
  const sec = await getSessionSecurity();
  if (!sec?.stepUpAt) return null;
  const until = new Date(sec.stepUpAt.getTime() + policy.STEP_UP_MAX_AGE_MIN * 60_000);
  return until > new Date() ? until : null;
}

const stepUpKey = (userId: string) => `stepup:${userId}`;

/**
 * Check a code (TOTP or a one-time recovery code) or the password and mark
 * this session as freshly confirmed. Five wrong tries in 15 minutes pause
 * step-up for this account and alert the super-admins.
 */
export async function confirmStepUpForCurrentSession(secret: string): Promise<{ ok: boolean; message: string }> {
  const session = await getActiveSession();
  const sec = await getSessionSecurity();
  if (!session || !sec) return { ok: false, message: 'Your session has ended — sign in again.' };
  const h = await headers();
  const ip = clientIpFrom(h);
  const actor = { email: session.user.email, id: session.user.id, ip };
  const lock = await activeLock(stepUpKey(session.user.id));
  if (lock) {
    return { ok: false, message: `Too many wrong codes. Try again in ${minutesUntil(lock)} minutes.` };
  }
  const value = secret.trim();
  if (!value) return { ok: false, message: sec.twoFactorEnabled ? 'Enter the 6-digit code.' : 'Enter your password.' };

  let valid = false;
  let via = 'password';
  try {
    if (sec.twoFactorEnabled) {
      const code = value.replace(/\s+/g, '');
      if (/^\d{6}$/.test(code)) {
        via = 'authenticator code';
        await auth.api.verifyTOTP({ body: { code }, headers: h });
      } else {
        via = 'recovery code';
        await auth.api.verifyBackupCode({ body: { code, disableSession: true }, headers: h });
      }
      valid = true;
    } else {
      await auth.api.verifyPassword({ body: { password: value }, headers: h });
      valid = true;
    }
  } catch {
    valid = false;
  }

  if (!valid) {
    const lockedUntil = await recordCodeFailure(stepUpKey(session.user.id));
    await auditAs(actor, 'auth.stepup.failed', session.user.id, `wrong ${via}`);
    if (lockedUntil) {
      await auditAs(actor, 'auth.stepup.locked', session.user.id, `until ${lockedUntil.toISOString()}`);
      await alertSuperAdmins('Repeated wrong confirmation codes', [
        `${session.user.email} entered 5 wrong confirmation codes / passwords for a dangerous admin action within 15 minutes (IP ${ip}).`,
        `Confirmation is paused for this account until ${lockedUntil.toISOString()}. If this wasn’t them, suspend the account.`,
      ]);
      return { ok: false, message: `Too many wrong codes. Try again in ${minutesUntil(lockedUntil)} minutes.` };
    }
    return {
      ok: false,
      message: sec.twoFactorEnabled ? 'That code isn’t right. Use the current 6-digit code (or a recovery code).' : 'That password isn’t right.',
    };
  }
  await prisma.session.update({ where: { id: sec.sessionId }, data: { stepUpAt: new Date() } });
  await clearBuckets([stepUpKey(session.user.id)]);
  await auditAs(actor, 'auth.stepup', session.user.id, `confirmed with ${via}`);
  return { ok: true, message: 'Confirmed.' };
}
