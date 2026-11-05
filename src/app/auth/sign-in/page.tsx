import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getActiveSession } from '@/lib/auth-server';
import { safeRedirect } from '@/lib/safe-redirect';
import { siteTexts } from '@/lib/site/content';
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
  // Admin → Site content → Forms & sign-up.
  const tx = await siteTexts(['forms.signin_title', 'forms.signin_intro', 'forms.signin_ph_email'] as const);
  return (
    <Suspense>
      <SignInForm texts={{ title: tx['forms.signin_title'], intro: tx['forms.signin_intro'], emailPlaceholder: tx['forms.signin_ph_email'] }} />
    </Suspense>
  );
}
