'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Mail, Lock, User as UserIcon, Loader2, ArrowRight } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { safeRedirect } from '@/lib/safe-redirect';
import {
  authErrorMessage,
  cleanName,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  NAME_MAX_LENGTH,
  NAME_RULE,
  PASSWORD_RULE,
} from '@/lib/auth-rules';
import { VerifyEmailStep, sendVerificationCode } from '../VerifyEmailStep';

export default function SignUpPage({ listings }: { listings: string }) {
  const params = useSearchParams();
  // Role-aware landing after the account is verified + signed in. Only a
  // same-origin relative path is honoured (blocks open-redirect phishing).
  const redirect = safeRedirect(params.get('redirect'));

  const [step, setStep] = useState<'form' | 'code'>('form');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  // Step 1 — create the account (no session yet, autoSignIn is off), then email
  // the 5-digit verification code and move to the code screen.
  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fullName = cleanName(name);
    if (!fullName) {
      setError(NAME_RULE);
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(PASSWORD_RULE);
      return;
    }
    setLoading(true);
    const { error: signErr } = await authClient.signUp.email({ name: fullName, email, password });
    if (signErr) {
      setLoading(false);
      setError(authErrorMessage(signErr, 'Could not create your account.'));
      return;
    }
    // Even if the code can't be sent (rate limit, mail outage) the user goes
    // to the code screen, where "Resend code" retries — never signed in with
    // an unverified address.
    const sendErr = await sendVerificationCode(email);
    setLoading(false);
    setCodeError(sendErr);
    setStep('code');
  }

  if (step === 'code') {
    return (
      <VerifyEmailStep
        email={email}
        password={password}
        name={cleanName(name) ?? undefined}
        redirect={redirect}
        title="Check your email"
        lead={
          <>
            We sent a 5-digit code to <strong className="text-foreground">{email}</strong>. If this address
            already has a lab2date account, we emailed you sign-in instructions instead.
          </>
        }
        initialError={codeError}
        onBack={() => {
          setStep('form');
          setError(null);
        }}
        backLabel="Use a different email"
      />
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Browse {listings && listings !== '0' ? `${listings} ` : 'lab '}instruments, request quotes, and track orders — all in one place.
        </p>
      </div>

      <form onSubmit={handleSignup} className="space-y-4 rounded-2xl border bg-card p-6 shadow-sm">
        <div>
          <label htmlFor="name" className="text-sm font-medium block mb-1.5">Full name</label>
          <div className="relative">
            <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              id="name"
              type="text"
              required
              maxLength={NAME_MAX_LENGTH}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dr. Jane Doe"
              className="w-full h-10 pl-10 pr-3 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div>
          <label htmlFor="email" className="text-sm font-medium block mb-1.5">Work email</label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@university.edu"
              className="w-full h-10 pl-10 pr-3 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div>
          <label htmlFor="password" className="text-sm font-medium block mb-1.5">Password</label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              id="password"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              className="w-full h-10 pl-10 pr-3 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800 rounded-md px-3 py-2">{error}</p>
        )}

        <Button type="submit" disabled={!name.trim() || !email || password.length < MIN_PASSWORD_LENGTH || loading} className="w-full">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Create account <ArrowRight className="h-4 w-4" /></>}
        </Button>

        <p className="text-xs text-muted-foreground text-center">
          By creating an account, you agree to our{' '}
          <Link href="/legal/terms" className="underline hover:text-foreground">Terms</Link> and{' '}
          <Link href="/legal/privacy" className="underline hover:text-foreground">Privacy Policy</Link>.
        </p>
      </form>

      <p className="text-sm text-center text-muted-foreground mt-6">
        Already have an account?{' '}
        <Link href={`/auth/sign-in${redirect !== '/auth/continue' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`} className="text-primary font-medium underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
