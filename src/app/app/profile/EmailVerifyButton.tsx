'use client';

import { useState, useTransition } from 'react';
import { Loader2, CheckCircle2, Mail } from 'lucide-react';
import { authClient } from '@/lib/auth-client';

export function EmailVerifyButton({ email, verified }: { email: string; verified: boolean }) {
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (verified) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-full px-2 py-0.5">
        <CheckCircle2 className="h-3 w-3" /> Verified
      </span>
    );
  }

  if (sent) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 rounded-full px-2 py-0.5">
        <Mail className="h-3 w-3" /> Verification email sent
      </span>
    );
  }

  function send() {
    setErr(null);
    start(async () => {
      const { error } = await authClient.sendVerificationEmail({
        email,
        callbackURL: '/app/profile',
      });
      if (error) setErr(error.message || 'Could not send verification email');
      else setSent(true);
    });
  }

  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-full px-2 py-0.5">
        Not verified
      </span>
      <button
        type="button"
        onClick={send}
        disabled={pending}
        className="text-xs font-semibold text-primary hover:underline disabled:opacity-50 inline-flex items-center gap-1"
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />}
        Send verification email
      </button>
      {err && <span className="text-xs text-red-700 dark:text-red-300">{err}</span>}
    </span>
  );
}
