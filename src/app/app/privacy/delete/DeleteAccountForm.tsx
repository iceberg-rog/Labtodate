'use client';

import { useState, useTransition } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { deleteMyAccount } from './actions';

export function DeleteAccountForm({ method }: { method: 'password' | 'totp' }) {
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      try {
        const r = await deleteMyAccount({ secret, confirm, reason });
        if (!r.ok) {
          setError(r.message);
          return;
        }
        // Every session of the account is gone now: leave the signed-in area.
        window.location.assign('/auth/sign-in?error=ACCOUNT_DELETED');
      } catch {
        setError('The request failed — reload the page and try again.');
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="delete-account-form">
      <label className="block">
        <span className="block text-sm font-semibold mb-1.5">{method === 'totp' ? 'Code from your authenticator app' : 'Your password'}</span>
        <input
          type={method === 'totp' ? 'text' : 'password'}
          inputMode={method === 'totp' ? 'numeric' : undefined}
          autoComplete={method === 'totp' ? 'one-time-code' : 'current-password'}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          required
          className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
        />
      </label>
      <label className="block">
        <span className="block text-sm font-semibold mb-1.5">Why are you leaving? (optional)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm" />
      </label>
      <label className="block">
        <span className="block text-sm font-semibold mb-1.5">Type DELETE to confirm</span>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="off" className="w-full h-10 px-3 rounded-lg border border-red-300 dark:border-red-800 bg-background text-sm font-mono" />
      </label>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-md px-3 py-2">{error}</p>}
      <button
        type="submit"
        disabled={pending || confirm.trim().toUpperCase() !== 'DELETE' || !secret}
        className="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-red-700 hover:bg-red-800 text-white text-sm font-bold disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        Delete my account
      </button>
    </form>
  );
}
