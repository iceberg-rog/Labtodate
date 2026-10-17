'use server';

import { confirmStepUpForCurrentSession } from '@/lib/security/stepup';

/** Confirm a dangerous action with a fresh authenticator / recovery code (or password without 2FA). */
export async function confirmStepUp(code: string): Promise<{ ok: boolean; message: string }> {
  return confirmStepUpForCurrentSession(String(code ?? '').slice(0, 200));
}
