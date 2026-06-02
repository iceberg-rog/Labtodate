'use client';

import { useState, useTransition } from 'react';
import { Loader2, CheckCircle2, XCircle, ShieldCheck } from 'lucide-react';
import { verifySetting } from '@/app/admin/actions';

export function FieldVerify({ settingKey }: { settingKey: string }) {
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setRes(null);
            try {
              setRes(await verifySetting(settingKey));
            } catch {
              setRes({ ok: false, message: 'Verify failed to run.' });
            }
          })
        }
        className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[11px] font-semibold hover:bg-muted disabled:opacity-50"
      >
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <ShieldCheck className="h-3 w-3" />
        )}
        Verify
      </button>
      {res && (
        <span
          className={`inline-flex items-center gap-1 text-[11px] font-medium ${
            res.ok ? 'text-emerald-600' : 'text-red-600'
          }`}
        >
          {res.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {res.message}
        </span>
      )}
    </span>
  );
}
