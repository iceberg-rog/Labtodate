'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useStepUp, type MaybeStepUp } from '@/components/security/useStepUp';

/**
 * "Revert" in Settings → Change history. A revert is a change like any other,
 * so it passes the same gates as saving: bank / company / e-mail / payment and
 * security settings ask for a fresh authenticator code first (useStepUp).
 */
export function SettingRevertButton({
  changeId,
  confirmText,
  action,
}: {
  changeId: string;
  confirmText: string;
  action: (fd: FormData) => Promise<MaybeStepUp>;
}) {
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<MaybeStepUp | null>(null);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(confirmText)) return;
          const fd = new FormData();
          fd.set('changeId', changeId);
          setMsg(null);
          start(async () => {
            const r = await run(() => action(fd)).catch(() => ({ ok: false, message: 'Revert failed — please try again.' }));
            setMsg(r);
            if (r.ok) router.refresh();
          });
        }}
        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-border text-[11px] font-bold hover:bg-muted disabled:opacity-60"
      >
        {pending && <Loader2 className="h-3 w-3 animate-spin" />}
        Revert
      </button>
      {msg && (
        <span role="status" className={`text-[11px] font-semibold ${msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
          {msg.message}
        </span>
      )}
      {dialog}
    </span>
  );
}
