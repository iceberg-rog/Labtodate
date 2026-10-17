'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

type Action = (fd: FormData) => Promise<{ ok: boolean; message: string }>;

function useRun(action: Action) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const run = (fd: FormData) =>
    start(async () => {
      const r = await action(fd).catch(() => ({ ok: false, message: 'That didn’t work — please try again.' }));
      setMsg(r);
      if (r.ok) router.refresh();
    });
  return { pending, msg, run };
}

/** "Release" button on one suppressed address. */
export function ReleaseButton({ address, action, disabled }: { address: string; action: Action; disabled?: boolean }) {
  const { pending, msg, run } = useRun(action);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={disabled || pending}
        onClick={() => {
          const fd = new FormData();
          fd.set('address', address);
          fd.set('op', 'release');
          run(fd);
        }}
        className="inline-flex items-center gap-1 h-7 px-3 rounded-full border border-border text-xs font-semibold hover:bg-muted disabled:opacity-50"
      >
        {pending && <Loader2 className="h-3 w-3 animate-spin" />} Release
      </button>
      {msg && !msg.ok && <span className="text-xs text-red-700 dark:text-red-300">{msg.message}</span>}
    </span>
  );
}

/** "Check now" on the bounce mailbox (reads new bounce reports outside the 5-minute sweep). */
export function BounceCheckButton({ action, disabled }: { action: () => Promise<{ ok: boolean; message: string }>; disabled?: boolean }) {
  const { pending, msg, run } = useRun(() => action());
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={disabled || pending}
        onClick={() => run(new FormData())}
        data-testid="bounce-check-now"
        className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full border border-border text-sm font-semibold hover:bg-muted disabled:opacity-50"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />} Check now
      </button>
      {msg && (
        <span role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
          {msg.message}
        </span>
      )}
    </span>
  );
}

/** "Stop e-mailing an address" form (e.g. from a bounce report that reached the mailbox). */
export function SuppressForm({ action, disabled }: { action: Action; disabled?: boolean }) {
  const { pending, msg, run } = useRun(action);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set('op', 'suppress');
        run(fd);
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        name="address"
        type="email"
        required
        placeholder="name@example-domain.com"
        disabled={disabled}
        className="w-72 max-w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
      />
      <button
        type="submit"
        disabled={disabled || pending}
        className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full border border-border text-sm font-semibold hover:bg-muted disabled:opacity-50"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />} Stop e-mailing this address
      </button>
      {msg && (
        <span role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
          {msg.message}
        </span>
      )}
    </form>
  );
}
