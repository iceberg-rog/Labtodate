'use client';

import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { confirmStepUp } from '@/app/auth/step-up/actions';

export type MaybeStepUp = { ok: boolean; message: string; stepUp?: true; method?: 'totp' | 'password' };

type Pending = {
  method: 'totp' | 'password';
  message: string;
  retry: () => Promise<MaybeStepUp>;
  resolve: (r: MaybeStepUp) => void;
};

/**
 * Wraps a server action that may answer "confirm first" (stepUp: true): shows
 * a dialog asking for the authenticator code (or password), confirms it on the
 * server, then runs the action again and returns its real result.
 *
 *   const { run, dialog } = useStepUp();
 *   const r = await run(() => setUserCaps(fd));
 *   …
 *   return <>{dialog}…</>;
 */
export function useStepUp() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async <T extends MaybeStepUp>(action: () => Promise<T>): Promise<T> => {
    const first = await action();
    if (!first || !first.stepUp) return first;
    return new Promise<T>((resolve) => {
      setCode('');
      setError(null);
      setPending({
        method: first.method ?? 'totp',
        message: first.message,
        retry: action as () => Promise<MaybeStepUp>,
        resolve: resolve as (r: MaybeStepUp) => void,
      });
      setTimeout(() => inputRef.current?.focus(), 50);
    });
  }, []);

  function cancel() {
    pending?.resolve({ ok: false, message: 'Not confirmed — nothing was changed.' });
    setPending(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // React events bubble through portals: without this the page form the
    // dialog was opened from would be submitted a second time.
    e.stopPropagation();
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    const r = await confirmStepUp(code).catch(() => ({ ok: false, message: 'Could not check the code — try again.' }));
    if (!r.ok) {
      setBusy(false);
      setError(r.message);
      return;
    }
    const result = await pending.retry().catch(() => ({ ok: false, message: 'The action failed — please try again.' }));
    setBusy(false);
    pending.resolve(result);
    setPending(null);
  }

  // Portalled to <body> (valid inside lists / tables) and isolated, so clicks
  // in the dialog never reach the row or card it was opened from.
  const dialog = pending && typeof document !== 'undefined' ? createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stepup-title"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') cancel();
      }}
    >
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-xl space-y-3">
        <div className="flex items-start justify-between gap-3">
          <h2 id="stepup-title" className="text-base font-bold inline-flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> Confirm it’s you
          </h2>
          <button type="button" onClick={cancel} aria-label="Cancel" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">{pending.message}</p>
        <input
          ref={inputRef}
          name="stepup-code"
          type={pending.method === 'password' ? 'password' : 'text'}
          inputMode={pending.method === 'password' ? undefined : 'numeric'}
          autoComplete={pending.method === 'password' ? 'current-password' : 'one-time-code'}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={pending.method === 'password' ? 'Your password' : '6-digit code or a recovery code'}
          className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm tracking-wide focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {error && (
          <p role="alert" className="text-xs font-semibold text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="outline" size="sm" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !code.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Confirm
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          After confirming, other dangerous actions won’t ask again for a few minutes.
        </p>
      </form>
    </div>,
    document.body,
  ) : null;

  return { run, dialog };
}
