'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail, Lock, Loader2, ArrowRight } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { magicLinkTargets, safeRedirect } from '@/lib/safe-redirect';
import { VerifyEmailStep, sendVerificationCode } from '../VerifyEmailStep';

// ?error= codes this page can receive: from a magic link (better-auth appends
// them to errorCallbackURL) or from the magic-link guard in src/lib/auth.ts.
const LINK_ERRORS: Record<string, string> = {
  INVALID_TOKEN: 'That sign-in link has expired or was already used. Enter your email below to get a new one.',
  EXPIRED_TOKEN: 'That sign-in link has expired or was already used. Enter your email below to get a new one.',
  new_user_signup_disabled: 'There’s no lab2date account for that email yet — create one with “Sign up” below.',
  ACCOUNT_SUSPENDED: 'This account is suspended. Contact support if you think this is a mistake.',
};

export default function SignInPage() {
  const router = useRouter();
  const params = useSearchParams();
  // Default to the role-aware dispatcher (/auth/continue) so admins land on
  // /admin and everyone else on /app. An explicit ?redirect= still wins, but
  // only if it's a same-origin relative path (blocks open-redirect phishing).
  const redirect = safeRedirect(params.get('redirect'));

  const [step, setStep] = useState<'form' | 'verify'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState<'password' | 'magic' | null>(null);
  const [error, setError] = useState<string | null>(() => {
    const code = params.get('error');
    return code ? (LINK_ERRORS[code] ?? 'That sign-in link couldn’t be used. Please sign in again.') : null;
  });
  const [codeError, setCodeError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading('password');
    // No callbackURL: we navigate ourselves, and better-auth would reject
    // (403 "Invalid callbackURL") targets it doesn't like.
    const { error: err } = await authClient.signIn.email({ email, password });
    if (err?.code === 'EMAIL_NOT_VERIFIED') {
      // Right password, but the address was never confirmed: confirm it now.
      const sendErr = await sendVerificationCode(email);
      setLoading(null);
      setCodeError(sendErr);
      setStep('verify');
      return;
    }
    setLoading(null);
    if (err) {
      setError(err.message || 'Sign-in failed. Check your email and password.');
      return;
    }
    router.push(redirect);
    router.refresh();
  }

  async function handleMagicLink() {
    if (!email) {
      setError('Enter your email first.');
      return;
    }
    setError(null);
    setLoading('magic');
    const { error: err } = await authClient.signIn.magicLink({ email, ...magicLinkTargets(redirect) });
    setLoading(null);
    if (err) {
      setError(err.message || 'Could not send the magic link.');
      return;
    }
    setMagicSent(true);
  }

  if (step === 'verify') {
    return (
      <VerifyEmailStep
        email={email}
        password={password}
        redirect={redirect}
        title="Confirm your email"
        lead={
          <>
            Your email address hasn&apos;t been confirmed yet. Enter the 5-digit code we sent to{' '}
            <strong className="text-foreground">{email}</strong> to finish signing in.
          </>
        }
        initialError={codeError}
        onBack={() => {
          setStep('form');
          setError(null);
        }}
        backLabel="Back to sign-in"
      />
    );
  }

  if (magicSent) {
    return (
      <div className="rounded-2xl border bg-card p-8 shadow-sm text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-accent/15 flex items-center justify-center text-accent mb-4">
          <Mail className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-bold tracking-tight">Check your email</h1>
        <p className="text-sm text-muted-foreground mt-2">
          We emailed <strong className="text-foreground">{email}</strong>. If it has a lab2date account, the email
          contains a sign-in link that expires in 10 minutes.
        </p>
        <Button variant="outline" onClick={() => setMagicSent(false)} className="mt-6 w-full">
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
        <p className="text-sm text-muted-foreground mt-1">Sign in to your lab2date account.</p>
      </div>

      <form onSubmit={handlePassword} className="space-y-4 rounded-2xl border bg-card p-6 shadow-sm">
        <div>
          <label htmlFor="email" className="text-sm font-medium block mb-1.5">Email</label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full h-10 pl-10 pr-3 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="password" className="text-sm font-medium">Password</label>
            <Link href="/auth/forgot-password" className="text-xs text-primary hover:underline">Forgot?</Link>
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              className="w-full h-10 pl-10 pr-3 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800 rounded-md px-3 py-2">{error}</p>
        )}

        <Button type="submit" disabled={!email || !password || loading !== null} className="w-full">
          {loading === 'password' ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Sign in <ArrowRight className="h-4 w-4" /></>}
        </Button>

        <div className="relative my-2">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-card px-3 text-xs text-muted-foreground">or</span>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={handleMagicLink}
          disabled={!email || loading !== null}
          className="w-full"
        >
          {loading === 'magic' ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Mail className="h-4 w-4" /> Email me a magic link</>}
        </Button>
      </form>

      <p className="text-sm text-center text-muted-foreground mt-6">
        Don&apos;t have an account?{' '}
        <Link href={`/auth/sign-up${redirect !== '/auth/continue' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`} className="text-primary font-medium underline-offset-4 hover:underline">
          Sign up
        </Link>
      </p>
    </>
  );
}
