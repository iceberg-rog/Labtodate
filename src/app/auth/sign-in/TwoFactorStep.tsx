'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldCheck, ArrowRight } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

/**
 * Second sign-in step for accounts with two-factor sign-in: the 6-digit code
 * from the authenticator app, or one of the one-time recovery codes.
 */
export function TwoFactorStep({ email, redirect, onBack }: { email: string; redirect: string; onBack: () => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const value = code.trim();
    const { error: err } =
      mode === 'totp'
        ? await authClient.twoFactor.verifyTotp({ code: value.replace(/\s+/g, '') })
        : await authClient.twoFactor.verifyBackupCode({ code: value });
    if (err) {
      setLoading(false);
      if (err.status === 429) setError(err.message || 'Too many wrong codes. Wait a few minutes and sign in again.');
      else if (err.code === 'INVALID_TWO_FACTOR_COOKIE' || /cookie/i.test(err.message ?? '')) {
        setError('This sign-in step expired (10 minutes). Go back and enter your password again.');
      } else {
        setError(mode === 'totp' ? 'That code isn’t right. Use the newest 6-digit code from your app.' : 'That recovery code isn’t valid (each one works once).');
      }
      return;
    }
    router.push(redirect);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border bg-card p-6 shadow-sm" data-testid="two-factor-step">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-bold tracking-tight">Two-factor sign-in</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        {mode === 'totp' ? (
          <>Enter the 6-digit code from your authenticator app for <strong className="text-foreground">{email}</strong>.</>
        ) : (
          <>Enter one of your recovery codes (looks like <code className="font-mono">AbC12-dEf34</code>). Each one works once.</>
        )}
      </p>
      <input
        ref={input}
        name={mode === 'totp' ? 'totp' : 'recovery'}
        inputMode={mode === 'totp' ? 'numeric' : 'text'}
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={mode === 'totp' ? '123456' : 'XXXXX-XXXXX'}
        className="w-full h-11 px-3 rounded-md border border-input bg-background text-lg tracking-[0.3em] text-center font-mono"
      />
      {error && (
        <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800 rounded-md px-3 py-2">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!code.trim() || loading} className="w-full">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Verify <ArrowRight className="h-4 w-4" /></>}
      </Button>
      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => {
            setMode(mode === 'totp' ? 'recovery' : 'totp');
            setCode('');
            setError(null);
          }}
        >
          {mode === 'totp' ? 'Lost your phone? Use a recovery code' : 'Use the authenticator app instead'}
        </button>
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  );
}
