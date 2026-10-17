import Link from 'next/link';
import { UserPlus } from 'lucide-react';
import { getActiveSession } from '@/lib/auth-server';
import { CAPABILITY_PRESETS } from '@/lib/capabilities';
import { lookupInvite } from '@/lib/security/staff-invites';
import { AcceptInvite } from './AcceptInvite';
import { SignOutLink } from '../two-factor/setup/SignOutLink';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Staff invitation', robots: { index: false } };

export default async function StaffInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token ?? '';
  const inv = await lookupInvite(token);
  const session = await getActiveSession();
  const back = `/auth/staff-invite?token=${encodeURIComponent(token)}`;

  return (
    <div className="rounded-2xl border bg-card p-6 shadow-sm space-y-4" data-testid="staff-invite">
      <h1 className="text-xl font-bold tracking-tight inline-flex items-center gap-2">
        <UserPlus className="h-5 w-5 text-primary" /> Staff invitation
      </h1>
      {inv.state === 'invalid' && <p className="text-sm text-muted-foreground">This invitation link is not valid. Ask for a new one.</p>}
      {inv.state === 'expired' && <p className="text-sm text-muted-foreground">This invitation for {inv.email} has expired. Ask for a new one.</p>}
      {inv.state === 'revoked' && <p className="text-sm text-muted-foreground">This invitation was withdrawn.</p>}
      {inv.state === 'accepted' && (
        <p className="text-sm text-muted-foreground">
          This invitation was already accepted. <Link href="/admin" className="underline">Open the admin</Link>.
        </p>
      )}
      {inv.state === 'open' && (
        <>
          <p className="text-sm">
            {inv.invitedByEmail} invited <strong>{inv.email}</strong> to the admin team as{' '}
            <strong>{CAPABILITY_PRESETS[inv.preset]?.label ?? inv.preset}</strong>.
          </p>
          {!session ? (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">Sign in with {inv.email} — or create an account with that address — then come back to this link.</p>
              <div className="flex gap-2 flex-wrap">
                <Link href={`/auth/sign-in?redirect=${encodeURIComponent(back)}`} className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-primary-foreground font-semibold">
                  Sign in
                </Link>
                <Link href={`/auth/sign-up?redirect=${encodeURIComponent(back)}`} className="h-9 px-4 inline-flex items-center rounded-full border border-border font-semibold">
                  Create account
                </Link>
              </div>
            </div>
          ) : session.user.email.toLowerCase() !== inv.email.toLowerCase() ? (
            <p className="text-sm text-red-700 dark:text-red-300">
              You are signed in as {session.user.email}, but this invitation is for {inv.email}. <SignOutLink /> and sign in with
              the invited address.
            </p>
          ) : (
            <AcceptInvite token={token} />
          )}
        </>
      )}
    </div>
  );
}
