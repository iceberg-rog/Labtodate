'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Truck, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { bulkMarkAllShipped } from '@/app/admin/actions';

export function BulkShipButton({ count }: { count: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  function trigger() {
    setRes(null);
    start(async () => {
      try {
        const r = await bulkMarkAllShipped();
        setRes({ ok: r.ok, message: r.ok ? `Marked ${r.count} as shipped` : 'Failed' });
        if (r.ok) router.refresh();
      } catch (e) {
        setRes({ ok: false, message: e instanceof Error ? e.message : 'Failed' });
      }
      setConfirming(false);
    });
  }

  if (count === 0) return null;

  return (
    <div className="inline-flex items-center gap-2 flex-wrap">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold"
        >
          <Truck className="h-3.5 w-3.5" /> Mark all {count} as shipped
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={pending}
            onClick={trigger}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-amber-700 hover:bg-amber-800 text-white text-xs font-bold disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Confirm ship {count}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(false)}
            className="inline-flex items-center h-8 px-3 rounded-full bg-foreground/5 hover:bg-foreground/10 text-xs font-semibold"
          >
            Cancel
          </button>
        </>
      )}
      {res && (
        <span
          className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
            res.ok ? 'text-emerald-700' : 'text-red-700'
          }`}
        >
          {res.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {res.message}
        </span>
      )}
    </div>
  );
}
