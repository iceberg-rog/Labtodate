'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import {
  Mail,
  Phone,
  Building2,
  Paperclip,
  Lock,
  MessageSquare,
  Hourglass,
  AlertCircle,
  ShieldAlert,
  Crown,
  User as UserIcon,
  Archive,
  ArchiveRestore,
  Trash2,
} from 'lucide-react';
import { claimTicket, archiveTicket, unarchiveTicket, deleteTicketPermanently } from '@/lib/support/actions';
import { EmailText } from '@/components/util/EmailText';

type LinkedOrder = { id: string; orderNumber: string; status: string } | null | undefined;
type LinkedRfq = { id: string; proformaNumber: string | null; status: string } | null | undefined;

export type TicketRowProps = {
  id: string;
  ref_: string;
  subject: string;
  name: string;
  email: string;
  company: string | null;
  category: string | null;
  status: string;
  priority: string;
  dueAtISO: string | null;
  createdAtISO: string;
  lastReplyAtISO: string | null;
  lastReplyByStaff: boolean;
  customerType: 'REGISTERED' | 'GUEST';
  assignee: { id: string; name: string; email: string } | null;
  myUserId: string | null;
  attachmentCount: number;
  internalNoteCount: number;
  messageCount: number;
  isRegistered: boolean;
  lifetimeCents: number;
  paidOrderCount: number;
  linkedOrder?: LinkedOrder;
  linkedRfq?: LinkedRfq;
  archived: boolean;
  lastBodyPreview: string | null;
  // Bulk-mode props injected by TicketBulkList. When `selectable` is true the
  // row renders a checkbox at the far left.
  selectable?: boolean;
  selected?: boolean;
  onSelectToggle?: () => void;
};

const PRIORITY_STYLE: Record<string, { label: string; cls: string; icon: JSX.Element }> = {
  VIP:    { label: 'VIP',    cls: 'bg-purple-100 text-purple-800 border-purple-300', icon: <Crown className="h-3 w-3" /> },
  URGENT: { label: 'URGENT', cls: 'bg-red-100 text-red-800 border-red-300',         icon: <ShieldAlert className="h-3 w-3" /> },
  HIGH:   { label: 'HIGH',   cls: 'bg-amber-100 text-amber-800 border-amber-300',   icon: <AlertCircle className="h-3 w-3" /> },
  NORMAL: { label: 'normal', cls: 'bg-slate-100 text-slate-700 border-slate-200',   icon: <></> },
  LOW:    { label: 'low',    cls: 'bg-slate-50 text-slate-600 border-slate-200',    icon: <></> },
};

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  OPEN:                  { label: 'open',                cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  WAITING_ON_SUPPORT:    { label: 'awaiting reply',      cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  WAITING_ON_CUSTOMER:   { label: 'awaiting customer',   cls: 'bg-sky-50 text-sky-800 border-sky-200' },
  RESOLVED:              { label: 'resolved',            cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  CLOSED:                { label: 'closed',              cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  SPAM:                  { label: 'spam',                cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  PENDING:               { label: 'pending',             cls: 'bg-sky-50 text-sky-800 border-sky-200' },
};

function initials(name: string, email: string): string {
  const src = (name || email).trim();
  return src
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .filter(Boolean)
    .join('')
    .toUpperCase() || '?';
}

function formatPrice(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

/**
 * SLA badge — colors based on dueAt:
 *   future   = green ("on track")
 *   <2h late = amber ("overdue")
 *   >2h late = red ("breached")
 * Resolved/closed/spam suppress the badge entirely.
 */
function SlaBadge({ dueAtISO, status, mounted }: { dueAtISO: string | null; status: string; mounted: boolean }) {
  if (!dueAtISO) return null;
  if (['RESOLVED', 'CLOSED', 'SPAM'].includes(status)) return null;
  if (!mounted) {
    // Stable placeholder — same DOM as a future "x left" badge so layout
    // doesn't shift when the real value lands after hydration.
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-foreground/[0.04] text-muted-foreground border border-border">
        SLA · …
      </span>
    );
  }
  const due = new Date(dueAtISO).getTime();
  const now = Date.now();
  const diffMs = due - now;
  if (diffMs > 0) {
    const h = Math.round(diffMs / 3600e3);
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
        <Hourglass className="h-3 w-3" /> SLA · {h <= 1 ? '<1h' : `${h}h left`}
      </span>
    );
  }
  const overH = Math.round(-diffMs / 3600e3);
  const breached = overH >= 2;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full ${
        breached
          ? 'bg-red-100 text-red-800 border border-red-300 animate-pulse'
          : 'bg-amber-100 text-amber-800 border border-amber-300'
      }`}
    >
      <AlertCircle className="h-3 w-3" />
      {breached ? `BREACHED ${overH}h` : `Overdue ${overH || '<1'}h`}
    </span>
  );
}

export function TicketRow(p: TicketRowProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Mount-gate any time-relative rendering so SSR + first client paint agree.
  // SLA badge + "X ago" text both depend on Date.now() and would otherwise
  // produce a hydration mismatch on every row.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const pri = PRIORITY_STYLE[p.priority] ?? PRIORITY_STYLE.NORMAL;
  const st = STATUS_STYLE[p.status] ?? STATUS_STYLE.OPEN;
  const isVip = p.priority === 'VIP';

  // Row stripe color: priority is the strongest signal (VIP/URGENT > status).
  const stripe =
    p.priority === 'VIP' ? 'before:bg-purple-500'
      : p.priority === 'URGENT' ? 'before:bg-red-500'
      : p.priority === 'HIGH' ? 'before:bg-amber-400'
      : p.status === 'WAITING_ON_SUPPORT' || p.status === 'OPEN' ? 'before:bg-sky-400'
      : 'before:bg-slate-300';

  return (
    <li
      className={`group relative rounded-2xl border border-border bg-card overflow-hidden transition-shadow hover:shadow-[0_8px_24px_-12px_rgba(15,79,64,0.18)]
        before:content-[''] before:absolute before:inset-y-0 before:left-0 before:w-1 ${stripe} ${p.archived ? 'opacity-70 grayscale-[0.2]' : ''}`}
    >
      {p.archived && (
        <div className="absolute top-2 right-3 z-10 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-2 py-0.5">
          <Archive className="h-3 w-3" /> Archived
        </div>
      )}

      <Link href={`/admin/tickets/${p.id}`} className="block hover:bg-foreground/[0.02]">
        <div className={`pl-4 pr-4 py-3 grid grid-cols-1 ${p.selectable ? 'lg:grid-cols-[28px_64px_2fr_2fr_1.4fr_1fr]' : 'lg:grid-cols-[64px_2fr_2fr_1.4fr_1fr]'} gap-4 items-start`}>
          {p.selectable && (
            <div className="flex items-start justify-center pt-3.5">
              <input
                type="checkbox"
                checked={!!p.selected}
                onChange={() => p.onSelectToggle?.()}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${p.ref_}`}
                className="h-4 w-4 accent-primary cursor-pointer"
              />
            </div>
          )}
          {/* Avatar */}
          <div className="flex items-center justify-center">
            <div className={`h-12 w-12 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${
              isVip ? 'bg-gradient-to-br from-purple-500 to-purple-700 text-white'
                : p.priority === 'URGENT' ? 'bg-gradient-to-br from-red-500 to-red-700 text-white'
                : 'bg-primary/10 text-primary'
            }`}>
              {initials(p.name, p.email)}
            </div>
          </div>

          {/* TICKET col — ref + subject + last-reply hint */}
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono text-[11px] text-muted-foreground">{p.ref_}</span>
              <span className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full border ${pri.cls}`}>
                {pri.icon}{pri.label}
              </span>
              <SlaBadge dueAtISO={p.dueAtISO} status={p.status} mounted={mounted} />
              {p.attachmentCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">
                  <Paperclip className="h-3 w-3" />
                  <span>{String(p.attachmentCount)}</span>
                </span>
              )}
              {p.internalNoteCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">
                  <Lock className="h-3 w-3" />
                  <span>{`${p.internalNoteCount} note${p.internalNoteCount === 1 ? '' : 's'}`}</span>
                </span>
              )}
            </div>
            <h3 className="font-semibold text-[14px] leading-tight tracking-tight">
              {p.subject}
            </h3>
            <p className="text-[11px] text-muted-foreground inline-flex items-center gap-2">
              <MessageSquare className="h-3 w-3" />
              <span>{`${p.messageCount} message${p.messageCount === 1 ? '' : 's'}`}</span>
              {p.lastReplyAtISO && (
                <>
                  <span>·</span>
                  <span>
                    {/* Single string expression so CF stripping <!-- --> can't
                     *  desync the text. The "…" placeholder is the SSR value;
                     *  useEffect flips to real timeAgo after mount. */}
                    {`last ${p.lastReplyByStaff ? 'reply by support' : 'message from customer'} ${mounted ? timeAgo(p.lastReplyAtISO) : '…'}`}
                  </span>
                </>
              )}
            </p>
          </div>

          {/* CUSTOMER col — identity + LTV */}
          <div className="min-w-0 space-y-0.5 text-xs">
            <p className="font-bold text-[13px]">{p.name}</p>
            <p className="inline-flex items-center gap-1 text-muted-foreground">
              <Mail className="h-3 w-3" />
              <EmailText email={p.email} className="hover:text-foreground" asLink />
            </p>
            {p.company && (
              <p className="inline-flex items-center gap-1 text-muted-foreground">
                <Building2 className="h-3 w-3" />
                <span>{p.company}</span>
              </p>
            )}
            <div className="inline-flex items-center gap-2 flex-wrap pt-0.5">
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${
                p.isRegistered
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : 'bg-slate-100 text-slate-700 border-slate-200'
              }`}>
                <UserIcon className="h-2.5 w-2.5" />
                <span>{p.isRegistered ? 'registered' : 'guest'}</span>
              </span>
              {p.paidOrderCount > 0 ? (
                <span className="text-[10px] text-muted-foreground">
                  {`${p.paidOrderCount} order${p.paidOrderCount === 1 ? '' : 's'} · LTV ${formatPrice(p.lifetimeCents)}`}
                </span>
              ) : p.isRegistered ? (
                <span className="text-[10px] text-muted-foreground">no paid orders yet</span>
              ) : null}
            </div>
          </div>

          {/* LINKED col — order/RFQ chips + category */}
          <div className="min-w-0 space-y-1 text-xs">
            {p.category && (
              <span className="inline-flex items-center text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-primary/[0.07] text-primary border border-primary/20">
                {p.category}
              </span>
            )}
            {p.linkedOrder && (
              <p className="inline-flex items-center gap-1.5 text-[11px]">
                <span className="text-muted-foreground">Order</span>
                <span className="font-mono font-semibold">{p.linkedOrder.orderNumber}</span>
                <span className="text-muted-foreground">·</span>
                <span className="font-semibold text-[10px] uppercase">{p.linkedOrder.status.toLowerCase().replace(/_/g, ' ')}</span>
              </p>
            )}
            {p.linkedRfq && (
              <p className="inline-flex items-center gap-1.5 text-[11px]">
                <span className="text-muted-foreground">RFQ</span>
                <span className="font-mono font-semibold">{p.linkedRfq.proformaNumber ?? p.linkedRfq.id.slice(-6)}</span>
              </p>
            )}
            {!p.linkedOrder && !p.linkedRfq && !p.category && (
              <p className="text-[11px] text-muted-foreground italic">no commerce link</p>
            )}
          </div>

          {/* ACTION col — status + assignee + claim */}
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border ${st.cls}`}>
              {st.label}
            </span>
            {p.assignee ? (
              <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1.5">
                <span className="h-5 w-5 rounded-full bg-primary/15 text-primary text-[9px] font-bold inline-flex items-center justify-center">
                  {initials(p.assignee.name, p.assignee.email)}
                </span>
                {p.myUserId === p.assignee.id ? 'mine' : p.assignee.name?.split(' ')[0] || p.assignee.email.split('@')[0]}
              </span>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  start(async () => {
                    const fd = new FormData(); fd.set('ticketId', p.id);
                    try { await claimTicket(fd); router.refresh(); }
                    catch (err) { alert(err instanceof Error ? err.message : 'Claim failed'); }
                  });
                }}
                className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border bg-card text-[10px] font-bold hover:bg-primary/[0.06] disabled:opacity-50"
              >
                Claim
              </button>
            )}
            {!p.archived ? (
              <button
                type="button"
                disabled={pending}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  start(async () => {
                    const fd = new FormData(); fd.set('ticketId', p.id);
                    try { await archiveTicket(fd); router.refresh(); }
                    catch (err) { alert(err instanceof Error ? err.message : 'Archive failed'); }
                  });
                }}
                className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[10px] font-semibold text-muted-foreground hover:bg-foreground/5 disabled:opacity-50"
                title="Archive"
              >
                <Archive className="h-3 w-3" />
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={pending}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    start(async () => {
                      const fd = new FormData(); fd.set('ticketId', p.id);
                      try { await unarchiveTicket(fd); router.refresh(); }
                      catch (err) { alert(err instanceof Error ? err.message : 'Restore failed'); }
                    });
                  }}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[10px] font-semibold text-slate-700 hover:bg-foreground/5 disabled:opacity-50"
                  title="Restore"
                >
                  <ArchiveRestore className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!confirm(`Permanently delete ${p.ref_}? This cannot be undone.`)) return;
                    start(async () => {
                      const fd = new FormData(); fd.set('ticketId', p.id);
                      try {
                        const r = await deleteTicketPermanently(fd);
                        if (!r.ok) alert(r.message);
                        router.refresh();
                      }
                      catch (err) { alert(err instanceof Error ? err.message : 'Delete failed'); }
                    });
                  }}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[10px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                  title="Delete permanently"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}
