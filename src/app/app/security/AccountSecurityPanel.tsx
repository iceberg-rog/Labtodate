'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, KeyRound, Smartphone, LogOut } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { TwoFactorSetup } from '@/components/security/TwoFactorSetup';
import { signOutOtherSessions } from '@/app/auth/two-factor/actions';

/** Two-factor sign-in for the signed-in person: set up, new recovery codes, replace or switch off. */
export function AccountSecurityPanel({
  email,
  twoFactorEnabled,
  twoFactorRequired,
}: {
  email: string;
  twoFactorEnabled: boolean;
  twoFactorRequired: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'setup' | 'codes' | 'replace' | 'disable'>('idle');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  async function newCodes(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
    setBusy(false);
    if (error || !data) {
      setMsg({ ok: false, text: error?.status === 400 ? 'That password isn’t right.' : error?.message || 'Could not create new codes.' });
      return;
    }
    setPassword('');
    setCodes(data.backupCodes);
    setMsg({ ok: true, text: 'New recovery codes created — the old ones no longer work.' });
  }

  async function turnOff(e: React.FormEvent, thenSetUp: boolean) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const { error } = await authClient.twoFactor.disable({ password });
    if (error) {
      setBusy(false);
      setMsg({ ok: false, text: error.status === 400 ? 'That password isn’t right.' : error.message || 'Could not change two-factor sign-in.' });
      return;
    }
    setBusy(false);
    setPassword('');
    if (thenSetUp) {
      setMode('setup');
      return;
    }
    setMode('idle');
    setMsg({ ok: true, text: 'Two-factor sign-in is off.' });
    router.refresh();
  }

  const passwordField = (
    <input
      type="password"
      autoComplete="current-password"
      value={password}
      onChange={(e) => setPassword(e.target.value)}
      placeholder="Your password"
      aria-label="Your password"
      className="h-9 w-56 px-3 rounded-md border border-input bg-background text-sm"
    />
  );

  return (
    <section className="rounded-2xl border border-border bg-card p-5 space-y-3" data-testid="account-2fa">
      <h2 className="font-bold inline-flex items-center gap-2">
        <Smartphone className="h-4 w-4" /> Two-factor sign-in
      </h2>
      <p className="text-sm">
        Status:{' '}
        {twoFactorEnabled ? (
          <strong className="text-emerald-700 dark:text-emerald-300">on — authenticator app</strong>
        ) : (
          <strong className="text-amber-700 dark:text-amber-300">off</strong>
        )}
        {twoFactorRequired && <span className="text-muted-foreground"> · required for your account type</span>}
      </p>

      {mode === 'setup' && <TwoFactorSetup email={email} redirectTo="/app/security" compact />}

      {mode === 'idle' && (
        <div className="flex gap-2 flex-wrap">
          {!twoFactorEnabled && (
            <Button size="sm" onClick={() => setMode('setup')}>
              <Smartphone className="h-3.5 w-3.5" /> Set up authenticator app
            </Button>
          )}
          {twoFactorEnabled && (
            <>
              <Button size="sm" variant="outline" onClick={() => { setMode('codes'); setMsg(null); setCodes(null); }}>
                <KeyRound className="h-3.5 w-3.5" /> New recovery codes
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setMode('replace'); setMsg(null); }}>
                <Smartphone className="h-3.5 w-3.5" /> New phone / app
              </Button>
              {!twoFactorRequired && (
                <Button size="sm" variant="outline" onClick={() => { setMode('disable'); setMsg(null); }}>
                  Turn off
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {mode === 'codes' && (
        <form onSubmit={newCodes} className="space-y-2">
          <p className="text-sm text-muted-foreground">Creates 10 new recovery codes; the old ones stop working.</p>
          <div className="flex gap-2 flex-wrap items-center">
            {passwordField}
            <Button type="submit" size="sm" disabled={!password || busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Create codes
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode('idle')}>
              Done
            </Button>
          </div>
          {codes && (
            <ul className="grid grid-cols-2 gap-1.5 rounded-xl border bg-muted/40 p-3 font-mono text-sm" data-testid="new-recovery-codes">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </form>
      )}

      {(mode === 'replace' || mode === 'disable') && (
        <form onSubmit={(e) => turnOff(e, mode === 'replace')} className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {mode === 'replace'
              ? 'Removes the current authenticator; you then scan a new QR code with the new phone. Until you finish, your account has no second factor.'
              : 'Your account will sign in with the password only.'}
          </p>
          <div className="flex gap-2 flex-wrap items-center">
            {passwordField}
            <Button type="submit" size="sm" disabled={!password || busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} {mode === 'replace' ? 'Continue' : 'Turn off'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} className={`text-sm font-semibold ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}`}>
          {msg.text}
        </p>
      )}
    </section>
  );
}

/** "Sign out all other devices". */
export function SessionsActions({ otherCount }: { otherCount: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Button
        size="sm"
        variant="outline"
        disabled={pending || otherCount === 0}
        onClick={() =>
          start(async () => {
            const r = await signOutOtherSessions().catch(() => ({ ok: false, message: 'Failed — try again.' }));
            setMsg(r.message);
            router.refresh();
          })
        }
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />} Sign out all other devices
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </div>
  );
}
