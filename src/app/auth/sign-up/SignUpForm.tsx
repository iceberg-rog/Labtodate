'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail, Lock, User as UserIcon, Loader2, ArrowRight } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { safeRedirect } from '@/lib/safe-redirect';

const OTP_LEN = 5;

export default function SignUpPage() {
  const router = useRouter();
  const params = useSearchParams();
  // Role-aware landing after the account is verified + signed in. Only a
  // same-origin relative path is honoured (blocks open-redirect phishing).
  const redirect = safeRedirect(params.get('redirect'));

  const [step, setStep] = useState<'form' | 'code'>('form');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [digits, setDigits] = useState<string[]>(Array(OTP_LEN).fill(''));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  const code = digits.join('');

  // Step 1 — create the account (no session yet, autoSignIn is off), then email
  // the 5-digit verification code and move to the code screen.
  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: signErr } = await authClient.signUp.email({ name, email, password });
    if (signErr) {
      setLoading(false);
      setError(signErr.message || 'Could not create your account.');
      return;
    }
    const { error: otpErr } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: 'email-verification',
    });
    if (otpErr) {
      // Outbound email isn't configured/working yet — don't trap the user at a
      // code screen they can never clear. Sign them in and let them through.
      const { error: signInErr } = await authClient.signIn.email({ email, password });
      setLoading(false);
      if (!signInErr) {
        router.push(redirect);
        router.refresh();
        return;
      }
      setError('Account created — please sign in to continue.');
      router.push(`/auth/sign-in?redirect=${encodeURIComponent(redirect)}`);
      return;
    }
    setLoading(false);
    setStep('code');
    setTimeout(() => boxes.current[0]?.focus(), 50);
  }

  // Step 2 — verify the code, then sign the user in and land them.
  async function handleVerify(e?: React.FormEvent) {
    e?.preventDefault();
    if (code.length !== OTP_LEN || loading) return;
    setError(null);
    setLoading(true);
    const { error: verifyErr } = await authClient.emailOtp.verifyEmail({ email, otp: code });
    if (verifyErr) {
      setLoading(false);
      setError(verifyErr.message || 'That code is incorrect or expired. Check it or resend a new one.');
      setDigits(Array(OTP_LEN).fill(''));
      boxes.current[0]?.focus();
      return;
    }
    const { error: signInErr } = await authClient.signIn.email({ email, password });
    setLoading(false);
    if (signInErr) {
      router.push(`/auth/sign-in?redirect=${encodeURIComponent(redirect)}`);
      return;
    }
    router.push(redirect);
    router.refresh();
  }

  async function handleResend() {
    setError(null);
    setNotice(null);
    setLoading(true);
    const { error: otpErr } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: 'email-verification',
    });
    setLoading(false);
    if (otpErr) setError(otpErr.message || 'Could not resend the code.');
    else {
      setNotice(`A new code was sent to ${email}.`);
      setDigits(Array(OTP_LEN).fill(''));
      boxes.current[0]?.focus();
    }
  }

  function setBox(i: number, raw: string) {
    const v = raw.replace(/\D/g, '');
    const next = [...digits];
    if (v.length === 0) {
      next[i] = '';
      setDigits(next);
      return;
    }
    // Support typing a single digit (advance) — take the last char if replaced.
    next[i] = v[v.length - 1];
    setDigits(next);
    if (i < OTP_LEN - 1) boxes.current[i + 1]?.focus();
  }

  function onBoxKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      boxes.current[i - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      boxes.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < OTP_LEN - 1) {
      boxes.current[i + 1]?.focus();
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LEN);
    if (!text) return;
    e.preventDefault();
    const next = Array(OTP_LEN).fill('');
    for (let j = 0; j < text.length; j++) next[j] = text[j];
    setDigits(next);
    boxes.current[Math.min(text.length, OTP_LEN - 1)]?.focus();
  }

  if (step === 'code') {
    return (
      <>
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Mail className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Check your email</h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            We sent a 5-digit code to <strong className="text-foreground">{email}</strong>
          </p>
        </div>

        <form onSubmit={handleVerify} className="space-y-5 rounded-2xl border bg-card p-6 shadow-sm">
          <div className="flex justify-center gap-2 sm:gap-3" onPaste={onPaste}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => {
                  boxes.current[i] = el;
                }}
                inputMode="numeric"
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                maxLength={1}
                value={d}
                onChange={(e) => setBox(i, e.target.value)}
                onKeyDown={(e) => onBoxKeyDown(i, e)}
                onFocus={(e) => e.target.select()}
                aria-label={`Digit ${i + 1}`}
                className="h-14 w-12 sm:w-14 rounded-xl border border-input bg-background text-center text-2xl font-bold tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-shadow"
              />
            ))}
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800 rounded-md px-3 py-2 text-center">{error}</p>
          )}
          {notice && (
            <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800 rounded-md px-3 py-2 text-center">{notice}</p>
          )}

          <Button type="submit" disabled={code.length !== OTP_LEN || loading} className="w-full">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Verify &amp; continue <ArrowRight className="h-4 w-4" /></>}
          </Button>

          <div className="flex items-center justify-between text-xs pt-1">
            <button type="button" onClick={handleResend} disabled={loading} className="text-primary font-medium hover:underline disabled:opacity-50">
              Resend code
            </button>
            <button
              type="button"
              onClick={() => {
                setStep('form');
                setError(null);
                setNotice(null);
                setDigits(Array(OTP_LEN).fill(''));
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              Use a different email
            </button>
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Browse 12,000+ instruments, request quotes, and track orders — all in one place.
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
              minLength={12}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 12 characters"
              className="w-full h-10 pl-10 pr-3 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800 rounded-md px-3 py-2">{error}</p>
        )}

        <Button type="submit" disabled={!name || !email || password.length < 12 || loading} className="w-full">
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
