'use client';

import { useState, useRef, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, UserPlus, UserCheck, ChevronDown, Repeat } from 'lucide-react';
import { claimQuote, transferQuote } from '@/lib/quotes/actions';

function initials(name: string | null, email: string): string {
  const src = (name || email).trim();
  return (
    src
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0])
      .filter(Boolean)
      .join('')
      .toUpperCase() || '?'
  );
}

/**
 * Ownership control. Two variants:
 *   - `compact`: row context — single chip; click to claim if unassigned,
 *     otherwise opens the transfer menu in a small portal-like dropdown.
 *   - `block`:   detail-hero context — INLINE ownership pill + visible
 *     action buttons (Take over / Transfer ▾). No surprise overlay on the
 *     hero stepper because actions are part of the document flow.
 */
export function AssigneeBadge({
  quoteId,
  assignee,
  myUserId,
  admins,
  variant = 'compact',
}: {
  quoteId: string;
  assignee: { id: string; name: string | null; email: string } | null;
  myUserId: string | null;
  admins: Array<{ id: string; name: string | null; email: string }>;
  variant?: 'compact' | 'block';
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [transferOpen, setTransferOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!transferOpen) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setTransferOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setTransferOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [transferOpen]);

  function call(fn: () => Promise<{ ok: boolean; message: string }>) {
    setMsg(null);
    start(async () => {
      try {
        const r = await fn();
        setMsg(r.message);
        setTransferOpen(false);
        router.refresh();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Action failed.');
      }
    });
  }

  const isMine = !!assignee && assignee.id === myUserId;

  // ─────────────────────────────── compact (row) ────────────────────────────────
  if (variant === 'compact') {
    if (!assignee) {
      return (
        <button
          type="button"
          disabled={pending}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const fd = new FormData(); fd.set('quoteId', quoteId);
            call(() => claimQuote(fd));
          }}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-amber-300 bg-amber-50 text-amber-900 text-[10px] font-bold hover:bg-amber-100 disabled:opacity-50"
          title="Unassigned — claim this RFQ"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}
          Unassigned
        </button>
      );
    }
    return (
      <span
        className={`inline-flex items-center gap-1.5 h-7 pl-1 pr-2.5 rounded-full text-[10px] font-bold ${
          isMine ? 'bg-primary/15 text-primary border border-primary/30' : 'bg-slate-100 text-slate-700 border border-slate-200'
        }`}
        title={`Assigned to ${assignee.name ?? assignee.email}`}
      >
        <span className={`h-5 w-5 rounded-full inline-flex items-center justify-center text-[9px] font-bold ${
          isMine ? 'bg-primary text-primary-foreground' : 'bg-slate-300 text-slate-800'
        }`}>
          {initials(assignee.name, assignee.email)}
        </span>
        {isMine ? 'Mine' : (assignee.name?.split(' ')[0] || assignee.email.split('@')[0])}
      </span>
    );
  }

  // ─────────────────────────────── block (detail hero) ───────────────────────────
  // INLINE pattern — no popup over the hero. Ownership pill + always-visible
  // action buttons. Transfer is the only thing that opens a small menu, and
  // it lives below the actions row in normal document flow.
  return (
    <div ref={wrapRef} className="w-full max-w-[260px] flex flex-col items-end gap-2">
      {/* Ownership pill */}
      <div
        className={`inline-flex items-center gap-2 h-9 pl-1 pr-3 rounded-full border ${
          assignee
            ? isMine
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'bg-card border-border'
            : 'bg-amber-50 border-amber-300 text-amber-900'
        } font-bold text-xs`}
      >
        <span className={`h-7 w-7 rounded-full inline-flex items-center justify-center text-[10px] font-bold ${
          assignee
            ? isMine
              ? 'bg-primary text-primary-foreground'
              : 'bg-slate-300 text-slate-800'
            : 'bg-amber-200 text-amber-900'
        }`}>
          {assignee ? initials(assignee.name, assignee.email) : <UserPlus className="h-3.5 w-3.5" />}
        </span>
        <span className="truncate max-w-[170px]">
          {assignee
            ? isMine ? 'Owned by you' : (assignee.name ?? assignee.email)
            : 'Unassigned'}
        </span>
      </div>

      {/* Action row — always visible, no overlay required */}
      <div className="flex items-center gap-1.5 flex-wrap justify-end">
        {!isMine && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const fd = new FormData(); fd.set('quoteId', quoteId);
              call(() => claimQuote(fd));
            }}
            className="inline-flex items-center gap-1 h-7 px-3 rounded-full bg-primary text-primary-foreground text-[11px] font-bold hover:bg-primary/90 disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserCheck className="h-3 w-3" />}
            {assignee ? 'Take over' : 'Claim'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setTransferOpen((v) => !v)}
          aria-expanded={transferOpen}
          className="inline-flex items-center gap-1 h-7 px-3 rounded-full border border-border bg-card text-foreground text-[11px] font-semibold hover:bg-foreground/5"
        >
          <Repeat className="h-3 w-3" /> Transfer
          <ChevronDown className={`h-3 w-3 transition-transform ${transferOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Inline transfer menu — appears under the action row in normal flow,
          not as an overlay. No risk of covering the funnel stepper. */}
      {transferOpen && (
        <div className="w-full max-w-[260px] rounded-xl border border-border bg-card shadow-sm p-2">
          <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground px-1 pb-1">
            Transfer to
          </p>
          <ul className="max-h-56 overflow-y-auto divide-y divide-border">
            {admins.filter((a) => a.id !== assignee?.id).map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    const fd = new FormData();
                    fd.set('quoteId', quoteId);
                    fd.set('toUserId', a.id);
                    call(() => transferQuote(fd));
                  }}
                  className="w-full text-left inline-flex items-center gap-2 py-2 px-2 text-xs hover:bg-foreground/5 rounded-md disabled:opacity-50"
                >
                  <span className="h-6 w-6 rounded-full bg-slate-200 text-slate-800 text-[10px] font-bold inline-flex items-center justify-center shrink-0">
                    {initials(a.name, a.email)}
                  </span>
                  <span className="font-semibold truncate flex-1 min-w-0">{a.name ?? a.email}</span>
                  {a.id === myUserId && <span className="text-[10px] text-muted-foreground shrink-0">(you)</span>}
                </button>
              </li>
            ))}
            {admins.filter((a) => a.id !== assignee?.id).length === 0 && (
              <li className="text-[11px] text-muted-foreground italic px-2 py-3">
                No other admins / sellers available.
              </li>
            )}
          </ul>
        </div>
      )}

      {msg && <p className="text-[10px] text-emerald-700 font-semibold">{msg}</p>}
    </div>
  );
}
