import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getActiveSession } from '@/lib/auth-server';
import { getMarketing } from '@/lib/marketing';
import { safeRedirect } from '@/lib/safe-redirect';
import { siteText, siteTexts } from '@/lib/site/content';
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
  // Admin → Site content → Forms & sign-up; the count-free helper text while nothing is listed.
  const hasListings = !!listings && listings !== '0';
  const [tx, intro] = await Promise.all([
    siteTexts(['forms.signup_title', 'forms.signup_ph_name', 'forms.signup_email_label', 'forms.signup_ph_email'] as const),
    hasListings ? siteText('forms.signup_intro', { 'stats.listings': listings }) : siteText('forms.signup_intro_empty'),
  ]);
  return (
    <Suspense>
      <SignUpForm
        texts={{
          title: tx['forms.signup_title'],
          intro,
          namePlaceholder: tx['forms.signup_ph_name'],
          emailLabel: tx['forms.signup_email_label'],
          emailPlaceholder: tx['forms.signup_ph_email'],
        }}
      />
    </Suspense>
  );
}
