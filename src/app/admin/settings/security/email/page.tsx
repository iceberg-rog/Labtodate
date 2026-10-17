import Link from 'next/link';
import { ChevronRight, MailCheck } from 'lucide-react';
import { requireCapability, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { getSecurityPolicy } from '@/lib/security/policy';
import { ANONYMOUS_TRIGGERS, EMAIL_TRIGGERS, SUPPRESS_ALL_SCOPE, disposableDomainCount, type EmailTrigger } from '@/lib/email-guard';
import type { BounceItem } from '@/lib/email-guard/bounce-mailbox';
import { ensureSettingsLoaded, settingRaw } from '@/lib/settings';
import { BounceCheckButton, ReleaseButton, SuppressForm } from '@/components/admin/SuppressionControls';
import { changeSuppression, checkBounceMailbox } from './actions';

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
const RUN_STATUS: Record<string, { label: string; cls: string }> = {
  OK: { label: 'OK', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  FAILED: { label: 'Failed', cls: 'bg-red-500/15 text-red-700 dark:text-red-300' },
  NOT_CONFIGURED: { label: 'Not set up', cls: 'bg-amber-500/15 text-amber-800 dark:text-amber-300' },
};
const VERDICT_LABEL: Record<string, string> = {
  permanent: 'address does not exist',
  temporary: 'temporary',
  policy: 'policy / spam filter',
  other: 'other failure',
  delivered: 'delivered',
};
const OUTCOME_LABEL: Record<string, string> = {
  suppressed: 'suppressed',
  'already-suppressed': 'already suppressed',
  counted: 'counted',
  ignored: 'not counted',
  unmatched: 'left unread',
};

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

  await ensureSettingsLoaded();
  const [byTrigger, topDomains, refused, suppressed, runs, lastGoodRun, reportRuns] = await Promise.all([
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
    prisma.bounceScanRun.findMany({ orderBy: { startedAt: 'desc' }, take: 8 }),
    prisma.bounceScanRun.findFirst({ where: { status: 'OK' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
    prisma.bounceScanRun.findMany({ where: { reports: { gt: 0 } }, orderBy: { startedAt: 'desc' }, take: 20, select: { startedAt: true, items: true } }),
  ]);
  const lastRun = runs[0] ?? null;
  const bounceItems = reportRuns
    .flatMap((r) => ((r.items ?? []) as BounceItem[]).map((i) => ({ ...i, at: i.at ?? r.startedAt.toISOString() })))
    .slice(0, 50);
  const imapLogin = policy.MAIL_BOUNCE_IMAP_USER || settingRaw('SMTP_USER') || '(SMTP username not set)';
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

      <section className="rounded-2xl border border-border bg-card p-4 space-y-3" id="bounce-mailbox" data-testid="bounce-mailbox">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground">Bounce reports in the sending mailbox</h2>
            <p className="text-xs text-muted-foreground max-w-3xl">
              Mail servers like TransIP’s accept every address and e-mail a bounce report (“Undelivered Mail Returned to Sender”, “Mail delivery
              failed” …) to the sending mailbox later. When this is on, the security sweep reads new bounce reports every 5 minutes and stops e-mail
              to addresses that don’t exist. Only reports about an e-mail the site sent count; the mailbox’s other e-mails are left as they are.
            </p>
          </div>
          <BounceCheckButton action={checkBounceMailbox} disabled={!canEdit || !policy.MAIL_BOUNCE_IMAP_ENABLED} />
        </div>
        <p className="text-sm">
          {policy.MAIL_BOUNCE_IMAP_ENABLED ? (
            <>
              <span className="font-semibold text-emerald-700 dark:text-emerald-300">On</span> —{' '}
              <span className="font-mono text-xs break-all">
                {imapLogin} @ {policy.MAIL_BOUNCE_IMAP_HOST || '(no server)'}:{policy.MAIL_BOUNCE_IMAP_PORT}, folder {policy.MAIL_BOUNCE_IMAP_FOLDER}
              </span>
              {' · '}handled reports {policy.MAIL_BOUNCE_IMAP_DONE_FOLDER ? <>move to <span className="font-mono text-xs">{policy.MAIL_BOUNCE_IMAP_DONE_FOLDER}</span></> : 'are marked as read'}
              {policy.MAIL_BOUNCE_IMAP_MATCH_REQUIRED ? '' : ' · reports about any e-mail count (not only the site’s)'}
            </>
          ) : (
            <>
              <span className="font-semibold">Off</span> — bounce reports are only noticed when the mail server refuses an address while sending.
            </>
          )}{' '}
          <Link href="/admin/settings/security#mailguard" className="underline text-xs">Settings</Link>
        </p>

        {lastRun ? (
          <div className="rounded-xl border border-border p-3 space-y-2" data-testid="bounce-last-run">
            <p className="text-sm flex flex-wrap items-center gap-2">
              <span className="font-semibold">Last run</span>
              <span className="text-muted-foreground">{fmt(lastRun.startedAt)} · {lastRun.trigger === 'admin' ? 'checked by an admin' : 'security sweep'}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RUN_STATUS[lastRun.status]?.cls ?? ''}`}>{RUN_STATUS[lastRun.status]?.label ?? lastRun.status}</span>
            </p>
            {lastRun.error && <p className="text-sm text-red-700 dark:text-red-300 break-words">{lastRun.error}</p>}
            {lastRun.status !== 'OK' && (
              <p className="text-xs text-muted-foreground">Last successful run: {lastGoodRun ? fmt(lastGoodRun.startedAt) : 'never'}.</p>
            )}
            <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-center">
              <RunCount label="New e-mails" value={lastRun.checked} />
              <RunCount label="Bounce reports" value={lastRun.reports} />
              <RunCount label="Undeliverable" value={lastRun.permanent} />
              <RunCount label="Newly suppressed" value={lastRun.suppressed} />
              <RunCount label="Not counted" value={lastRun.ignored} />
              <RunCount label="Not the site’s e-mail" value={lastRun.unmatched} />
            </dl>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No run yet.</p>
        )}

        {runs.length > 1 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Earlier runs</summary>
            <ul className="mt-2 divide-y divide-border">
              {runs.slice(1).map((r) => (
                <li key={r.id} className="py-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span className="text-muted-foreground whitespace-nowrap">{fmt(r.startedAt)}</span>
                  <span className="font-semibold">{RUN_STATUS[r.status]?.label ?? r.status}</span>
                  <span>
                    {r.checked} new · {r.reports} reports · {r.suppressed} suppressed
                  </span>
                  {r.error && <span className="text-red-700 dark:text-red-300 break-words">{r.error}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}

        {bounceItems.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-xs" data-testid="bounce-reports">
              <thead>
                <tr className="text-left text-muted-foreground uppercase tracking-wider">
                  <th className="py-2 pr-3">Arrived</th>
                  <th className="py-2 pr-3">Address</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Means</th>
                  <th className="py-2">Done</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {bounceItems.map((i, n) => (
                  <tr key={`${i.at}-${i.address}-${n}`} className="align-top">
                    <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{i.at ? fmt(new Date(i.at)) : '—'}</td>
                    <td className="py-2 pr-3 font-mono break-all">{i.address}</td>
                    <td className="py-2 pr-3 font-mono">{i.status ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {VERDICT_LABEL[i.verdict] ?? i.verdict}
                      {i.diagnostic && <span className="block text-[11px] text-muted-foreground break-all">{i.diagnostic}</span>}
                    </td>
                    <td className="py-2">
                      <span className="font-semibold">{OUTCOME_LABEL[i.outcome] ?? i.outcome}</span>
                      {i.note && <span className="block text-[11px] text-muted-foreground">{i.note}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-4 space-y-3" id="suppressed">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground">Addresses that get no e-mail</h2>
        <p className="text-xs text-muted-foreground">
          Added automatically when an address is rejected permanently — by the mail server while sending, or in a bounce report read from
          the sending mailbox (above) — or by hand. Staff copies still go out. Releasing an address also resets its per-address limits.
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

function RunCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2 py-1.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-lg font-bold tabular-nums">{value}</dd>
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
