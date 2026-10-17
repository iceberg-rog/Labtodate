import Link from 'next/link';
import { ChevronLeft, ShieldAlert } from 'lucide-react';
import { requireSession, getSessionSecurity } from '@/lib/auth-server';
import { erasurePlan } from '@/lib/security/gdpr-erase';
import { DeleteAccountForm } from './DeleteAccountForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Delete my account' };

export default async function DeleteAccountPage() {
  const session = await requireSession({ redirectTo: '/app/privacy/delete' });
  const [plan, sec] = await Promise.all([erasurePlan(session.user.id), getSessionSecurity()]);
  return (
    <div className="space-y-6 max-w-2xl">
      <Link href="/app/profile" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ChevronLeft className="h-3 w-3" /> Profile
      </Link>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Delete my account</h1>
        <p className="text-muted-foreground mt-1">Your right to erasure (GDPR art. 17). Download a copy of your data first if you want one: <a href="/app/privacy/export" className="underline">Download my data</a>.</p>
      </div>

      <section className="rounded-2xl border border-border bg-card p-6 space-y-4 text-sm">
        <div>
          <h2 className="font-bold">What is removed</h2>
          <ul className="mt-2 space-y-1 list-disc pl-5 text-muted-foreground">{plan.removed.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
        <div>
          <h2 className="font-bold">What we must keep</h2>
          <ul className="mt-2 space-y-1 list-disc pl-5 text-muted-foreground">{plan.kept.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      </section>

      {plan.blockers.length ? (
        <section className="rounded-2xl border-2 border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 p-6 space-y-2 text-sm" data-testid="delete-blockers">
          <h2 className="font-bold inline-flex items-center gap-2 text-amber-900 dark:text-amber-200"><ShieldAlert className="h-4 w-4" /> Not possible yet</h2>
          <ul className="space-y-1 list-disc pl-5">{plan.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          <p className="text-muted-foreground">Questions? <Link href="/app/support" className="underline">Contact support</Link>.</p>
        </section>
      ) : (
        <section className="rounded-2xl border border-red-200 dark:border-red-900 bg-card p-6 space-y-4">
          <p className="text-sm">This cannot be undone. You are signed out everywhere and receive a confirmation by e-mail.</p>
          <DeleteAccountForm method={sec?.twoFactorEnabled ? 'totp' : 'password'} />
        </section>
      )}
    </div>
  );
}
