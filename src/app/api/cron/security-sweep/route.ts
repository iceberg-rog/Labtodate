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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Every 5 minutes (docker-compose `cron` service):
 *  - resume announcement e-mail jobs left over by a restart;
 *  - purge expired rate-limit / lockout rows;
 *  - delete abandoned unverified accounts when UNVERIFIED_AUTO_PURGE is on;
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
  return NextResponse.json({ ok: true, pendingJobs, purgedBuckets: purged, unverifiedDeleted, backup: health.state, backupAlert });
}
