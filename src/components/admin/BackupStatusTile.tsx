import Link from 'next/link';
import { DatabaseBackup } from 'lucide-react';
import { backupHealth } from '@/lib/security/backup';

/** Read-only "last good backup" tile (super-admins / security:manage). */
export async function BackupStatusTile() {
  const h = await backupHealth().catch(() => null);
  if (!h) return null;
  const tone =
    h.state === 'ok'
      ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-300'
      : 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-300';
  return (
    <div className={`rounded-2xl border-2 p-4 lg:col-span-2 ${tone}`} data-testid="backup-status">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs uppercase tracking-[0.18em] font-bold inline-flex items-center gap-1.5">
          <DatabaseBackup className="h-3.5 w-3.5" /> Backups
        </p>
        <Link href="/admin/settings/security#backups" className="text-xs font-semibold underline underline-offset-2">
          Backup settings →
        </Link>
      </div>
      <p className="text-sm font-semibold mt-1.5">{h.summary}</p>
      {h.lastGood?.mediaObjects !== null && h.lastGood?.mediaObjects !== undefined && h.state === 'ok' && (
        <p className="text-xs mt-1 opacity-80">Database + {h.lastGood.mediaObjects} uploaded files, encrypted, stored off this server.</p>
      )}
    </div>
  );
}
