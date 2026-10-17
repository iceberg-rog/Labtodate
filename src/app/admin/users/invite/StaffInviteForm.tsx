'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Send } from 'lucide-react';
import { useStepUp, type MaybeStepUp } from '@/components/security/useStepUp';

type Result = MaybeStepUp & { link?: string };

export function StaffInviteForm({
  action,
  presets,
}: {
  action: (fd: FormData) => Promise<Result>;
  presets: { key: string; label: string; grantable: boolean }[];
}) {
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Result | null>(null);
  const [email, setEmail] = useState('');
  const [preset, setPreset] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.set('email', email);
        fd.set('preset', preset);
        setMsg(null);
        start(async () => {
          const r = (await run(() => action(fd)).catch(() => ({ ok: false, message: 'Failed — try again.' }))) as Result;
          setMsg(r);
          if (r.ok) {
            setEmail('');
            setPreset('');
          }
          router.refresh();
        });
      }}
      className="rounded-2xl border border-border bg-card p-5 space-y-3"
      data-testid="invite-form"
    >
      {dialog}
      <div className="grid sm:grid-cols-[1fr_260px] gap-3">
        <label className="block">
          <span className="block text-sm font-semibold mb-1">Work e-mail</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@yourcompany.com"
            className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1">Permissions</span>
          <select
            required
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="w-full h-10 px-2 rounded-lg border border-input bg-background text-sm"
          >
            <option value="">Choose…</option>
            {presets.map((p) => (
              <option key={p.key} value={p.key} disabled={!p.grantable}>
                {p.label}
                {p.grantable ? '' : ' (you can’t grant this)'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="submit"
        disabled={pending || !email || !preset}
        className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send invitation
      </button>
      {msg && (
        <div role={msg.ok ? 'status' : 'alert'} className={`text-sm font-semibold ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}`}>
          {msg.message}
          {msg.link && <p className="mt-1 font-mono text-xs break-all text-foreground select-all">{msg.link}</p>}
        </div>
      )}
    </form>
  );
}

export function RevokeInviteButton({ id, action }: { id: string; action: (fd: FormData) => Promise<{ ok: boolean; message: string }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!window.confirm('Withdraw this invitation? The link stops working.')) return;
        start(async () => {
          const fd = new FormData();
          fd.set('id', id);
          await action(fd).catch(() => null);
          router.refresh();
        });
      }}
      className="h-8 px-3 rounded-full border border-border text-xs font-semibold hover:bg-muted"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Withdraw'}
    </button>
  );
}
