'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

type Act = (fd: FormData) => Promise<{ ok: boolean; message: string }>;

/** Cancel / resume one e-mail broadcast. */
export function AnnouncementJobActions({ jobId, canRetry, cancel, retry }: { jobId: string; canRetry: boolean; cancel: Act; retry: Act }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const go = (act: Act, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    start(async () => {
      const fd = new FormData();
      fd.set('jobId', jobId);
      const r = await act(fd).catch(() => ({ ok: false, message: 'Failed — try again.' }));
      setMsg(r);
      router.refresh();
    });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {canRetry && (
          <button type="button" disabled={pending} onClick={() => go(retry)} className="h-8 px-3 rounded-full border border-border text-xs font-semibold hover:bg-muted">
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Resume'}
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => go(cancel, 'Stop this broadcast? E-mails already sent cannot be recalled.')}
          className="h-8 px-3 rounded-full border border-red-300 text-red-700 dark:text-red-300 text-xs font-semibold hover:bg-red-50 dark:hover:bg-red-950/40"
        >
          Stop
        </button>
      </div>
      {msg && <span className={`text-[11px] ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}`}>{msg.message}</span>}
    </div>
  );
}
