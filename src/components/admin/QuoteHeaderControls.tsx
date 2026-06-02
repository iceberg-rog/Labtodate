'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import {
  setQuotePriority,
  claimQuote,
  transferQuote,
  archiveQuote,
  unarchiveQuote,
} from '@/lib/quotes/actions';

const PRIORITIES = ['VIP', 'URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;

export function QuoteHeaderControls({
  quoteId,
  priority,
  assignedToId,
  myUserId,
  admins,
  archived,
}: {
  quoteId: string;
  priority: string;
  assignedToId: string | null;
  myUserId: string | null;
  admins: Array<{ id: string; name: string | null; email: string }>;
  archived: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState('');

  function call(fn: () => Promise<{ ok: boolean; message: string }>) {
    setMsg(null);
    start(async () => {
      try {
        const r = await fn();
        setMsg(r.message);
        router.refresh();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Action failed.');
      }
    });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={priority}
        onChange={(e) => {
          const fd = new FormData();
          fd.set('quoteId', quoteId);
          fd.set('priority', e.target.value);
          call(() => setQuotePriority(fd));
        }}
        disabled={pending}
        className="h-9 px-2 rounded-md border border-input bg-background text-xs font-bold disabled:opacity-60"
      >
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>

      {myUserId !== assignedToId && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            const fd = new FormData();
            fd.set('quoteId', quoteId);
            call(() => claimQuote(fd));
          }}
          className="inline-flex items-center gap-1 h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90 disabled:opacity-50"
        >
          Claim
        </button>
      )}

      <select
        value={transferTo}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          const fd = new FormData();
          fd.set('quoteId', quoteId);
          fd.set('toUserId', v);
          setTransferTo('');
          call(() => transferQuote(fd));
        }}
        disabled={pending}
        className="h-9 px-2 rounded-md border border-input bg-background text-xs font-semibold disabled:opacity-60"
      >
        <option value="">Transfer to...</option>
        {admins.filter((a) => a.id !== assignedToId).map((a) => (
          <option key={a.id} value={a.id}>
            {a.name ?? a.email}
          </option>
        ))}
      </select>

      <button
        type="button"
        disabled={pending}
        onClick={() => {
          const fd = new FormData();
          fd.set('quoteId', quoteId);
          call(() => (archived ? unarchiveQuote(fd) : archiveQuote(fd)));
        }}
        className="inline-flex items-center gap-1 h-9 px-3 rounded-md border border-input bg-background text-xs font-semibold hover:bg-foreground/5 disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {archived ? 'Restore' : 'Archive'}
      </button>
      {msg && <span className="text-[10px] text-muted-foreground">{msg}</span>}
    </div>
  );
}
