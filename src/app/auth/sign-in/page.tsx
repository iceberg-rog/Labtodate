import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getActiveSession } from '@/lib/auth-server';
import { safeRedirect } from '@/lib/safe-redirect';
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
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
