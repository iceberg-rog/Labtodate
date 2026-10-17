import { redirect } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { getActiveSession, getSessionSecurity } from '@/lib/auth-server';
import { safeRedirect } from '@/lib/safe-redirect';
import { TwoFactorSetup } from '@/components/security/TwoFactorSetup';
import { SignOutLink } from './SignOutLink';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Set up two-factor sign-in' };

/**
 * Forced set-up: accounts whose role must use an authenticator (Settings →
 * Security; admins by default) land here from every page until it is done.
 */
export default async function TwoFactorSetupPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  const raw = (await searchParams).redirect;
  const target = safeRedirect(typeof raw === 'string' ? raw : null);
  const session = await getActiveSession();
  if (!session) redirect(`/auth/sign-in?redirect=${encodeURIComponent(`/auth/two-factor/setup?redirect=${target}`)}`);
  const sec = await getSessionSecurity();
  if (sec?.twoFactorEnabled) redirect(target);
  const required = !!sec?.twoFactorRequired;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight inline-flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary" /> Set up two-factor sign-in
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          {required ? (
            <>
              Your account (<strong className="text-foreground">{session.user.email}</strong>) has access to the admin console,
              so it must be protected with an authenticator app. You can continue once this is done — it takes about a minute.
            </>
          ) : (
            <>Protect <strong className="text-foreground">{session.user.email}</strong> with a code from your phone at every sign-in.</>
          )}
        </p>
      </div>
      <TwoFactorSetup email={session.user.email} redirectTo={target} />
      <p className="text-xs text-muted-foreground mt-6 text-center">
        Not now? <SignOutLink />
      </p>
    </>
  );
}
