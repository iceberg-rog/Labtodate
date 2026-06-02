'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Lock, Loader2, CheckCircle2, AlertOctagon, ArrowLeft } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

export default function ResetPasswordInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) setError('No reset token in the link. Request a fresh reset email.');
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const { error: err } = await authClient.resetPassword({ newPassword: password, token });
      if (err) {
        setError(err.message || 'This reset link is invalid or expired. Request a fresh one.');
        return;
      }
      setDone(true);
      setTimeout(() => router.push('/auth/sign-in'), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset password.');
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-emerald-50 text-emerald-700">
            <CheckCircle2 className="h-5 w-5" />
          </span>
          <h1 className="text-xl font-bold tracking-tight">Password updated</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-3">
          You&apos;re all set. Sending you to sign-in…
        </p>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-900">
        <div className="flex items-center gap-3 mb-2">
          <AlertOctagon className="h-5 w-5" />
          <h1 className="font-bold">Reset link missing</h1>
        </div>
        <p className="text-sm">
          This page expects a <code className="font-mono">?token=…</code> in the URL. Click the link in your email,
          or request a fresh one.
        </p>
        <div className="mt-4">
          <Button asChild variant="outline" size="sm" className="rounded-full font-semibold">
            <Link href="/auth/forgot-password">Request a new link</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
      <h1 className="text-2xl font-bold tracking-tight">Set a new password</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Pick something at least 8 characters. You&apos;ll sign in with the new password.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="block text-sm font-medium mb-1.5">New password</span>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full h-11 pl-10 pr-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>
        </label>
        <label className="block">
          <span className="block text-sm font-medium mb-1.5">Confirm new password</span>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter the new password"
              className="w-full h-11 pl-10 pr-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>
        </label>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-xs">
            {error}
          </div>
        )}

        <Button type="submit" disabled={loading} size="lg" className="w-full rounded-xl font-semibold">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Set new password
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
