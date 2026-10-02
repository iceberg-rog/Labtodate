import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { getServerSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { safeRedirect } from '@/lib/safe-redirect';
import { Button } from '@/components/ui/button';
import SetPasswordButton from './SetPasswordButton';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Email verified' };

/**
 * Where a magic link lands when it was the account's first verification and
 * the password chosen before it was removed (pre-account-takeover guard,
 * claimUnverifiedAccount in src/lib/auth.ts). Without it the owner only found
 * out on their next password sign-in, as a bare "Invalid email or password".
 */
export default async function EmailVerifiedPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  const session = await getServerSession();
  if (!session) redirect('/auth/sign-in');
  const raw = (await searchParams).redirect;
  const target = safeRedirect(typeof raw === 'string' ? raw : null);
  const next = target.startsWith('/auth/') ? '/auth/continue' : target;

  // Nothing to say once the account has a password again (or never had one).
  const credential = await prisma.account.findFirst({
    where: { userId: session.user.id, providerId: 'credential' },
    select: { password: true },
  });
  if (!credential || credential.password) redirect(next);

  return (
    <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 className="h-5 w-5" />
        </span>
        <h1 className="text-xl font-bold tracking-tight">Your email is verified</h1>
      </div>
      <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
        You&apos;re signed in as <strong className="text-foreground">{session.user.email}</strong>.
      </p>
      <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
        For your security, the password set on this account before the address was confirmed has been removed. To
        sign in with a password next time, set a new one. Until then you can sign in with an emailed sign-in link.
      </p>

      <div className="mt-6 space-y-3">
        <SetPasswordButton email={session.user.email} />
        <Button asChild variant="outline" size="lg" className="w-full rounded-xl font-semibold">
          <Link href={next}>
            Continue <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>

      <p className="text-xs text-muted-foreground mt-6">
        You can also do this any time with &ldquo;Forgot password&rdquo; on the sign-in page.
      </p>
    </div>
  );
}
