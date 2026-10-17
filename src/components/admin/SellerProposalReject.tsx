'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { rejectSellerProposal } from '@/lib/quotes/actions';

/** Staff decline a supplier proposal with a note the supplier sees (approve = send the offer). */
export function SellerProposalReject({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!open) {
    return (
      <div className="space-y-1">
        <button type="button" onClick={() => setOpen(true)} className="text-xs font-semibold text-red-700 dark:text-red-400 hover:underline">Don’t use this proposal…</button>
        {msg && <p role="status" className={`text-[11px] ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 1000))} rows={2} placeholder="Why (the supplier sees this), e.g. price too high for this buyer" className="w-full px-2 py-1.5 rounded-md border border-input bg-background text-xs" />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || note.trim().length < 4}
          onClick={() => start(async () => {
            const r = await rejectSellerProposal({ sourcingRequestId: quoteId, note });
            setMsg({ ok: !r.error, text: r.error ?? r.notice ?? 'Done.' });
            if (!r.error) { setOpen(false); router.refresh(); }
          })}
          className="h-8 px-3 rounded-full bg-red-700 text-white text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1"
        >
          {pending && <Loader2 className="h-3 w-3 animate-spin" />} Decline proposal
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-8 px-3 rounded-full border border-border text-xs font-semibold">Back</button>
      </div>
      {msg && !msg.ok && <p role="alert" className="text-[11px] text-red-600">{msg.text}</p>}
    </div>
  );
}
