import { ShieldCheck, MonitorSmartphone } from 'lucide-react';
import { requireSession, getSessionSecurity } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AccountSecurityPanel, SessionsActions } from './AccountSecurityPanel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Account security' };

function device(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

const fmt = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });

export default async function AccountSecurityPage() {
  const session = await requireSession({ redirectTo: '/app/security' });
  const sec = await getSessionSecurity();
  const [sessions, twoFactor] = await Promise.all([
    prisma.session.findMany({
      where: { userId: session.user.id, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, lastActiveAt: true, ipAddress: true, userAgent: true },
    }),
    prisma.twoFactor.findFirst({ where: { userId: session.user.id }, select: { verified: true } }),
  ]);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <ShieldCheck className="h-7 w-7 text-primary" /> Account security
        </h1>
        <p className="text-muted-foreground mt-1">Two-factor sign-in, recovery codes and the devices signed in to your account.</p>
      </div>

      <AccountSecurityPanel
        email={session.user.email}
        twoFactorEnabled={!!sec?.twoFactorEnabled && twoFactor?.verified !== false}
        twoFactorRequired={!!sec?.twoFactorRequired}
      />

      <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
        <h2 className="font-bold inline-flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4" /> Signed-in devices ({sessions.length})
        </h2>
        <ul className="divide-y divide-border text-sm" data-testid="session-list">
          {sessions.map((s) => (
            <li key={s.id} className="py-2.5 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="font-medium">
                  {device(s.userAgent)}
                  {s.id === sec?.sessionId && (
                    <span className="ml-2 text-[11px] font-bold rounded-full px-2 py-0.5 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                      this device
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  IP {s.ipAddress ?? 'unknown'} · signed in {fmt(s.createdAt)}
                  {s.lastActiveAt ? ` · last active ${fmt(s.lastActiveAt)}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <SessionsActions otherCount={sessions.filter((s) => s.id !== sec?.sessionId).length} />
        <p className="text-xs text-muted-foreground">Times in Europe/Amsterdam.</p>
      </section>
    </div>
  );
}
