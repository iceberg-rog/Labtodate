'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  X,
  Loader2,
  Mail,
  CheckCircle2,
  XCircle,
  Building2,
  Phone,
  ExternalLink,
  ShoppingBag,
  FileText,
  Wrench,
  LifeBuoy,
  MessageSquare,
  Heart,
  ShoppingCart,
  Bell,
  Calendar,
  ShieldCheck,
} from 'lucide-react';
import { getAdminUserSummary } from '@/app/admin/actions';

type Summary = NonNullable<Awaited<ReturnType<typeof getAdminUserSummary>>>;

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'admin',
  BUYER: 'buyer',
  SELLER: 'internal supplier', // we don't sell "seller" externally — internal label only
};

const ROLE_BADGE: Record<string, string> = {
  ADMIN: 'bg-violet-100 text-violet-800',
  BUYER: 'bg-foreground/10 text-foreground',
  SELLER: 'bg-sky-100 text-sky-800',
};

function fmt(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function timeAgo(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const day = 864e5;
  if (diff < day) return 'today';
  if (diff < 2 * day) return 'yesterday';
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return d.toLocaleDateString('en-US', { dateStyle: 'medium' });
}

export function UserQuickView() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [data, setData] = useState<Summary | null>(null);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function handler(e: Event) {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      setOpenId(id);
      setData(null);
      setErr(null);
      start(async () => {
        try {
          const r = await getAdminUserSummary(id);
          if (!r) setErr('User not found.');
          else setData(r);
        } catch (e) {
          setErr(e instanceof Error ? e.message : 'Failed to load.');
        }
      });
    }
    window.addEventListener('admin:userquick', handler);
    return () => window.removeEventListener('admin:userquick', handler);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenId(null);
    }
    if (openId) {
      window.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [openId]);

  if (!openId) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" role="dialog" aria-modal>
      <button
        type="button"
        aria-label="Close"
        onClick={() => setOpenId(null)}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="relative w-full md:max-w-2xl bg-card border border-border md:rounded-2xl shadow-xl max-h-[92vh] overflow-auto">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 p-5 border-b border-border bg-card">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              User detail
            </p>
            {data ? (
              <>
                <h2 className="text-lg font-bold truncate">{data.name}</h2>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">{data.email}</p>
              </>
            ) : (
              <h2 className="text-lg font-bold">Loading…</h2>
            )}
          </div>
          <button
            type="button"
            onClick={() => setOpenId(null)}
            className="p-1.5 rounded-lg hover:bg-foreground/5 text-muted-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {pending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Fetching user activity…
            </div>
          )}
          {err && <p className="text-sm text-red-600">{err}</p>}

          {data && (
            <>
              <div className="flex items-center gap-3 flex-wrap text-xs">
                <span className={`px-2 py-1 rounded-full font-bold uppercase ${ROLE_BADGE[data.role] ?? 'bg-foreground/10'}`}>
                  {ROLE_LABEL[data.role] ?? data.role.toLowerCase()}
                </span>
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Mail className="h-3 w-3" />
                  {data.emailVerified ? (
                    <span className="text-emerald-600 font-semibold">verified</span>
                  ) : (
                    <span className="text-amber-600 font-semibold">unverified</span>
                  )}
                </span>
                {data.company && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Building2 className="h-3 w-3" /> {data.company}
                  </span>
                )}
                {data.phone && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Phone className="h-3 w-3" /> {data.phone}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Calendar className="h-3 w-3" /> joined {timeAgo(data.joined)}
                </span>
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5">
                <Stat icon={<ShoppingBag className="h-3.5 w-3.5" />} label="Orders" value={String(data.totals.orders)} />
                <Stat icon={<FileText className="h-3.5 w-3.5" />} label="Spend" value={fmt(data.totals.spendCents, data.totals.currency)} accent />
                <Stat icon={<FileText className="h-3.5 w-3.5" />} label="Quotes" value={String(data.totals.sourcing)} />
                <Stat icon={<Wrench className="h-3.5 w-3.5" />} label="Sell offers" value={String(data.totals.sells)} />
                <Stat icon={<LifeBuoy className="h-3.5 w-3.5" />} label="Tickets" value={String(data.totals.tickets)} />
                <Stat icon={<MessageSquare className="h-3.5 w-3.5" />} label="Chats" value={String(data.totals.threads)} />
                <Stat icon={<Heart className="h-3.5 w-3.5" />} label="Wishlist" value={String(data.totals.wishlist)} />
                <Stat icon={<ShoppingCart className="h-3.5 w-3.5" />} label="Cart" value={String(data.totals.cart)} />
              </div>

              {data.caps.length > 0 && (
                <div className="rounded-xl border border-border bg-foreground/[0.02] p-3">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5 inline-flex items-center gap-1">
                    <ShieldCheck className="h-3 w-3" /> Admin capabilities
                  </p>
                  <p className="font-mono text-[11px] text-foreground break-words">{data.caps.join(', ')}</p>
                </div>
              )}

              <RecentBlock label="Last order" item={data.recent.lastOrder ? {
                title: data.recent.lastOrder.number,
                sub: data.recent.lastOrder.status.toLowerCase(),
                date: data.recent.lastOrder.createdAt,
                href: `/admin/orders?q=${data.recent.lastOrder.number}`,
              } : null} />

              <RecentBlock label="Last support ticket" item={data.recent.lastTicket ? {
                title: data.recent.lastTicket.subject,
                sub: `${data.recent.lastTicket.ref} · ${data.recent.lastTicket.status.toLowerCase()}`,
                date: data.recent.lastTicket.createdAt,
                href: `/admin/tickets?q=${data.recent.lastTicket.ref}`,
              } : null} />

              <RecentBlock label="Last quote request" item={data.recent.lastSourcing ? {
                title: data.recent.lastSourcing.description.slice(0, 90) || 'Quote request',
                sub: data.recent.lastSourcing.status.toLowerCase(),
                date: data.recent.lastSourcing.createdAt,
                href: `/app/quotes/${data.recent.lastSourcing.id}`,
              } : null} />

              <div className="flex items-center justify-between gap-3 pt-3 border-t border-border flex-wrap">
                <Link
                  href={`/admin/users/${data.id}`}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-primary text-primary-foreground text-xs font-semibold"
                >
                  Open full profile →
                </Link>
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Bell className="h-3 w-3" /> {data.totals.notifications} notifications sent
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${accent ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'}`}>
      <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] uppercase tracking-wider font-bold">
        {icon} {label}
      </div>
      <p className={`text-lg font-bold tabular-nums mt-1 ${accent ? 'text-primary' : ''}`}>{value}</p>
    </div>
  );
}

function RecentBlock({ label, item }: { label: string; item: { title: string; sub: string; date: string; href: string } | null }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">{label}</p>
      {item ? (
        <Link
          href={item.href}
          className="rounded-xl border border-border bg-card p-3 flex items-center gap-3 hover:bg-foreground/[0.03] transition-colors block"
        >
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate">{item.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{item.sub}</p>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">{timeAgo(item.date)}</span>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </Link>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-3 text-xs text-muted-foreground">None.</div>
      )}
    </div>
  );
}

/** Trigger element rendered inside a server-component row. Dispatches a custom
 *  event picked up by <UserQuickView/> mounted once at page root. */
export function UserQuickTrigger({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('admin:userquick', { detail: { id } }));
      }}
      className={className}
    >
      {children}
    </button>
  );
}
