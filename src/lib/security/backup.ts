import { prisma } from '@/lib/db';
import { getSecurityPolicy } from './policy';

export type BackupHealth = {
  state: 'ok' | 'stale' | 'failing' | 'never';
  lastGood: { finishedAt: Date; archiveBytes: number | null; target: string | null; verified: boolean; mediaObjects: number | null } | null;
  lastRun: { startedAt: Date; status: string; error: string | null } | null;
  maxAgeHours: number;
  /** One line for the admin tile / alert e-mail. */
  summary: string;
};

export function formatBytes(n: number | null | undefined): string {
  if (!n && n !== 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Backup status from the BackupRun rows written by scripts/backup-v2.sh. */
export async function backupHealth(now = new Date()): Promise<BackupHealth> {
  const policy = await getSecurityPolicy();
  const [good, last] = await Promise.all([
    prisma.backupRun.findFirst({ where: { status: 'OK' }, orderBy: { finishedAt: 'desc' } }),
    prisma.backupRun.findFirst({ orderBy: { startedAt: 'desc' } }),
  ]);
  const lastGood = good?.finishedAt
    ? {
        finishedAt: good.finishedAt,
        archiveBytes: good.archiveBytes === null ? null : Number(good.archiveBytes),
        target: good.target,
        verified: good.verified,
        mediaObjects: good.mediaObjects,
      }
    : null;
  const lastRun = last ? { startedAt: last.startedAt, status: last.status, error: last.error } : null;
  const maxAgeHours = policy.BACKUP_MAX_AGE_HOURS;
  if (!lastGood) {
    return {
      state: lastRun?.status === 'FAILED' ? 'failing' : 'never',
      lastGood,
      lastRun,
      maxAgeHours,
      summary: lastRun?.status === 'FAILED'
        ? `No backup has ever succeeded. Last attempt failed: ${lastRun.error ?? 'unknown error'}`
        : 'No backup has reported to this server yet — install scripts/backup-v2.sh (see docs/BACKUPS.md).',
    };
  }
  const ageH = (now.getTime() - lastGood.finishedAt.getTime()) / 3600_000;
  const failingSince = lastRun && lastRun.status === 'FAILED' && lastRun.startedAt > lastGood.finishedAt;
  const state = ageH > maxAgeHours ? 'stale' : failingSince ? 'failing' : 'ok';
  const age = ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))} min` : ageH < 48 ? `${Math.round(ageH)} h` : `${Math.round(ageH / 24)} days`;
  const summary =
    state === 'ok'
      ? `Last good backup ${age} ago (${formatBytes(lastGood.archiveBytes)}${lastGood.verified ? ', verified' : ''}${lastGood.target ? ` → ${lastGood.target}` : ''}).`
      : state === 'stale'
        ? `Last good backup is ${age} old — older than the ${maxAgeHours} h limit.${failingSince ? ` Latest attempt failed: ${lastRun?.error ?? 'unknown error'}` : ''}`
        : `The latest backup attempt failed: ${lastRun?.error ?? 'unknown error'}. Last good one was ${age} ago.`;
  return { state, lastGood, lastRun, maxAgeHours, summary };
}
