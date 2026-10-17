'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldCheck, Smartphone, KeyRound } from 'lucide-react';
import { useStepUp, type MaybeStepUp } from '@/components/security/useStepUp';

export type CapRow = { cap: string; info: string; grantable: boolean; superOnly: boolean };
export type PresetRow = { key: string; label: string; caps: string[]; grantable: boolean };

/**
 * Admin permissions editor for one admin. Shows what the viewer may grant
 * (boxes they can't grant are disabled and say why); the server applies the
 * same rules and has the final word (src/lib/security/user-access.ts).
 */
export function UserAccessPanel({
  userId,
  email,
  caps,
  capRows,
  presets,
  canEdit,
  editBlockedReason,
  twoFactorEnabled,
  twoFactorRequired,
  setCaps,
  resetTwoFactor,
  canResetTwoFactor,
}: {
  userId: string;
  email: string;
  caps: string[];
  capRows: CapRow[];
  presets: PresetRow[];
  canEdit: boolean;
  editBlockedReason: string | null;
  twoFactorEnabled: boolean;
  twoFactorRequired: boolean;
  setCaps: (fd: FormData) => Promise<MaybeStepUp>;
  resetTwoFactor: (fd: FormData) => Promise<MaybeStepUp>;
  canResetTwoFactor: boolean;
}) {
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const isSuper = caps.includes('*');
  const [checked, setChecked] = useState<Set<string>>(() => new Set(isSuper ? ['*'] : caps));

  function submit(fd: FormData, confirmText?: string, action = setCaps) {
    if (confirmText && !window.confirm(confirmText)) return;
    setMsg(null);
    fd.set('userId', userId);
    start(async () => {
      const r = await run(() => action(fd)).catch(() => ({ ok: false, message: 'Saving failed — please try again.' }));
      setMsg(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5 space-y-4" data-testid="user-access-panel">
      {dialog}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-bold">Admin permissions</p>
          <p className="text-xs text-muted-foreground mt-1">
            Current:{' '}
            <span className="font-mono text-foreground">{isSuper ? '* (super-admin — everything)' : caps.join(', ') || '(none)'}</span>
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 text-[11px] font-bold rounded-full px-2.5 py-1 ${
            twoFactorEnabled
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
          }`}
        >
          <Smartphone className="h-3.5 w-3.5" />
          {twoFactorEnabled
            ? 'Authenticator app set up'
            : twoFactorRequired
              ? 'No authenticator yet — must set one up at next sign-in'
              : 'No authenticator app'}
        </span>
      </div>

      {!canEdit && editBlockedReason && (
        <p className="text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
          {editBlockedReason}
        </p>
      )}

      {canEdit && (
        <>
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Apply a preset</p>
            <div className="flex gap-2 flex-wrap">
              {presets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  disabled={pending || !p.grantable}
                  title={p.grantable ? p.caps.join(', ') : 'Contains permissions you don’t hold yourself'}
                  onClick={() => {
                    const fd = new FormData();
                    fd.set('preset', p.key);
                    submit(fd, `Replace ${email}’s permissions with “${p.label}”?`);
                  }}
                  className="rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <details>
            <summary className="text-xs font-bold uppercase tracking-wider text-muted-foreground cursor-pointer">
              Or pick individual permissions
            </summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData();
                for (const c of checked) fd.append('cap', c);
                submit(fd, `Save these ${checked.size} permission${checked.size === 1 ? '' : 's'} for ${email}?`);
              }}
              className="mt-3 space-y-3"
            >
              <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
                {capRows.map((r) => (
                  <label
                    key={r.cap}
                    className={`flex items-start gap-2 text-sm ${r.grantable ? '' : 'opacity-50'}`}
                    title={r.grantable ? r.info : r.superOnly ? 'Only a super-admin can grant this' : 'You don’t hold this permission yourself'}
                  >
                    <input
                      type="checkbox"
                      name="cap"
                      value={r.cap}
                      disabled={!r.grantable || (checked.has('*') && r.cap !== '*')}
                      checked={checked.has(r.cap) || (checked.has('*') && r.cap !== '*')}
                      onChange={(e) => {
                        const next = new Set(checked);
                        if (e.target.checked) next.add(r.cap);
                        else next.delete(r.cap);
                        setChecked(next);
                      }}
                      className="accent-primary mt-1"
                    />
                    <span>
                      <code className="font-mono text-xs">{r.cap}</code>
                      <span className="block text-[11px] text-muted-foreground leading-snug">{r.info}</span>
                    </span>
                  </label>
                ))}
              </div>
              <button
                type="submit"
                disabled={pending}
                className="rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                Save selected
              </button>
            </form>
          </details>
        </>
      )}

      {canResetTwoFactor && (twoFactorEnabled || twoFactorRequired) && (
        <div className="border-t border-border pt-3 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted-foreground max-w-xl">
            Lost phone and recovery codes? Resetting removes their authenticator and signs them out; they set up a new one
            at their next sign-in.
          </p>
          <button
            type="button"
            disabled={pending || !twoFactorEnabled}
            onClick={() =>
              submit(new FormData(), `Reset two-factor sign-in for ${email}? They will be signed out everywhere.`, resetTwoFactor)
            }
            className="rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            <KeyRound className="h-3.5 w-3.5" /> Reset two-factor
          </button>
        </div>
      )}

      {msg && (
        <p
          role={msg.ok ? 'status' : 'alert'}
          className={`text-xs font-semibold ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}`}
        >
          {msg.message}
        </p>
      )}
    </div>
  );
}
