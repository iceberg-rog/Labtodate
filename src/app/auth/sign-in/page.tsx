import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getActiveSession } from '@/lib/auth-server';
import { safeRedirect } from '@/lib/safe-redirect';
import { authCaptchaFlags } from '@/lib/security/captcha';
import { getSecurityPolicy } from '@/lib/security/policy';
import { ensureSettingsLoaded } from '@/lib/settings';
import { siteName } from '@/lib/brand/identity';
import SignInForm from './SignInForm';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  // Already signed in: skip the form and go where they were heading.
  if (await getActiveSession()) {
    const raw = (await searchParams).redirect;
    const target = safeRedirect(typeof raw === 'string' ? raw : null);
    redirect(target.startsWith('/auth/') ? '/auth/continue' : target);
  }
  const [captcha, policy] = await Promise.all([authCaptchaFlags(), getSecurityPolicy(), ensureSettingsLoaded()]);
  return (
    <Suspense>
      <SignInForm captcha={captcha} site={siteName()} mailCooldownSec={policy.MAIL_ADDRESS_COOLDOWN_SEC} />
    </Suspense>
  );
}
