'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Link2, Loader2, X } from 'lucide-react';
import { linkTicketToOrder } from '@/lib/support/actions';

/**
 * Tiny inline form for the support detail sidebar — lets an admin attach an
 * order number (e.g. L2D-2026-XXXXXX) to a ticket that didn't get auto-linked
 * at submission time. Empty input unlinks. Posts via the server action.
 */
export function TicketLinkOrder({
  ticketId,
  currentOrderNumber,
}: {
  ticketId: string;
  currentOrderNumber?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(currentOrderNumber ?? '');
  const [msg, setMsg] = useState<string | null>(null);

  function call(orderNumber: string) {
    setMsg(null);
    start(async () => {
      const fd = new FormData();
      fd.set('ticketId', ticketId);
      fd.set('orderNumber', orderNumber);
      try {
        const r = await linkTicketToOrder(fd);
        setMsg(r?.message ?? 'Done.');
        router.refresh();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Failed.');
      }
    });
  }

  return (
    <div className="pt-3 mt-3 border-t border-border">
      <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-1.5 inline-flex items-center gap-1">
        <Link2 className="h-3 w-3" /> Link order
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          placeholder="L2D-2026-XXXXXX"
          onChange={(e) => setValue(e.target.value.toUpperCase())}
          className="flex-1 h-8 px-2 rounded-md border border-input bg-background text-[11px] font-mono"
        />
        <button
          type="button"
          disabled={pending || !value.trim()}
          onClick={() => call(value.trim())}
          className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md bg-primary text-primary-foreground text-[11px] font-bold hover:bg-primary/90 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Link'}
        </button>
        {currentOrderNumber && (
          <button
            type="button"
            disabled={pending}
            onClick={() => { setValue(''); call(''); }}
            className="inline-flex items-center h-8 w-8 justify-center rounded-md border border-border text-[11px] hover:bg-foreground/5 disabled:opacity-50"
            title="Unlink current order"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {msg && <p className="text-[10px] text-emerald-700 font-semibold mt-1">{msg}</p>}
    </div>
  );
}
