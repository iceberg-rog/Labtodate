'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStepUp, type MaybeStepUp } from '@/components/security/useStepUp';

/** "Delete these N accounts" for Admin → Users → Unverified accounts (after the preview). */
export function UnverifiedPurgePanel({
  total,
  filter,
  action,
}: {
  total: number;
  filter: { days: number; from: string; domain: string };
  action: (fd: FormData) => Promise<MaybeStepUp>;
}) {
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [pending, start] = useTransition();
  const [checked, setChecked] = useState(false);
  const [msg, setMsg] = useState<MaybeStepUp | null>(null);

  return (
    <div className="rounded-2xl border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/20 p-4 space-y-3" data-testid="purge-panel">
      {dialog}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
        <span>
          I checked the list: delete these <strong>{total}</strong> unverified account{total === 1 ? '' : 's'}. This can’t be undone; the
          addresses are kept in the audit log.
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          className="bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
          disabled={!checked || pending || total < 1}
          onClick={() => {
            setMsg(null);
            const fd = new FormData();
            fd.set('days', String(filter.days));
            fd.set('from', filter.from);
            fd.set('domain', filter.domain);
            fd.set('expected', String(total));
            start(async () => {
              const r = await run(() => action(fd)).catch(() => ({ ok: false, message: 'Deleting failed — please try again.' }));
              setMsg(r);
              if (r.ok) {
                setChecked(false);
                router.refresh();
              }
            });
          }}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete {total} account{total === 1 ? '' : 's'}
        </Button>
        {msg && (
          <p role={msg.ok ? 'status' : 'alert'} className={`text-sm font-semibold ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
            {msg.message}
          </p>
        )}
      </div>
    </div>
  );
}
