'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import {
  Mail, Building2, Crown, ShieldAlert, AlertCircle, MessageSquare,
  Hourglass, Archive, ArchiveRestore, Trash2, Paperclip, Lock,
  TrendingUp, FileText,
} from 'lucide-react';
import { archiveQuote, unarchiveQuote, deleteQuotePermanently } from '@/lib/quotes/actions';
import { EmailText } from '@/components/util/EmailText';
import { computeDealState, toneClasses } from '@/lib/quotes/deal-state';
import { DealStateBadge } from '@/components/quotes/DealStateBadge';
import { AssigneeBadge } from '@/components/quotes/AssigneeBadge';

export type QuoteRowProps = {
  id: string;
  ref_: string;
  subject: string;
  buyerName: string;
  buyerEmail: string;
  company: string | null;
  status: string;
  lastReplyByStaff: boolean;
  priority: string;
  dueAtISO: string | null;
  createdAtISO: string;
  lastReplyAtISO: string | null;
  customerType: 'REGISTERED' | 'GUEST';
  assignee: { id: string; name: string | null; email: string } | null;
  myUserId: string | null;
  attachmentCount: number;
  internalNoteCount: number;
  messageCount: number;
  productTitle: string | null;
  productCategory: string | null;
  quotedPriceCents: number | null;
  quotedCurrency: string | null;
  proformaNumber: string | null;
  archived: boolean;
  isRegistered: boolean;
  /** Buyer's prior paid orders count (repeat / new buyer signal). */
  buyerPaidOrders: number;
  buyerLifetimeCents: number;
  /** Linked order if quote was accepted + converted. */
  linkedOrderStatus: string | null;
  /** Available admins for transfer popover. */
  admins?: Array<{ id: string; name: string | null; email: string }>;
  // Bulk-mode props
  selectable?: boolean;
  selected?: boolean;
  onSelectToggle?: () => void;
};

const PRIORITY_STYLE: Record<string, { label: string; cls: string; icon: JSX.Element }> = {
  VIP:    { label: 'VIP',    cls: 'bg-purple-100 text-purple-800 border-purple-300', icon: <Crown className="h-3 w-3" /> },
  URGENT: { label: 'URGENT', cls: 'bg-red-100 text-red-800 border-red-300',         icon: <ShieldAlert className="h-3 w-3" /> },
  HIGH:   { label: 'HIGH',   cls: 'bg-amber-100 text-amber-800 border-amber-300',   icon: <AlertCircle className="h-3 w-3" /> },
  NORMAL: { label: '',       cls: '',                                                icon: <></> },
  LOW:    { label: '',       cls: '',                                                icon: <></> },
};

function fmtMoney(cents: number, ccy = 'EUR'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(cents / 100);
}
function initials(name: string, email: string): string {
  const src = (name || email).trim();
  return src.split(/\s+/).slice(0, 2).map((s) => s[0]).filter(Boolean).join('').toUpperCase() || '?';
}
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86400_000)}d`;
}

function SlaBadge({ dueAtISO, status, mounted }: { dueAtISO: string | null; status: string; mounted: boolean }) {
  if (!dueAtISO || ['ACCEPTED','DECLINED','CLOSED'].includes(status)) return null;
  if (!mounted) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-foreground/[0.04] text-muted-foreground border border-border">
        <Hourglass className="h-3 w-3" /> …
      </span>
    );
  }
  const diffMs = new Date(dueAtISO).getTime() - Date.now();
  if (diffMs > 0) {
    const h = Math.round(diffMs / 3600e3);
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
        <Hourglass className="h-3 w-3" /> {h <= 1 ? '<1h' : `${h}h left`}
      </span>
    );
  }
  const overH = Math.round(-diffMs / 3600e3);
  const breached = overH >= 2;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full ${
        breached ? 'bg-red-100 text-red-800 border border-red-300 animate-pulse' : 'bg-amber-100 text-amber-800 border border-amber-300'
      }`}
    >
      <AlertCircle className="h-3 w-3" />
      {breached ? `BREACHED +${overH}h` : `Overdue ${overH || '<1'}h`}
    </span>
  );
}

export function QuoteRow(p: QuoteRowProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const pri = PRIORITY_STYLE[p.priority] ?? PRIORITY_STYLE.NORMAL;
  const deal = computeDealState({
    status: p.status,
    lastReplyByStaff: p.lastReplyByStaff,
    proformaNumber: p.proformaNumber,
    linkedOrder: p.linkedOrderStatus ? { status: p.linkedOrderStatus } : null,
  });
  const dt = toneClasses(deal.tone);

  // Left stripe color reads priority first, then deal state.
  const stripe =
    p.priority === 'VIP' ? 'before:bg-purple-500'
      : p.priority === 'URGENT' ? 'before:bg-red-500'
      : p.priority === 'HIGH' ? 'before:bg-amber-400'
      : deal.tone === 'amber' ? 'before:bg-amber-300'
      : deal.tone === 'sky' ? 'before:bg-sky-400'
      : deal.tone === 'emerald' ? 'before:bg-emerald-500'
      : deal.tone === 'purple' ? 'before:bg-purple-500'
      : deal.tone === 'red' ? 'before:bg-red-400'
      : 'before:bg-slate-300';

  const isRepeatBuyer = p.buyerPaidOrders > 0;
  const amountColor =
    deal.state === 'won_paid' ? 'text-emerald-700'
      : deal.state.startsWith('won_') ? 'text-purple-700'
      : deal.state === 'proforma_sent' ? 'text-sky-700'
      : deal.state === 'awaiting_buyer' ? 'text-sky-700'
      : 'text-foreground';

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

      <Link href={`/admin/quotes/${p.id}`} className="block hover:bg-foreground/[0.02]">
        <div className={`pl-4 pr-4 py-4 grid grid-cols-1 ${p.selectable ? 'lg:grid-cols-[24px_minmax(0,1fr)_240px]' : 'lg:grid-cols-[minmax(0,1fr)_240px]'} gap-x-5 gap-y-3 items-center`}>
          {p.selectable && (
            <div className="flex items-center justify-center">
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

          {/* MAIN — subject + meta + customer + signals */}
          <div className="min-w-0 space-y-2">
            {/* Row 1: subject (bold) + priority/SLA */}
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{p.ref_}</span>
              {pri.label && (
                <span className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full border ${pri.cls}`}>
                  {pri.icon}{pri.label}
                </span>
              )}
              <SlaBadge dueAtISO={p.dueAtISO} status={p.status} mounted={mounted} />
              {p.customerType === 'GUEST' && (
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0.5">
                  guest
                </span>
              )}
              <h3 className="font-bold text-[15px] leading-tight tracking-tight truncate min-w-0 flex-1">
                {p.subject}
              </h3>
            </div>

            {/* Row 2: customer + repeat-buyer */}
            <div className="flex items-center gap-3 flex-wrap text-xs">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-6 w-6 rounded-full bg-primary/10 text-primary text-[10px] font-bold inline-flex items-center justify-center">
                  {initials(p.buyerName, p.buyerEmail)}
                </span>
                <span className="font-semibold">{p.buyerName}</span>
                {p.company && (
                  <span className="text-muted-foreground inline-flex items-center gap-1">
                    <Building2 className="h-3 w-3" /> {p.company}
                  </span>
                )}
              </span>
              {isRepeatBuyer ? (
                <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 px-1.5 py-0.5" title="Past paid orders">
                  <TrendingUp className="h-3 w-3" /> repeat · {p.buyerPaidOrders}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0.5">
                  new buyer
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Mail className="h-3 w-3" />
                <EmailText email={p.buyerEmail} className="hover:text-foreground" />
              </span>
            </div>

            {/* Row 3: signals (recency · messages · attach · notes · proforma) */}
            <div className="flex items-center gap-3 flex-wrap text-[11px] text-muted-foreground">
              {p.lastReplyAtISO && (
                <span className="inline-flex items-center gap-1" title="Last activity">
                  <span className={`h-1.5 w-1.5 rounded-full ${p.lastReplyByStaff ? 'bg-sky-500' : 'bg-amber-500'}`} />
                  {mounted ? timeAgo(p.lastReplyAtISO) : '…'} ago · {p.lastReplyByStaff ? 'staff' : 'buyer'}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <MessageSquare className="h-3 w-3" /> {p.messageCount}
              </span>
              {p.attachmentCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Paperclip className="h-3 w-3" /> {p.attachmentCount}
                </span>
              )}
              {p.internalNoteCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Lock className="h-3 w-3" /> {p.internalNoteCount}
                </span>
              )}
              {p.proformaNumber && (
                <span className="inline-flex items-center gap-1 font-mono">
                  <FileText className="h-3 w-3" /> {p.proformaNumber}
                </span>
              )}
            </div>
          </div>

          {/* RIGHT RAIL — dominant amount + deal state + assignee + actions */}
          <div className="flex flex-col items-end gap-2 self-start">
            {p.quotedPriceCents != null ? (
              <p className={`text-2xl font-bold tabular-nums tracking-tight leading-none ${amountColor}`}>
                {fmtMoney(p.quotedPriceCents, p.quotedCurrency ?? 'EUR')}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground italic">no proforma yet</p>
            )}
            <DealStateBadge badge={deal} />
            <div className="flex items-center gap-1.5">
              <AssigneeBadge
                quoteId={p.id}
                assignee={p.assignee}
                myUserId={p.myUserId}
                admins={p.admins ?? []}
                variant="compact"
              />
              {!p.archived ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={(e) => {
                    e.preventDefault(); e.stopPropagation();
                    start(async () => {
                      const fd = new FormData(); fd.set('quoteId', p.id);
                      try { await archiveQuote(fd); router.refresh(); }
                      catch (err) { alert(err instanceof Error ? err.message : 'Archive failed'); }
                    });
                  }}
                  className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-foreground/5 disabled:opacity-50"
                  title="Archive"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={(e) => {
                      e.preventDefault(); e.stopPropagation();
                      start(async () => {
                        const fd = new FormData(); fd.set('quoteId', p.id);
                        try { await unarchiveQuote(fd); router.refresh(); }
                        catch (err) { alert(err instanceof Error ? err.message : 'Restore failed'); }
                      });
                    }}
                    className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-700 hover:bg-foreground/5 disabled:opacity-50"
                    title="Restore"
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={(e) => {
                      e.preventDefault(); e.stopPropagation();
                      if (!confirm(`Permanently delete ${p.ref_}? This cannot be undone.`)) return;
                      start(async () => {
                        const fd = new FormData(); fd.set('quoteId', p.id);
                        try {
                          const r = await deleteQuotePermanently(fd);
                          if (!r.ok) alert(r.message);
                          router.refresh();
                        } catch (err) { alert(err instanceof Error ? err.message : 'Delete failed'); }
                      });
                    }}
                    className="inline-flex items-center justify-center h-7 w-7 rounded-md text-red-700 hover:bg-red-50 disabled:opacity-50"
                    title="Delete permanently"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}
