'use client';

import { useState } from 'react';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

const SEND_FAILED = 'We couldn’t send the email. Try “Forgot password” on the sign-in page instead.';

/** Mails the signed-in user a set-password (reset) link for their own address. */
export default function SetPasswordButton({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    setState('sending');
    try {
      const { error: err } = await authClient.requestPasswordReset({ email, redirectTo: '/auth/reset-password' });
      if (err) {
        setError(err.message || SEND_FAILED);
        setState('idle');
        return;
      }
      setState('sent');
    } catch {
      setError(SEND_FAILED);
      setState('idle');
    }
  }

  if (state === 'sent') {
    return (
      <div className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 px-3 py-2 text-sm">
        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          We emailed a link to set your password to <strong>{email}</strong>. It expires in 1 hour.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        onClick={send}
        disabled={state === 'sending'}
        size="lg"
        // The label is long for a phone-width card (222px at 320px): let it
        // wrap onto two lines instead of overflowing, and keep the icon visible.
        className="w-full h-auto min-h-12 py-3 px-4 sm:px-6 whitespace-normal text-center leading-snug rounded-xl font-semibold"
      >
        {state === 'sending' ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        ) : (
          <KeyRound className="h-4 w-4 shrink-0" />
        )}
        <span>Email me a link to set a password</span>
      </Button>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300 px-3 py-2 text-xs">
          {error}
        </div>
      )}
    </div>
  );
}
