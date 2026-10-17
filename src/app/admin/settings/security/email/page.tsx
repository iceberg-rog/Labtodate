import Link from 'next/link';
import { ChevronRight, MailCheck } from 'lucide-react';
import { requireCapability, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { getSecurityPolicy } from '@/lib/security/policy';
import { ANONYMOUS_TRIGGERS, EMAIL_TRIGGERS, SUPPRESS_ALL_SCOPE, disposableDomainCount, type EmailTrigger } from '@/lib/email-guard';
import { ReleaseButton, SuppressForm } from '@/components/admin/SuppressionControls';
import { changeSuppression } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'E-mail protection' };

const fmt = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });
const STATUS_LABEL: Record<string, string> = {
  sent: 'sent',
  failed: 'mail server refused',
  not_configured: 'not configured',
  blocked: 'blocked domain',
  suppressed: 'suppressed address',
  throttled: 'held back (limit)',
};
const triggerLabel = (t: string | null) => (t && t in EMAIL_TRIGGERS ? EMAIL_TRIGGERS[t as EmailTrigger].label : t ?? '(before the guards)');

/**
 * Admin → Security → E-mail protection: what visitors made the site send,
 * what the guards (src/lib/email-guard) held back, and the addresses that
 * get no e-mail at all. The rules themselves are in Settings → Security.
 */
export default async function EmailProtectionPage() {
  await requireCapability('settings:view', { redirectTo: '/admin/settings/security/email' });
  const canEdit = await hasCapability('security:manage');
  const policy = await getSecurityPolicy();
  const day = new Date(Date.now() - 24 * 3600_000);
  const week = new Date(Date.now() - 7 * 24 * 3600_000);
  const anon = { in: ANONYMOUS_TRIGGERS as string[] };

  const [byTrigger, topDomains, refused, suppressed] = await Promise.all([
    prisma.emailLog.groupBy({ by: ['trigger', 'status'], where: { createdAt: { gte: day }, trigger: anon }, _count: { _all: true } }),
    prisma.emailLog.groupBy({
      by: ['toDomain'],
      where: { createdAt: { gte: week }, trigger: anon, status: 'sent' },
      _count: { _all: true },
      orderBy: { _count: { toDomain: 'desc' } },
      take: 12,
    }),
    prisma.emailLog.findMany({
      where: { status: { in: ['blocked', 'throttled', 'suppressed'] } },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { id: true, toAddr: true, subject: true, status: true, error: true, trigger: true, ip: true, createdAt: true },
    }),
    prisma.emailSuppression.findMany({ where: { scope: SUPPRESS_ALL_SCOPE }, orderBy: { createdAt: 'desc' }, take: 300 }),
  ]);
  const reasons = suppressed.length
    ? await prisma.auditLog.findMany({
        where: { action: 'email.suppressed', target: { in: suppressed.map((s) => s.email) } },
        orderBy: { createdAt: 'desc' },
        select: { target: true, meta: true },
      })
    : [];
  const reasonOf = new Map<string, string>();
  for (const r of reasons) if (r.target && !reasonOf.has(r.target)) reasonOf.set(r.target, r.meta ?? '');

  const totals = { sent: 0, held: 0 };
  const perTrigger = new Map<string, Record<string, number>>();
  for (const g of byTrigger) {
    const key = g.trigger ?? '';
    const row = perTrigger.get(key) ?? {};
    row[g.status] = (row[g.status] ?? 0) + g._count._all;
    perTrigger.set(key, row);
    if (g.status === 'sent') totals.sent += g._count._all;
    else if (['blocked', 'throttled', 'suppressed'].includes(g.status)) totals.held += g._count._all;
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/admin/settings" className="hover:text-foreground">Settings</Link>
        <ChevronRight className="h-3 w-3" />
        <Link href="/admin/settings/security" className="hover:text-foreground">Security</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">E-mail protection</span>
      </nav>
      <div>
        <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <MailCheck className="h-7 w-7 text-primary" /> E-mail protection
        </h1>
        <p className="text-muted-foreground mt-1 text-sm max-w-3xl">
          E-mails a visitor can make the site send without signing in — verification codes, sign-in and reset links, guest-form
          confirmations — are limited, and nothing is sent to blocked or throw-away domains or to addresses that bounced. Rules:{' '}
          <Link href="/admin/settings/security#mailguard" className="underline">Settings → Security → E-mails a visitor can trigger</Link>{' '}
          and <Link href="/admin/settings/security#captcha" className="underline">Bot check</Link>.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="mail-guard-summary">
        <Stat label="Sent, last 24 h" value={`${totals.sent}`} hint={`limit ${policy.MAIL_ANON_MAX_PER_HOUR} per hour`} />
        <Stat label="Held back, last 24 h" value={`${totals.held}`} hint="blocked, suppressed or over a limit" />
        <Stat label="Blocked domains" value={`${policy.MAIL_BLOCKED_DOMAINS.length}`} hint={policy.MAIL_BLOCK_DISPOSABLE ? `+ ${disposableDomainCount().toLocaleString('en-GB')} throw-away domains` : 'throw-away list off'} />
        <Stat label="Suppressed addresses" value={`${suppressed.length}`} hint={policy.MAIL_BOUNCE_SUPPRESS_AFTER > 0 ? `after ${policy.MAIL_BOUNCE_SUPPRESS_AFTER} rejection${policy.MAIL_BOUNCE_SUPPRESS_AFTER === 1 ? '' : 's'}` : 'bounce suppression off'} />
      </div>

      <section className="rounded-2xl border border-border bg-card overflow-x-auto">
        <h2 className="px-4 pt-4 text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground">Last 24 hours, by kind</h2>
        {perTrigger.size === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">None.</p>
        ) : (
          <table className="w-full min-w-[34rem] text-sm mt-2">
            <thead>
              <tr className="text-left text-xs text-muted-foreground uppercase tracking-wider">
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2 text-right">Sent</th>
                <th className="px-4 py-2 text-right">Held back</th>
                <th className="px-4 py-2 text-right">Mail server refused</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...perTrigger.entries()].map(([t, row]) => (
                <tr key={t}>
                  <td className="px-4 py-2">{triggerLabel(t)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.sent ?? 0}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{(row.blocked ?? 0) + (row.throttled ?? 0) + (row.suppressed ?? 0)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.failed ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {topDomains.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground mb-2">Recipient domains, last 7 days</h2>
          <ul className="flex flex-wrap gap-2 text-xs">
            {topDomains.map((d) => (
              <li key={d.toDomain ?? '-'} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1">
                <span className="font-mono">{d.toDomain ?? '?'}</span> <span className="font-bold">{d._count._all}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-card p-4 space-y-3" id="suppressed">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground">Addresses that get no e-mail</h2>
        <p className="text-xs text-muted-foreground">
          Added automatically when the mail server rejects an address permanently, or by hand (e.g. from a bounce report in the sending
          mailbox). Staff copies still go out. Releasing an address also resets its per-address limits.
        </p>
        <SuppressForm action={changeSuppression} disabled={!canEdit} />
        {suppressed.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {suppressed.map((s) => (
              <li key={s.email} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs break-all">{s.email}</span>
                <span className="text-xs text-muted-foreground">
                  {s.reason === 'BOUNCE' ? 'rejected by the mail server' : 'stopped by an admin'} · {fmt(s.createdAt)}
                </span>
                {reasonOf.get(s.email) && <span className="basis-full text-[11px] text-muted-foreground break-all">{reasonOf.get(s.email)}</span>}
                <ReleaseButton address={s.email} action={changeSuppression} disabled={!canEdit} />
              </li>
            ))}
          </ul>
        )}
        {!canEdit && <p className="text-xs text-muted-foreground">Read-only — changing this list needs the security:manage permission.</p>}
      </section>

      <section className="rounded-2xl border border-border bg-card overflow-x-auto" data-testid="mail-guard-refused">
        <h2 className="px-4 pt-4 text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground">Recently held back</h2>
        {refused.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nothing held back yet.</p>
        ) : (
          <table className="w-full min-w-[46rem] text-xs mt-2">
            <thead>
              <tr className="text-left text-muted-foreground uppercase tracking-wider">
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">To</th>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">Why</th>
                <th className="px-4 py-2">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {refused.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">{fmt(r.createdAt)}</td>
                  <td className="px-4 py-2 font-mono break-all">{r.toAddr}</td>
                  <td className="px-4 py-2">{triggerLabel(r.trigger)}</td>
                  <td className="px-4 py-2">
                    <span className="font-semibold">{STATUS_LABEL[r.status] ?? r.status}</span>
                    {r.error ? <span className="text-muted-foreground"> · {r.error}</span> : null}
                  </td>
                  <td className="px-4 py-2 font-mono">{r.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="text-[11px] text-muted-foreground">Times in Europe/Amsterdam. Every e-mail is also in the e-mail log with its kind and the requester’s IP.</p>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}
