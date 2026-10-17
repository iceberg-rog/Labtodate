import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { prisma } from '@/lib/db';
import { cronAuthorized } from '@/lib/security/cron-auth';
import { kickAnnouncementWorker } from '@/lib/security/announcements';
import { allowHit, purgeExpiredBuckets } from '@/lib/security/throttle';
import { backupHealth } from '@/lib/security/backup';
import { getSecurityPolicy } from '@/lib/security/policy';
import { alertSuperAdmins } from '@/lib/security/alerts';
import { purgeAbandoned } from '@/lib/security/unverified';
import { scanBounceMailbox } from '@/lib/email-guard/bounce-mailbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Every 5 minutes (docker-compose `cron` service):
 *  - resume announcement e-mail jobs left over by a restart;
 *  - purge expired rate-limit / lockout rows;
 *  - delete abandoned unverified accounts when UNVERIFIED_AUTO_PURGE is on;
 *  - read new bounce reports from the sending mailbox when
 *    MAIL_BOUNCE_IMAP_ENABLED is on (alert once a day after 3 failed runs);
 *  - alert (at most once a day) when the last good backup is too old or the
 *    latest backup failed.
 * Auth: header X-Cron-Secret = CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const pendingJobs = await prisma.announcementJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
  if (pendingJobs) after(() => kickAnnouncementWorker());

  const purged = await purgeExpiredBuckets().catch(() => -1);

  const policy = await getSecurityPolicy();
  let unverifiedDeleted = 0;
  if (policy.UNVERIFIED_AUTO_PURGE) {
    const r = await purgeAbandoned({ olderThanDays: policy.UNVERIFIED_PURGE_DAYS }, { actor: { email: 'system (security sweep)' }, source: 'sweep' }).catch(() => null);
    unverifiedDeleted = r?.deleted ?? 0;
  }

  const bounces = await scanBounceMailbox({ trigger: 'sweep', policy });
  let bounceAlert = false;
  if ((bounces.status === 'FAILED' || bounces.status === 'NOT_CONFIGURED') && policy.MAIL_GUARD_ALERTS) {
    // Only when it keeps failing (15 minutes), and once a day: one network blip is not news.
    const last = await prisma.bounceScanRun.findMany({ orderBy: { startedAt: 'desc' }, take: 3, select: { status: true } });
    if (last.length === 3 && last.every((r) => r.status !== 'OK')) {
      const { allowed } = await allowHit('alert:bounce-scan', 1, 24 * 3600_000);
      if (allowed) {
        await alertSuperAdmins(
          'Bounce reports can’t be read',
          [
            `The site could not read bounce reports from the sending mailbox for the last 15 minutes: ${bounces.error ?? bounces.message}`,
            'Until this is fixed, addresses that don’t exist are only noticed when the mail server refuses them while sending. Check Settings → Security (bounce mailbox) and Settings → Email (bounce mailbox password).',
          ],
          '/admin/settings/security/email#bounce-mailbox',
        );
        bounceAlert = true;
      }
    }
  }

  const health = await backupHealth();
  let backupAlert = false;
  if (health.state !== 'ok') {
    // Once a day per state, so a broken backup doesn't flood the inboxes.
    const { allowed } = await allowHit(`alert:backup:${health.state}`, 1, 24 * 3600_000);
    if (allowed) {
      const extra = policy.BACKUP_ALERT_EMAILS.split(',').map((s) => s.trim()).filter(Boolean);
      await alertSuperAdmins('Backup problem', [health.summary, 'Check the backup log on the server (/var/log/lab2date-backup.log) and docs/BACKUPS.md.'], '/admin/settings/security#backup-status', {
        onlyTo: extra.length ? extra : undefined,
      });
      backupAlert = true;
    }
  }
  const bounceScan = { status: bounces.status, checked: bounces.checked, reports: bounces.reports, permanent: bounces.permanent, suppressed: bounces.suppressed };
  return NextResponse.json({ ok: true, pendingJobs, purgedBuckets: purged, unverifiedDeleted, bounceScan, bounceAlert, backup: health.state, backupAlert });
}
