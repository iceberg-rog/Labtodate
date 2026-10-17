'use server';

import { headers } from 'next/headers';
import { requireSession, getSessionSecurity } from '@/lib/auth-server';
import { confirmStepUpForCurrentSession } from '@/lib/security/stepup';
import { eraseAccount } from '@/lib/security/gdpr-erase';
import { clientIpFrom } from '@/lib/ratelimit';

/**
 * "Delete my account" (GDPR art. 17): the person confirms with their password
 * (or a code from their authenticator app when two-factor sign-in is on) and
 * types DELETE. The erasure keeps what tax law requires (lib/security/gdpr-erase.ts).
 */
export async function deleteMyAccount(input: { secret: string; confirm: string; reason?: string }): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ redirectTo: '/app/privacy/delete' });
  if ((input.confirm ?? '').trim().toUpperCase() !== 'DELETE') return { ok: false, message: 'Type DELETE to confirm.' };
  const sec = await getSessionSecurity();
  const check = await confirmStepUpForCurrentSession(String(input.secret ?? ''));
  if (!check.ok) {
    return { ok: false, message: check.message || (sec?.twoFactorEnabled ? 'That code is not right.' : 'That password is not right.') };
  }
  const ip = clientIpFrom(await headers());
  return eraseAccount(session.user.id, { kind: 'SELF', id: session.user.id, email: session.user.email, ip }, (input.reason ?? '').trim().slice(0, 300) || 'Deleted by the account owner');
}
