'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import {
  authErrorMessage,
  cleanName,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  NAME_MAX_LENGTH,
  NAME_RULE,
} from '@/lib/auth-rules';

function Notice({ kind, msg }: { kind: 'ok' | 'err'; msg: string }) {
  return (
    <p
      className={`rounded-md px-3 py-2 text-sm ${
        kind === 'ok'
          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
          : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
      }`}
    >
      {kind === 'ok' && <Check className="inline h-4 w-4 mr-1" />}
      {msg}
    </p>
  );
}

export function ProfileForm({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [nameMsg, setNameMsg] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [pwMsg, setPwMsg] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [savingName, startName] = useTransition();
  const [savingPw, startPw] = useTransition();

  function saveName(e: React.FormEvent) {
    e.preventDefault();
    setNameMsg(null);
    const cleaned = cleanName(name);
    if (!cleaned) {
      setNameMsg({ kind: 'err', msg: NAME_RULE });
      return;
    }
    startName(async () => {
      const { error } = await authClient.updateUser({ name: cleaned });
      if (error) setNameMsg({ kind: 'err', msg: error.message || 'Could not update name' });
      else {
        setName(cleaned);
        setNameMsg({ kind: 'ok', msg: 'Name updated' });
        router.refresh();
      }
    });
  }

  function changePw(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPwMsg(null);
    const fd = new FormData(e.currentTarget);
    const currentPassword = String(fd.get('current') ?? '');
    const newPassword = String(fd.get('next') ?? '');
    const confirmPassword = String(fd.get('confirm') ?? '');
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPwMsg({ kind: 'err', msg: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwMsg({ kind: 'err', msg: 'New password and confirmation do not match' });
      return;
    }
    if (newPassword === currentPassword) {
      setPwMsg({ kind: 'err', msg: 'New password must differ from current password' });
      return;
    }
    const form = e.currentTarget;
    startPw(async () => {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (error) setPwMsg({ kind: 'err', msg: authErrorMessage(error, 'Could not change password') });
      else {
        setPwMsg({ kind: 'ok', msg: 'Password changed — other sessions signed out' });
        form.reset();
      }
    });
  }

  const field =
    'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

  return (
    <div className="space-y-4">
      <form onSubmit={saveName} className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <div>
          <h2 className="font-bold">Display name</h2>
          <p className="text-sm text-muted-foreground">Shown on your account and messages.</p>
        </div>
        <label className="block">
          <span className="block text-sm font-semibold mb-1.5">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={NAME_MAX_LENGTH}
            required
            className={field}
          />
        </label>
        {nameMsg && <Notice {...nameMsg} />}
        <Button type="submit" disabled={savingName} className="rounded-full font-semibold">
          {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save name'}
        </Button>
      </form>

      <form onSubmit={changePw} className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <div>
          <h2 className="font-bold">Change password</h2>
          <p className="text-sm text-muted-foreground">
            You&apos;ll stay signed in here; other devices are signed out.
          </p>
        </div>
        <label className="block">
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <span className="block text-sm font-semibold">Current password</span>
            <a href="/auth/forgot-password" className="text-xs font-semibold text-primary hover:underline">
              Forgot your password?
            </a>
          </div>
          <input name="current" type="password" required className={field} autoComplete="current-password" />
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1.5">New password</span>
          <input
            name="next"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            className={field}
            autoComplete="new-password"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1.5">Confirm new password</span>
          <input
            name="confirm"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            className={field}
            autoComplete="new-password"
          />
        </label>
        {pwMsg && <Notice {...pwMsg} />}
        <Button type="submit" disabled={savingPw} variant="outline" className="rounded-full font-semibold">
          {savingPw ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update password'}
        </Button>
      </form>
    </div>
  );
}
