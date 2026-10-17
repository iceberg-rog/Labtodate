import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { cronAuthorized } from '@/lib/security/cron-auth';
import { getSecurityPolicy } from '@/lib/security/policy';
import { alertSuperAdmins } from '@/lib/security/alerts';
import { formatBytes } from '@/lib/security/backup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * scripts/backup-v2.sh reports here (X-Cron-Secret): GET returns the backup
 * settings from Admin → Settings → Security (destination, retention, alert
 * addresses); POST records a run (start / finish) for the admin "last good
 * backup" tile and e-mails the alert list when a run fails.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = await getSecurityPolicy();
  return NextResponse.json({
    target: p.BACKUP_TARGET,
    keepDaily: p.BACKUP_KEEP_DAILY,
    keepMonthly: p.BACKUP_KEEP_MONTHLY,
    alertEmails: p.BACKUP_ALERT_EMAILS,
  });
}

const Body = z.object({
  runId: z.string().max(40).optional(),
  status: z.enum(['RUNNING', 'OK', 'FAILED']),
  host: z.string().max(120).optional(),
  target: z.string().max(300).optional(),
  archiveName: z.string().max(300).optional(),
  archiveBytes: z.coerce.number().int().nonnegative().optional(),
  dbBytes: z.coerce.number().int().nonnegative().optional(),
  mediaBytes: z.coerce.number().int().nonnegative().optional(),
  mediaObjects: z.coerce.number().int().nonnegative().optional(),
  sha256: z.string().max(80).optional(),
  verified: z.boolean().optional(),
  error: z.string().max(2000).optional(),
  log: z.string().max(20000).optional(),
});

export async function POST(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad request', issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  const b = parsed.data;
  const data = {
    status: b.status,
    host: b.host,
    target: b.target,
    archiveName: b.archiveName,
    archiveBytes: b.archiveBytes === undefined ? undefined : BigInt(b.archiveBytes),
    dbBytes: b.dbBytes === undefined ? undefined : BigInt(b.dbBytes),
    mediaBytes: b.mediaBytes === undefined ? undefined : BigInt(b.mediaBytes),
    mediaObjects: b.mediaObjects,
    sha256: b.sha256,
    verified: b.verified,
    error: b.error,
    log: b.log,
    finishedAt: b.status === 'RUNNING' ? undefined : new Date(),
  };
  const existing = b.runId ? await prisma.backupRun.findUnique({ where: { id: b.runId }, select: { id: true } }) : null;
  const run = existing
    ? await prisma.backupRun.update({ where: { id: existing.id }, data })
    : await prisma.backupRun.create({ data: { ...data, startedAt: new Date() } });

  if (b.status === 'FAILED') {
    const p = await getSecurityPolicy();
    const extra = p.BACKUP_ALERT_EMAILS.split(',').map((s) => s.trim()).filter(Boolean);
    await alertSuperAdmins(
      'Backup FAILED',
      [
        `The backup on ${b.host ?? 'the server'} failed: ${b.error ?? 'unknown error'}.`,
        `Destination: ${b.target ?? '(none)'}.`,
        'The site keeps running, but there is no fresh off-site copy until this is fixed. See /var/log/lab2date-backup.log and docs/BACKUPS.md.',
      ],
      '/admin/settings/security#backup-status',
      { onlyTo: extra.length ? extra : undefined },
    );
  }
  return NextResponse.json({
    ok: true,
    runId: run.id,
    summary: b.status === 'OK' ? `recorded ${formatBytes(b.archiveBytes ?? null)}` : b.status.toLowerCase(),
  });
}
