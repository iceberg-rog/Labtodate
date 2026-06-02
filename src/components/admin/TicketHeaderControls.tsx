'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Loader2, Archive, ArchiveRestore, UserPlus, RefreshCw } from 'lucide-react';
import {
  setTicketStatus,
  setTicketPriority,
  claimTicket,
  transferTicket,
  unassignTicket,
  archiveTicket,
  unarchiveTicket,
} from '@/lib/support/actions';

const STATUSES = ['OPEN', 'WAITING_ON_SUPPORT', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED', 'SPAM'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT', 'VIP'] as const;

type Admin = { id: string; name: string; email: string };

export function TicketHeaderControls({
  ticketId,
  status,
  priority,
  assignedToId,
  myUserId,
  admins,
  archived,
}: {
  ticketId: string;
  status: string;
  priority: string;
  assignedToId: string | null;
  myUserId: string | null;
  admins: Admin[];
  archived: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);

  function call<T>(fn: () => Promise<T>, fallback = 'Done.') {
    setMsg(null);
    start(async () => {
      try {
        const r = (await fn()) as { ok?: boolean; message?: string } | undefined;
        setMsg(r?.message ?? fallback);
        router.refresh();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Failed');
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-2 flex-shrink-0">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Status */}
        <select
          value={status}
          disabled={pending}
          onChange={(e) => {
            const v = e.target.value;
            call(() => {
              const fd = new FormData();
              fd.set('ticketId', ticketId);
              fd.set('status', v);
              return setTicketStatus(fd);
            });
          }}
          className="h-8 px-2 rounded-lg border border-input bg-background text-xs font-semibold"
        >
          {STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase().replace(/_/g, ' ')}</option>)}
        </select>
        {/* Priority */}
        <select
          value={priority}
          disabled={pending}
          onChange={(e) => {
            const v = e.target.value;
            call(() => {
              const fd = new FormData();
              fd.set('ticketId', ticketId);
              fd.set('priority', v);
              return setTicketPriority(fd);
            });
          }}
          className="h-8 px-2 rounded-lg border border-input bg-background text-xs font-semibold"
        >
          {PRIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {/* Claim / release */}
        {assignedToId === myUserId ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => call(() => {
              const fd = new FormData(); fd.set('ticketId', ticketId);
              return unassignTicket(fd);
            }, 'Released.')}
            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-border bg-card text-xs font-bold hover:bg-foreground/5 disabled:opacity-50"
          >
            Release
          </button>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => call(() => {
              const fd = new FormData(); fd.set('ticketId', ticketId);
              return claimTicket(fd);
            }, 'Claimed.')}
            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90 disabled:opacity-50"
          >
            <UserPlus className="h-3.5 w-3.5" /> {assignedToId ? 'Take over' : 'Claim'}
          </button>
        )}

        {/* Transfer */}
        {!transferring ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => setTransferring(true)}
            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-border bg-card text-xs font-semibold hover:bg-foreground/5 disabled:opacity-50"
          >
            Transfer…
          </button>
        ) : (
          <span className="inline-flex items-center gap-1">
            <select
              disabled={pending}
              onChange={(e) => {
                const toUserId = e.target.value;
                if (!toUserId) return;
                call(() => {
                  const fd = new FormData();
                  fd.set('ticketId', ticketId);
                  fd.set('toUserId', toUserId);
                  return transferTicket(fd);
                });
                setTransferring(false);
              }}
              defaultValue=""
              className="h-8 px-2 rounded-lg border border-input bg-background text-xs font-semibold"
            >
              <option value="" disabled>Transfer to…</option>
              {admins.filter((a) => a.id !== myUserId).map((a) => (
                <option key={a.id} value={a.id}>{a.name || a.email}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setTransferring(false)}
              className="text-[11px] text-muted-foreground underline"
            >
              cancel
            </button>
          </span>
        )}

        {/* Archive / restore */}
        {!archived ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => call(() => {
              const fd = new FormData(); fd.set('ticketId', ticketId);
              return archiveTicket(fd);
            }, 'Archived.')}
            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-slate-300 bg-white text-slate-700 text-xs font-bold hover:bg-slate-50 disabled:opacity-50"
          >
            <Archive className="h-3.5 w-3.5" /> Archive
          </button>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => call(() => {
              const fd = new FormData(); fd.set('ticketId', ticketId);
              return unarchiveTicket(fd);
            }, 'Restored.')}
            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold disabled:opacity-50"
          >
            <ArchiveRestore className="h-3.5 w-3.5" /> Restore
          </button>
        )}

        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {msg && <p className="text-[10px] text-emerald-700 font-semibold">{msg}</p>}
    </div>
  );
}
