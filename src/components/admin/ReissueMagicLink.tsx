'use client';

import { useState, useTransition } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { reissueGuestMagicLink } from '@/lib/support/actions';

export function ReissueMagicLink({ ticketId }: { ticketId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="pt-3 mt-3 border-t border-border">
      <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-1.5 inline-flex items-center gap-1">
        <RefreshCw className="h-3 w-3" /> Magic link
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!confirm('Rotate the magic link? The old link will stop working immediately and a new one will be emailed.')) return;
          setMsg(null);
          start(async () => {
            const fd = new FormData();
            fd.set('ticketId', ticketId);
            try {
              const r = await reissueGuestMagicLink(fd);
              setMsg(r.message);
            } catch (e) {
              setMsg(e instanceof Error ? e.message : 'Failed.');
            }
          });
        }}
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-input bg-background text-[11px] font-bold hover:bg-foreground/5 disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        Reissue link
      </button>
      {msg && <p className="text-[10px] text-emerald-700 font-semibold mt-1">{msg}</p>}
    </div>
  );
}
