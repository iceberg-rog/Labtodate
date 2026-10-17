import { Megaphone, Sparkles, AlertOctagon } from 'lucide-react';
import { requireCapability, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { emailTransportStatus } from '@/lib/email';
import { audienceBreakdown, legalIdentity } from '@/lib/security/marketing';
import { kickAnnouncementWorker } from '@/lib/security/announcements';
import { sendAnnouncement, cancelAnnouncementJob, retryAnnouncementJob } from '../actions';
import { AnnouncementComposer, type EmailReach } from '@/components/admin/AnnouncementComposer';
import { AnnouncementJobActions } from '@/components/admin/AnnouncementJobActions';
import { AutoRefresh } from '@/components/util/AutoRefresh';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Announcements' };

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  OFFER: Sparkles,
  ANNOUNCEMENT: Megaphone,
  SYSTEM: AlertOctagon,
};

const KIND_TINT: Record<string, string> = {
  OFFER: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  ANNOUNCEMENT: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  SYSTEM: 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
};

const STATUS_LABEL: Record<string, string> = {
  QUEUED: 'queued',
  RUNNING: 'sending…',
  DONE: 'finished',
  CANCELLED: 'cancelled',
  FAILED: 'stopped',
};

const fmt = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });

function reach(b: Awaited<ReturnType<typeof audienceBreakdown>>): EmailReach {
  return {
    emailable: b.emailable.length,
    noConsent: b.excluded.noConsent,
    unsubscribed: b.excluded.unsubscribed,
    notVerified: b.excluded.notVerified,
    placeholder: b.excluded.placeholder,
  };
}

export default async function AdminAnnouncementsPage() {
  await requireCapability('content:cms');
  await ensureSettingsLoaded();
  const canEmail = await hasCapability('marketing:send');
  const mail = emailTransportStatus();

  const [jobs, legacy, all, buyers, sellers] = await Promise.all([
    prisma.announcementJob.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
    // Broadcasts sent before the queue existed (audit row only).
    prisma.auditLog.findMany({
      where: { action: 'announcement.send', createdAt: { lt: (await prisma.announcementJob.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { target: true, meta: true, createdAt: true },
    }),
    Promise.all([audienceBreakdown('ALL', 'MARKETING'), audienceBreakdown('ALL', 'SERVICE')]),
    Promise.all([audienceBreakdown('BUYER', 'MARKETING'), audienceBreakdown('BUYER', 'SERVICE')]),
    Promise.all([audienceBreakdown('SELLER', 'MARKETING'), audienceBreakdown('SELLER', 'SERVICE')]),
  ]);
  // A queued job whose worker was lost (restart) resumes when someone looks.
  if (jobs.some((j) => j.status === 'QUEUED' || (j.status === 'RUNNING' && (!j.lockedUntil || j.lockedUntil < new Date())))) {
    void kickAnnouncementWorker();
  }
  const active = jobs.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING');

  return (
    <div className="space-y-6">
      {active && <AutoRefresh intervalMs={3000} />}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Announcements &amp; offers</h1>
        <p className="text-muted-foreground mt-1">
          In-app notice to buyers / suppliers, and optionally an e-mail to those who may receive it. Marketing e-mail only
          goes to people with consent (or customers under the soft opt-in rule — Settings → Security), always with an
          unsubscribe link and your company details.
        </p>
      </div>

      <AnnouncementComposer
        action={sendAnnouncement}
        audienceCounts={{ ALL: all[1].inApp, BUYER: buyers[1].inApp, SELLER: sellers[1].inApp }}
        emailReach={{
          ALL: { MARKETING: reach(all[0]), SERVICE: reach(all[1]) },
          BUYER: { MARKETING: reach(buyers[0]), SERVICE: reach(buyers[1]) },
          SELLER: { MARKETING: reach(sellers[0]), SERVICE: reach(sellers[1]) },
        }}
        mail={{ configured: mail.configured, label: mail.label, problem: mail.problem }}
        canEmail={canEmail}
        legalMissing={legalIdentity().missing}
      />

      <div>
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground mb-3">Recent sends ({jobs.length + legacy.length})</h2>
        {jobs.length + legacy.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center">
            <Megaphone className="h-7 w-7 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm font-semibold">Nothing sent yet</p>
            <p className="text-xs text-muted-foreground mt-1">Each announcement appears here with its in-app and e-mail progress.</p>
          </div>
        ) : (
          <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden" data-testid="announcement-jobs">
            {jobs.map((j) => {
              const Icon = KIND_ICON[j.kind] ?? Megaphone;
              const tint = KIND_TINT[j.kind] ?? 'bg-foreground/5 text-foreground border-border';
              const done = j.sent + j.failed + j.skipped;
              const pct = j.total ? Math.round((done / j.total) * 100) : 100;
              return (
                <li key={j.id} className="p-4 flex items-center gap-4 flex-wrap" data-job={j.id} data-status={j.status}>
                  <span className={`inline-flex items-center justify-center h-9 w-9 rounded-full border ${tint} flex-shrink-0`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">{j.title}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {j.kind.toLowerCase()} · {j.audience.toLowerCase()} · {fmt(j.createdAt)} · by {j.createdByEmail ?? '—'}
                    </p>
                    <p className="text-[11px] mt-1">
                      In-app: <strong>{j.inAppCount}</strong>
                      {j.emailRequested ? (
                        <>
                          {' '}· E-mail ({STATUS_LABEL[j.status] ?? j.status}): <strong>{j.sent}</strong> sent of {j.total}
                          {j.failed ? <span className="text-red-700 dark:text-red-300"> · {j.failed} failed</span> : null}
                          {j.skipped ? <> · {j.skipped} skipped</> : null}
                        </>
                      ) : (
                        ' · no e-mail'
                      )}
                    </p>
                    {j.emailRequested && j.total > 0 && (
                      <div className="mt-1.5 h-1.5 w-full max-w-sm rounded-full bg-foreground/10 overflow-hidden">
                        <div className={`h-full ${j.failed ? 'bg-amber-500' : 'bg-emerald-600'}`} style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    {j.lastError && (j.status === 'FAILED' || j.failed > 0) && (
                      <p className="text-[11px] text-red-700 dark:text-red-300 mt-1">Last error: {j.lastError}</p>
                    )}
                  </div>
                  {canEmail && j.emailRequested && ['QUEUED', 'RUNNING', 'FAILED'].includes(j.status) && (
                    <AnnouncementJobActions jobId={j.id} canRetry={j.status === 'FAILED'} cancel={cancelAnnouncementJob} retry={retryAnnouncementJob} />
                  )}
                </li>
              );
            })}
            {legacy.map((a, i) => (
              <li key={`legacy-${i}`} className="p-4 flex items-center gap-4 flex-wrap text-muted-foreground">
                <span className="inline-flex items-center justify-center h-9 w-9 rounded-full border border-border flex-shrink-0">
                  <Megaphone className="h-4 w-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate text-foreground">{a.meta}</p>
                  <p className="text-[11px] mt-0.5">{a.target?.toLowerCase()} · {fmt(a.createdAt)} · sent before progress tracking existed</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
