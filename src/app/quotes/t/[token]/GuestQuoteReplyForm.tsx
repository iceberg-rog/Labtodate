'use client';

import { useRef, useState, useTransition } from 'react';
import { Loader2, Send } from 'lucide-react';
import { guestReplyByQuoteToken } from './actions';

export function GuestQuoteReplyForm({ token }: { token: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  return (
    <form
      ref={ref}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        const fd = new FormData(e.currentTarget);
        const form = e.currentTarget;
        start(async () => {
          try {
            await guestReplyByQuoteToken(fd);
            form.reset();
          } catch (er) {
            if ((er as Error)?.message?.includes('NEXT_REDIRECT')) {
              form.reset();
              return;
            }
            setErr((er as Error)?.message ?? 'Send failed.');
          }
        });
      }}
      className="space-y-3"
    >
      <input type="hidden" name="token" value={token} />
      <textarea
        name="body"
        required
        minLength={2}
        rows={4}
        placeholder="Add a reply…"
        className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm resize-y focus:outline-none focus:border-primary"
      />
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex items-center justify-end">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-primary hover:bg-primary/90 text-primary-foreground px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Send className="h-4 w-4" /> Send reply</>}
        </button>
      </div>
    </form>
  );
}
