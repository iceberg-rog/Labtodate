'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { Loader2, ShieldCheck, Copy, Download, Smartphone, KeyRound } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { finishTwoFactorSetup } from '@/app/auth/two-factor/actions';

type Step = 'password' | 'scan' | 'codes' | 'done';

function secretFromUri(uri: string): string {
  try {
    return new URL(uri).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

/** The issuer (brand) of an otpauth:// URI; '' when it has none. */
function issuerFromUri(uri: string): string {
  try {
    return (new URL(uri).searchParams.get('issuer') ?? '').trim();
  } catch {
    return '';
  }
}

/** "labtodate-recovery-codes.txt" from the brand; a safe file name whatever it is. */
function recoveryCodesFileName(site: string): string {
  const slug = site.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${slug ? `${slug}-` : ''}recovery-codes.txt`;
}

/**
 * Set up an authenticator app: confirm the password, scan the QR code (or type
 * the key), enter a code to prove it works, then save the 10 recovery codes.
 * Two-factor sign-in is only switched on once a code from the app checks out.
 */
export function TwoFactorSetup({ email, redirectTo, compact }: { email: string; redirectTo?: string; compact?: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [uri, setUri] = useState('');
  const [svg, setSvg] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!uri) return;
    QRCode.toString(uri, { type: 'svg', margin: 1, width: 200, errorCorrectionLevel: 'M' })
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [uri]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: err } = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (err || !data) {
      setError(
        err?.status === 400 || err?.code === 'INVALID_PASSWORD'
          ? 'That password isn’t right. (No password yet? Use “Forgot password” on the sign-in page to set one.)'
          : err?.message || 'Could not start the set-up — try again.',
      );
      return;
    }
    setUri(data.totpURI);
    setCodes(data.backupCodes);
    setPassword('');
    setStep('scan');
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s+/g, '') });
    if (err) {
      setBusy(false);
      setError(
        err.status === 429
          ? err.message || 'Too many tries — wait a few minutes.'
          : 'That code doesn’t match. Check the phone’s clock is set automatically and use the newest code.',
      );
      return;
    }
    // Show the recovery codes first. The follow-up (server action) runs on
    // "Continue": a server action re-renders this page, and the set-up page
    // forwards an account that already has 2FA — before the codes were saved.
    setBusy(false);
    setInfo('Other devices that were signed in to your account have been signed out.');
    setStep('codes');
  }

  const secret = secretFromUri(uri);
  // The brand the server put in the authenticator URI (the live SITE_NAME).
  const site = issuerFromUri(uri);
  const codesText = `${site ? `${site} recovery codes` : 'Recovery codes'} for ${email}\nEach code works once. Keep them somewhere safe (password manager, printed).\n\n${codes.join('\n')}\n`;

  return (
    <div className={compact ? 'space-y-4' : 'rounded-2xl border bg-card p-6 shadow-sm space-y-4'} data-testid="two-factor-setup">
      {step === 'password' && (
        <form onSubmit={start} className="space-y-3">
          <p className="text-sm text-muted-foreground">
            You need an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password, Authy …).
            First confirm your password.
          </p>
          <label htmlFor="tfa-password" className="text-sm font-medium block">
            Password
          </label>
          <input
            id="tfa-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
          />
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <Button type="submit" disabled={!password || busy} className="w-full">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />} Continue
          </Button>
        </form>
      )}

      {step === 'scan' && (
        <form onSubmit={verify} className="space-y-3">
          <p className="text-sm font-semibold">1. Scan this QR code with your authenticator app</p>
          <div className="flex justify-center">
            {svg ? (
              <div
                className="rounded-xl bg-white p-2 border"
                aria-label="QR code for your authenticator app"
                role="img"
                // SVG produced locally by the qrcode library from the otpauth:// URI.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              <Loader2 className="h-6 w-6 animate-spin" />
            )}
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Can’t scan? Type this key into the app instead</summary>
            <p className="mt-2 font-mono text-sm text-foreground break-all select-all" data-testid="totp-secret">
              {secret.replace(/(.{4})/g, '$1 ').trim()}
            </p>
            <p className="mt-1">Account: {email} · time-based · 6 digits</p>
          </details>
          <p className="text-sm font-semibold pt-1">2. Enter the 6-digit code the app shows</p>
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            className="w-full h-11 px-3 rounded-md border border-input bg-background text-lg tracking-[0.4em] text-center font-mono"
          />
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <Button type="submit" disabled={code.replace(/\s+/g, '').length !== 6 || busy} className="w-full">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Verify and switch on
          </Button>
        </form>
      )}

      {step === 'codes' && (
        <div className="space-y-3">
          <p className="text-sm font-semibold inline-flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
            <ShieldCheck className="h-4 w-4" /> Two-factor sign-in is on.
          </p>
          {info && <p className="text-xs text-muted-foreground">{info}</p>}
          <p className="text-sm">
            <KeyRound className="inline h-4 w-4 mr-1" />
            Save these <strong>recovery codes</strong>. If you lose your phone, each code lets you sign in once. They are
            shown only now.
          </p>
          <ul className="grid grid-cols-2 gap-1.5 rounded-xl border bg-muted/40 p-3 font-mono text-sm" data-testid="recovery-codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex gap-2 flex-wrap">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigator.clipboard?.writeText(codesText).catch(() => {})}
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([codesText], { type: 'text/plain' }));
                a.download = recoveryCodesFileName(site);
                a.click();
              }}
            >
              <Download className="h-3.5 w-3.5" /> Download
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="h-4 w-4 accent-primary" />
            I have saved my recovery codes
          </label>
          <Button
            type="button"
            disabled={!saved || busy}
            className="w-full"
            onClick={async () => {
              setBusy(true);
              await finishTwoFactorSetup().catch(() => null);
              setStep('done');
              router.push(redirectTo || '/auth/continue');
              router.refresh();
            }}
          >
            Continue
          </Button>
        </div>
      )}
      {step === 'done' && (
        <p className="text-sm text-muted-foreground inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Opening…
        </p>
      )}
    </div>
  );
}
