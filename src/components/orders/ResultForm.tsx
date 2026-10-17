'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * Buyer-side <form> for server actions that return `{ ok, message }`: shows
 * the outcome right under the controls (never a silent failure), keeps what
 * was typed when the server refuses, ignores a second submit while one runs,
 * and refreshes the page data after a success. `maxTotalBytes` refuses files
 * that together exceed one upload before anything is sent.
 */
export function ResultForm({
  action,
  className,
  children,
  submitLabel,
  submitClassName,
  confirmText,
  maxTotalBytes,
  resetOnSuccess = false,
  testId,
}: {
  /** `flash`: on success the page is reloaded with ?flash=<code> (a fixed message
   *  the page renders) — for forms that disappear once the action landed. */
  action: (fd: FormData) => Promise<{ ok: boolean; message: string; flash?: string }>;
  className?: string;
  children: React.ReactNode;
  submitLabel: string;
  submitClassName?: string;
  confirmText?: string;
  maxTotalBytes?: number;
  resetOnSuccess?: boolean;
  testId?: string;
}) {
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData(e.currentTarget);
    if (maxTotalBytes) {
      const total = fd.getAll('files').reduce((a, f) => a + (typeof f === 'string' ? 0 : f.size), 0);
      if (total > maxTotalBytes) {
        setMsg({ ok: false, text: `The files are ${(total / 1048576).toFixed(1)} MB together — one upload can be at most ${(maxTotalBytes / 1048576).toFixed(0)} MB. Send fewer or smaller photos now and add the rest afterwards.` });
        return;
      }
    }
    if (confirmText && !window.confirm(confirmText)) return;
    setMsg(null);
    start(async () => {
      try {
        const r = await action(fd);
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) {
          if (resetOnSuccess) ref.current?.reset();
          if (r.flash) router.replace(`${window.location.pathname}?flash=${encodeURIComponent(r.flash)}`, { scroll: false });
          router.refresh();
        }
      } catch {
        setMsg({ ok: false, text: 'That did not work — the request failed. Reload the page to check, then try again.' });
      }
    });
  }

  return (
    <form ref={ref} onSubmit={onSubmit} className={className} data-testid={testId}>
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className={submitClassName ?? 'inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-2 text-xs font-bold hover:bg-primary/90 disabled:opacity-60'}
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {submitLabel}
        </button>
      </div>
      {msg && (
        <p
          role={msg.ok ? 'status' : 'alert'}
          className={`text-sm rounded-lg px-3 py-2 border [overflow-wrap:anywhere] ${msg.ok ? 'text-emerald-800 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800' : 'text-red-800 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-950/40 dark:border-red-800'}`}
        >
          {msg.text}
        </p>
      )}
    </form>
  );
}
