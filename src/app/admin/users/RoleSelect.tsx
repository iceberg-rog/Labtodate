'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { UserRole } from '@prisma/client';
import { useStepUp, type MaybeStepUp } from '@/components/security/useStepUp';

const ROLES: UserRole[] = ['BUYER', 'SELLER', 'ADMIN'];
const LABEL: Record<UserRole, string> = { BUYER: 'buyer', SELLER: 'internal supplier', ADMIN: 'admin' };

export type PresetOption = { key: string; label: string; grantable: boolean };

/**
 * Role dropdown. Asks before applying (it used to apply on change, so a slip
 * of the mouse could promote someone to ADMIN), and shows the server's answer
 * inline. Making someone an admin needs a permission preset — the server
 * refuses a promotion without one, so the choice is asked here first. Server
 * rules (own role, super-admin only, last admin …) are enforced in
 * src/lib/security/user-access.ts; this only explains them.
 */
export function RoleSelect({
  userId,
  current,
  action,
  presets,
  canPromote,
}: {
  userId: string;
  current: UserRole;
  action: (formData: FormData) => Promise<MaybeStepUp>;
  presets: PresetOption[];
  /** Whether the viewer may make someone an admin (policy + own permissions). */
  canPromote: boolean;
}) {
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [preset, setPreset] = useState('');
  const [value, setValue] = useState<UserRole>(current);

  function apply(next: UserRole, chosenPreset?: string) {
    setMsg(null);
    start(async () => {
      const fd = new FormData();
      fd.set('userId', userId);
      fd.set('role', next);
      if (chosenPreset) fd.set('preset', chosenPreset);
      try {
        const r = await run(() => action(fd));
        setMsg(r);
        if (r.ok) {
          setPromoting(false);
          router.refresh();
        } else {
          setValue(current);
        }
      } catch {
        setValue(current);
        setMsg({ ok: false, message: 'Role change failed — please try again.' });
      }
    });
  }

  return (
    <span className="inline-flex flex-col gap-1">
      {dialog}
      <select
        name="role"
        aria-label="Role"
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.currentTarget.value as UserRole;
          if (next === current) {
            setValue(current);
            setPromoting(false);
            return;
          }
          if (next === 'ADMIN') {
            if (!canPromote) {
              setValue(current);
              setMsg({ ok: false, message: 'Only a super-admin can make someone an admin (Settings → Security).' });
              return;
            }
            setValue(next);
            setPromoting(true);
            setMsg(null);
            return;
          }
          const warn = current === 'ADMIN' ? ' Their admin permissions are removed and they are signed out everywhere.' : '';
          if (!window.confirm(`Change this user’s role from ${LABEL[current]} to ${LABEL[next]}?${warn}`)) {
            setValue(current);
            return;
          }
          setValue(next);
          apply(next);
        }}
        className="h-8 px-2 rounded-md border border-border bg-card text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {promoting && canPromote && (
        <span className="flex flex-col gap-1 max-w-[260px]">
          <select
            aria-label="Admin permissions"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="h-8 px-2 rounded-md border border-border bg-card text-xs"
          >
            <option value="">Choose permissions…</option>
            {presets.map((p) => (
              <option key={p.key} value={p.key} disabled={!p.grantable}>
                {p.label}
                {p.grantable ? '' : ' (you can’t grant this)'}
              </option>
            ))}
          </select>
          <span className="flex gap-1">
            <button
              type="button"
              disabled={!preset || pending}
              onClick={() => {
                const label = presets.find((p) => p.key === preset)?.label ?? preset;
                if (!window.confirm(`Make this user an admin with “${label}”? They will be signed out and must set up two-factor sign-in.`)) return;
                apply('ADMIN', preset);
              }}
              className="h-7 px-3 rounded-full bg-primary text-primary-foreground text-[11px] font-semibold disabled:opacity-50"
            >
              Make admin
            </button>
            <button
              type="button"
              onClick={() => {
                setPromoting(false);
                setValue(current);
                setMsg(null);
              }}
              className="h-7 px-3 rounded-full border border-border text-[11px] font-semibold"
            >
              Cancel
            </button>
          </span>
        </span>
      )}
      {msg && (
        <span
          role={msg.ok ? 'status' : 'alert'}
          className={`text-[11px] font-semibold max-w-[260px] ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}`}
        >
          {msg.message}
        </span>
      )}
    </span>
  );
}
