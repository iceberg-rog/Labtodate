import Link from 'next/link';
import { ChevronRight, ShieldCheck, Smartphone, AlertTriangle } from 'lucide-react';
import { requireCapability, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { getSecurityPolicy } from '@/lib/security/policy';
import { buildPolicyFields } from '@/lib/security/policy-fields';
import { SecurityPolicyForm } from '@/components/admin/SecurityPolicyForm';
import { BackupStatusTile } from '@/components/admin/BackupStatusTile';
import { formatBytes } from '@/lib/security/backup';
import { saveSecurityPolicy } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Security settings' };

const fmt = (d: Date) =>
  d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });

export default async function SecuritySettingsPage() {
  await requireCapability('settings:view', { redirectTo: '/admin/settings/security' });
  const canEdit = await hasCapability('security:manage');
  // Who the admins are, and the security events (with IPs), only for those
  // who may see users / the audit log anyway.
  const canSeeAdmins = canEdit || (await hasCapability('users:view'));
  const canSeeEvents = canEdit || (await hasCapability('audit:view'));
  const policy = await getSecurityPolicy();
  const fields = buildPolicyFields(policy);

  const [admins, runs, events] = await Promise.all([
    prisma.user.findMany({
      where: canSeeAdmins ? { role: 'ADMIN' } : { id: '__none__' },
      orderBy: { email: 'asc' },
      select: { id: true, email: true, adminCaps: true, twoFactorEnabled: true, suspendedAt: true },
    }),
    prisma.backupRun.findMany({ orderBy: { startedAt: 'desc' }, take: 8 }),
    prisma.auditLog.findMany({
      where: {
        ...(canSeeEvents ? {} : { id: '__none__' }),
        OR: [
          { action: { startsWith: 'auth.' } },
          { action: { startsWith: 'security.' } },
          { action: { endsWith: '.refused' } },
          { action: { in: ['user.role', 'user.caps', 'user.2fa_reset', 'staff.invite', 'staff.invite.accepted'] } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
  ]);
  const twoFaRequired = policy.TWO_FACTOR_REQUIRED_ROLES.includes('ADMIN');
  const missing2fa = admins.filter((a) => !a.twoFactorEnabled && !a.suspendedAt);

  return (
    <div className="space-y-6 max-w-4xl">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/admin/settings" className="hover:text-foreground">Settings</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">Security</span>
      </nav>
      <div>
        <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <ShieldCheck className="h-7 w-7 text-primary" /> Security
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Two-factor sign-in, admin sessions, brute-force protection, marketing e-mail rules and backups. Every change is
          logged with its old and new value and e-mailed to all super-admins.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Link href="/admin/settings/security/email" className="inline-flex items-center h-8 px-3 rounded-full border border-border font-semibold hover:bg-muted">
            E-mail protection: what visitors triggered, held back, suppressed
          </Link>
          <Link href="/admin/users/unverified" className="inline-flex items-center h-8 px-3 rounded-full border border-border font-semibold hover:bg-muted">
            Unverified accounts
          </Link>
        </div>
      </div>

      {canSeeAdmins && (
      <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground inline-flex items-center gap-1.5">
          <Smartphone className="h-4 w-4" /> Admin accounts and two-factor sign-in
        </h2>
        {twoFaRequired && missing2fa.length > 0 && (
          <p className="text-xs text-amber-800 dark:text-amber-300 inline-flex items-start gap-1.5">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {missing2fa.length} admin{missing2fa.length === 1 ? ' has' : 's have'} no authenticator yet — they can’t open the admin
            until they set one up at their next sign-in.
          </p>
        )}
        <ul className="divide-y divide-border text-sm">
          {admins.map((a) => (
            <li key={a.id} className="py-2 flex items-center justify-between gap-3 flex-wrap">
              <Link href={`/admin/users/${a.id}`} className="font-medium hover:underline">
                {a.email}
              </Link>
              <span className="text-xs text-muted-foreground font-mono truncate max-w-[40%]">
                {a.adminCaps.includes('*') ? 'super-admin' : a.adminCaps.join(', ') || '(no permissions)'}
              </span>
              <span
                className={`text-[11px] font-bold rounded-full px-2 py-0.5 ${
                  a.suspendedAt
                    ? 'bg-foreground/10 text-muted-foreground'
                    : a.twoFactorEnabled
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                      : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                }`}
              >
                {a.suspendedAt ? 'suspended' : a.twoFactorEnabled ? 'authenticator ✓' : 'no authenticator'}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Your own authenticator and recovery codes: <Link href="/app/security" className="underline">Account security</Link>. New staff:{' '}
          <Link href="/admin/users/invite" className="underline">invite staff</Link>.
        </p>
      </section>
      )}

      <SecurityPolicyForm fields={fields} canEdit={canEdit} action={saveSecurityPolicy} />

      <section id="backup-status" className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground">Backup runs</h2>
        <BackupStatusTile />
        {runs.length > 0 ? (
          <div className="rounded-2xl border border-border bg-card overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground uppercase tracking-wider">
                  <th className="px-3 py-2">Started</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Archive</th>
                  <th className="px-3 py-2">Files</th>
                  <th className="px-3 py-2">Destination</th>
                  <th className="px-3 py-2">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 whitespace-nowrap">{fmt(r.startedAt)}</td>
                    <td className={`px-3 py-2 font-bold ${r.status === 'OK' ? 'text-emerald-700 dark:text-emerald-300' : r.status === 'FAILED' ? 'text-red-700 dark:text-red-300' : ''}`}>
                      {r.status}
                      {r.status === 'OK' && r.verified ? ' · verified' : ''}
                    </td>
                    <td className="px-3 py-2">{r.archiveBytes !== null ? formatBytes(Number(r.archiveBytes)) : '—'}</td>
                    <td className="px-3 py-2">{r.mediaObjects ?? '—'}</td>
                    <td className="px-3 py-2 font-mono">{r.target ?? '—'}</td>
                    <td className="px-3 py-2 text-red-700 dark:text-red-300">{r.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Backups run on the server from <code className="font-mono">scripts/backup-v2.sh</code> (database + uploaded files,
          encrypted, shipped off the server, verified). Set-up and restore steps: <code className="font-mono">docs/BACKUPS.md</code>.
          The settings above (destination, retention, alert) are read by the script at each run.
        </p>
      </section>

      {canSeeEvents && (
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground mb-3">Recent security events</h2>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="divide-y divide-border text-xs">
            {events.map((e) => (
              <li key={e.id} className="py-1.5 flex gap-3 flex-wrap">
                <span className="text-muted-foreground whitespace-nowrap">{fmt(e.createdAt)}</span>
                <code className="font-mono font-semibold">{e.action}</code>
                <span className="text-muted-foreground">{e.actorEmail ?? '—'}{e.ip ? ` · ${e.ip}` : ''}</span>
                <span className="break-all">{e.meta}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground mt-2">
          Full history: <Link href="/admin/audit" className="underline">Audit log</Link>. Times in Europe/Amsterdam.
        </p>
      </section>
      )}
    </div>
  );
}
