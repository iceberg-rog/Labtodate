'use client';

import { useState, useTransition } from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { testIntegration } from '@/app/admin/actions';

export function ConnTest({
  kind,
  label,
}: {
  kind: 'resend' | 'stripe' | 'ai' | 'storage';
  label: string;
}) {
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setRes(null);
            try {
              setRes(await testIntegration(kind));
            } catch {
              setRes({ ok: false, message: 'Test failed to run.' });
            }
          })
        }
        className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Test {label} connection
      </button>
      {res && (
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-medium ${
            res.ok ? 'text-emerald-600' : 'text-red-600'
          }`}
        >
          {res.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {res.message}
        </span>
      )}
    </div>
  );
}
