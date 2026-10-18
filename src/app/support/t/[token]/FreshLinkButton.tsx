'use client';

import { useState, useTransition } from 'react';
import { Loader2, Mail } from 'lucide-react';
import { requestFreshTicketLink } from './actions';

/** "Send me a new link" on the expired-link page (the link goes to the ticket's own address). */
export function FreshLinkButton({ token }: { token: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (result?.ok) {
    return (
      <p role="status" className="mt-8 rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300 px-4 py-3 text-sm">
        {result.message}
      </p>
    );
  }
  return (
    <div className="mt-8 space-y-3">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const fd = new FormData();
            fd.set('token', token);
            try {
              setResult(await requestFreshTicketLink(fd));
            } catch {
              setResult({ ok: false, message: 'That did not work. Please reload the page and try again.' });
            }
          })
        }
        className="inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-5 py-3 text-sm font-semibold disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
        Send me a new link
      </button>
      {result && !result.ok && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">{result.message}</p>
      )}
    </div>
  );
}
