import Link from 'next/link';
import { ChevronRight, UserPlus } from 'lucide-react';
import { requireCapability, getAdminCaps } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { CAPABILITY_PRESETS, canGrantCapability, capsAllow } from '@/lib/capabilities';
import { getSecurityPolicy } from '@/lib/security/policy';
import { createStaffInvite, revokeStaffInvite } from './actions';
import { StaffInviteForm, RevokeInviteButton } from './StaffInviteForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Invite staff' };

const fmt = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });

export default async function StaffInvitePage() {
  await requireCapability('users:view', { redirectTo: '/admin/users/invite' });
  const caps = await getAdminCaps();
  const policy = await getSecurityPolicy();
  const canManage = capsAllow(caps, 'users:manage') && (!policy.ONLY_SUPER_ADMIN_CREATES_ADMINS || caps.includes('*'));
  const invites = await prisma.staffInvite.findMany({ orderBy: { createdAt: 'desc' }, take: 30 });
  const now = new Date();
  const presets = Object.entries(CAPABILITY_PRESETS).map(([key, p]) => ({
    key,
    label: p.label,
    grantable: p.caps.every((c) => canGrantCapability(caps, c)),
  }));

  return (
    <div className="space-y-6 max-w-3xl">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/admin/users" className="hover:text-foreground">Users</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">Invite staff</span>
      </nav>
      <div>
        <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <UserPlus className="h-7 w-7 text-primary" /> Invite staff
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          The person gets an e-mail link that only works when they are signed in with that address. On accepting they become
          an admin with the chosen permissions
          {policy.TWO_FACTOR_REQUIRED_ROLES.includes('ADMIN') ? ' and must set up an authenticator app first' : ''}. Links expire
          after {policy.STAFF_INVITE_TTL_HOURS} hours.
          {policy.ADMIN_EMAIL_DOMAINS ? ` Allowed domains: ${policy.ADMIN_EMAIL_DOMAINS}.` : ''}
        </p>
      </div>

      {canManage ? (
        <StaffInviteForm action={createStaffInvite} presets={presets} />
      ) : (
        <p className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 p-4 text-sm text-amber-900 dark:text-amber-300">
          {policy.ONLY_SUPER_ADMIN_CREATES_ADMINS ? 'Only a super-admin can invite staff (Settings → Security).' : 'Inviting staff needs the users:manage permission.'}
        </p>
      )}

      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground p-4 pb-2">Invitations</h2>
        {invites.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="invite-list">
            {invites.map((i) => {
              const state = i.acceptedAt ? 'accepted' : i.revokedAt ? 'withdrawn' : i.expiresAt < now ? 'expired' : 'open';
              return (
                <li key={i.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold">{i.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {CAPABILITY_PRESETS[i.preset]?.label ?? i.preset} · by {i.invitedByEmail} · {fmt(i.createdAt)}
                      {state === 'open' ? ` · expires ${fmt(i.expiresAt)}` : ''}
                      {i.acceptedAt ? ` · accepted ${fmt(i.acceptedAt)}` : ''}
                    </p>
                  </div>
                  <span
                    className={`text-[11px] font-bold rounded-full px-2 py-0.5 ${
                      state === 'open'
                        ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
                        : state === 'accepted'
                          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                          : 'bg-foreground/10 text-muted-foreground'
                    }`}
                  >
                    {state}
                  </span>
                  {state === 'open' && canManage && <RevokeInviteButton id={i.id} action={revokeStaffInvite} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
