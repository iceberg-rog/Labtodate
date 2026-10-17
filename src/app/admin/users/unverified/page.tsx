import Link from 'next/link';
import { ChevronRight, MailWarning, Search } from 'lucide-react';
import { requireCapability, hasCapability } from '@/lib/auth-server';
import { getSecurityPolicy } from '@/lib/security/policy';
import { parseAbandonedFilter, previewAbandoned } from '@/lib/security/unverified';
import { UnverifiedPurgePanel } from '@/components/admin/UnverifiedPurgePanel';
import { purgeUnverifiedAccounts } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Unverified accounts' };

const fmt = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });

/**
 * Abandoned unverified accounts (src/lib/security/unverified.ts): preview with
 * a filter, then delete. Nothing is deleted by opening the page.
 */
export default async function UnverifiedAccountsPage(props: { searchParams: Promise<{ days?: string; from?: string; domain?: string }> }) {
  await requireCapability('users:view', { redirectTo: '/admin/users/unverified' });
  const canManage = await hasCapability('users:manage');
  const sp = await props.searchParams;
  const policy = await getSecurityPolicy();
  const filter = parseAbandonedFilter(sp, policy.UNVERIFIED_PURGE_DAYS);
  const preview = filter ? await previewAbandoned(filter) : null;
  const fromValue = filter?.createdFrom ? filter.createdFrom.toISOString().slice(0, 10) : '';

  return (
    <div className="space-y-6 max-w-5xl">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/admin/users" className="hover:text-foreground">Users</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">Unverified accounts</span>
      </nav>
      <div>
        <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <MailWarning className="h-7 w-7 text-primary" /> Unverified accounts
        </h1>
        <p className="text-muted-foreground mt-1 text-sm max-w-3xl">
          Accounts whose e-mail address was never confirmed. They can’t sign in, so they hold nothing — scripts create them to make the
          site mail strangers. Only plain buyer accounts with no order, quote, ticket, listing, message, review or billing details are
          listed; anything else is kept. Preview first, then delete. Automatic clean-up and the default age:{' '}
          <Link href="/admin/settings/security#accounts" className="underline">Settings → Security → Unverified accounts</Link>
          {policy.UNVERIFIED_AUTO_PURGE ? ' (automatic clean-up is on).' : ' (automatic clean-up is off).'}
        </p>
      </div>

      <form method="get" className="rounded-2xl border border-border bg-card p-4 flex flex-wrap items-end gap-3" aria-label="Filter">
        <label className="text-sm">
          <span className="block font-semibold mb-1">Older than</span>
          <span className="inline-flex items-center gap-2">
            <input name="days" type="number" min={0} max={3650} defaultValue={filter?.olderThanDays ?? policy.UNVERIFIED_PURGE_DAYS} className="w-24 h-9 px-3 rounded-lg border border-input bg-background text-sm" />
            <span className="text-xs text-muted-foreground">days</span>
          </span>
        </label>
        <label className="text-sm">
          <span className="block font-semibold mb-1">Created on or after</span>
          <input name="from" type="date" defaultValue={fromValue} className="h-9 px-3 rounded-lg border border-input bg-background text-sm" />
        </label>
        <label className="text-sm">
          <span className="block font-semibold mb-1">E-mail domain</span>
          <input name="domain" type="text" placeholder="txt.att.net" defaultValue={filter?.domain ?? ''} className="w-48 h-9 px-3 rounded-lg border border-input bg-background text-sm" />
        </label>
        <button type="submit" className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
          <Search className="h-4 w-4" /> Preview
        </button>
      </form>

      {!filter || !preview ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">Check the filter: days must be a whole number from 0 to 3650 and the date a valid date.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="unverified-summary">
            <Stat label="Would be deleted" value={preview.total} strong />
            <Stat label="E-mails the site sent them" value={preview.mailsSent} />
            <Stat label="Unverified but kept (activity attached)" value={preview.keptUnverified} />
          </div>

          {preview.domains.length > 0 && (
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground mb-2">By e-mail domain</h2>
              <ul className="flex flex-wrap gap-2 text-xs">
                {preview.domains.map((d) => (
                  <li key={d.domain}>
                    <Link
                      href={`/admin/users/unverified?days=${filter.olderThanDays}${fromValue ? `&from=${fromValue}` : ''}&domain=${encodeURIComponent(d.domain)}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 hover:bg-muted"
                    >
                      <span className="font-mono">{d.domain}</span> <span className="font-bold">{d.count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {canManage && preview.total > 0 && (
            <UnverifiedPurgePanel
              total={preview.total}
              filter={{ days: filter.olderThanDays, from: fromValue, domain: filter.domain ?? '' }}
              action={purgeUnverifiedAccounts}
            />
          )}
          {!canManage && preview.total > 0 && (
            <p className="text-xs text-muted-foreground">Deleting needs the users:manage permission.</p>
          )}

          <section className="rounded-2xl border border-border bg-card overflow-x-auto">
            {preview.rows.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">No abandoned unverified accounts match this filter.</p>
            ) : (
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground uppercase tracking-wider">
                    <th className="px-3 py-2">E-mail</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2 whitespace-nowrap">Created</th>
                    <th className="px-3 py-2 text-right">Mails sent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {preview.rows.map((u) => (
                    <tr key={u.id}>
                      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{u.email}</td>
                      <td className="px-3 py-2 max-w-[14rem] truncate" dir="auto" title={u.name}>{u.name}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{fmt(u.createdAt)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {u.mails}
                        {u.lastMail ? <span className="ml-1 text-[11px] text-amber-700 dark:text-amber-300">({u.lastMail})</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {preview.total > preview.rows.length && (
              <p className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
                Showing the newest {preview.rows.length} of {preview.total}. All {preview.total} are deleted.
              </p>
            )}
          </section>
        </>
      )}
      <p className="text-[11px] text-muted-foreground">Times in Europe/Amsterdam.</p>
    </div>
  );
}

function Stat({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 tabular-nums ${strong ? 'text-3xl font-bold' : 'text-2xl font-semibold'}`}>{value}</p>
    </div>
  );
}
