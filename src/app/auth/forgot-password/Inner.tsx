'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Mail, Loader2, CheckCircle2, ArrowLeft } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

export default function ForgotPasswordInner() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Better-Auth: requests a reset email if the account exists. The
      // response is intentionally generic — we always render the same success
      // screen so account enumeration is impossible.
      await authClient.requestPasswordReset({
        email,
        redirectTo: '/auth/reset-password',
      });
      setSent(true);
    } catch {
      // Same generic success to avoid leaking which emails are registered.
      setSent(true);
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-emerald-50 text-emerald-700">
            <CheckCircle2 className="h-5 w-5" />
          </span>
          <h1 className="text-xl font-bold tracking-tight">Check your email</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
          If an account exists for <strong className="text-foreground">{email}</strong>, we just sent a password-reset link to it.
          The link expires in 1 hour. Don&apos;t forget to check spam.
        </p>
        <div className="mt-6 flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="rounded-full font-semibold">
            <Link href="/auth/sign-in"><ArrowLeft className="h-4 w-4" /> Back to sign-in</Link>
          </Button>
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setEmail('');
            }}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
          >
            Use a different address
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
      <h1 className="text-2xl font-bold tracking-tight">Forgot your password?</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Enter your account email and we&apos;ll send a link to set a new password.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="block text-sm font-medium mb-1.5">Email</span>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full h-11 pl-10 pr-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>
        </label>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-xs">
            {error}
          </div>
        )}

        <Button type="submit" disabled={loading || !email} size="lg" className="w-full rounded-xl font-semibold">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Send reset link
        </Button>
      </form>

      <div className="mt-6 pt-6 border-t border-border text-center">
        <Link href="/auth/sign-in" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to sign-in
        </Link>
      </div>
    </div>
  );
}
