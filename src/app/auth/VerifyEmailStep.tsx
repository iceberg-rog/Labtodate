'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Loader2, ArrowRight } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { authErrorMessage } from '@/lib/auth-rules';
import { Button } from '@/components/ui/button';

const OTP_LEN = 5;

/** Email the 5-digit verification code. Returns a readable error, or null once sent. */
export async function sendVerificationCode(email: string): Promise<string | null> {
  const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'email-verification' });
  if (!error) return null;
  // 429 (rate limit) and 403 (suspended) carry a readable message; anything
  // else is a mail/server failure the user can only retry.
  if ((error.status === 429 || error.status === 403) && error.message) return error.message;
  return 'We couldn’t send the code just now. Wait a moment, then press “Resend code”.';
}

/**
 * The "enter the 5-digit code" screen. Verifying the code signs the browser in
 * (autoSignInAfterVerification), so on success it just navigates on. Callers
 * send the first code themselves and pass any failure as `initialError`; the
 * user is never let in without a verified address.
 */
export function VerifyEmailStep({
  email,
  password,
  name,
  redirect,
  title,
  lead,
  initialError,
  onBack,
  backLabel,
}: {
  email: string;
  password: string;
  /** Sign-up only: the name typed on the form. */
  name?: string;
  redirect: string;
  title: string;
  lead: React.ReactNode;
  initialError?: string | null;
  onBack: () => void;
  backLabel: string;
}) {
  const router = useRouter();
  const [digits, setDigits] = useState<string[]>(Array(OTP_LEN).fill(''));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  const code = digits.join('');

  useEffect(() => {
    boxes.current[0]?.focus();
  }, []);

  async function handleVerify(e?: React.FormEvent) {
    e?.preventDefault();
    if (code.length !== OTP_LEN || loading) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    // The password (and sign-up name) ride along with the code: on an
    // address's first verification the server keeps only what the person
    // holding the code chose and signs everyone else out
    // (claimUnverifiedAccount in src/lib/auth.ts).
    const { error: verifyErr } = await authClient.emailOtp.verifyEmail(
      { email, otp: code },
      { body: { password, ...(name ? { name } : {}) } },
    );
    if (verifyErr) {
      setLoading(false);
      setError(authErrorMessage(verifyErr, 'That code is incorrect or expired. Check it or resend a new one.'));
      setDigits(Array(OTP_LEN).fill(''));
      boxes.current[0]?.focus();
      return;
    }
    router.push(redirect);
    router.refresh();
  }

  async function handleResend() {
    setError(null);
    setNotice(null);
    setLoading(true);
    const sendErr = await sendVerificationCode(email);
    setLoading(false);
    if (sendErr) setError(sendErr);
    else {
      setNotice(`We sent another email to ${email}.`);
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

  return (
    <>
      <div className="mb-6 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Mail className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1.5">{lead}</p>
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
          <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800 rounded-md px-3 py-2 text-center">{error}</p>
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
          <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground">
            {backLabel}
          </button>
        </div>
      </form>
    </>
  );
}
