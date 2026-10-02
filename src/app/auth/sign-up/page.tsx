import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getActiveSession } from '@/lib/auth-server';
import { getMarketing } from '@/lib/marketing';
import { safeRedirect } from '@/lib/safe-redirect';
import SignUpForm from './SignUpForm';

export const metadata = { title: 'Sign up' };

export default async function SignUpPage({
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
  // Same live (or admin-set) catalogue count the header search shows.
  const { listings } = await getMarketing();
  return (
    <Suspense>
      <SignUpForm listings={listings} />
    </Suspense>
  );
}
