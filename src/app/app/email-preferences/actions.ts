'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth-server';
import { setMarketingConsent } from '@/lib/security/marketing';
import { clientIpFrom } from '@/lib/ratelimit';
import { audit } from '@/lib/observability';

/** The signed-in person's own marketing e-mail choice (consent is logged with time, IP and source). */
export async function saveMarketingPreference(on: boolean): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ redirectTo: '/app/email-preferences' });
  const h = await headers();
  await setMarketingConsent({ userId: session.user.id, email: session.user.email }, !!on, 'preferences', {
    ip: clientIpFrom(h),
    userAgent: h.get('user-agent'),
  });
  await audit(on ? 'marketing.opt_in' : 'marketing.opt_out', session.user.id, 'preferences page');
  revalidatePath('/app/email-preferences');
  return { ok: true, message: on ? 'Saved — you will receive offers and news.' : 'Saved — no more offers or news.' };
}
