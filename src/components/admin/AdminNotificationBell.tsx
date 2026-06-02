'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bell,
  CheckCheck,
  Truck,
  Package,
  CreditCard,
  AlertOctagon,
  FileText,
  LifeBuoy,
  Wrench,
  Megaphone,
  ShoppingBag,
  Sparkles,
} from 'lucide-react';
import {
  getMyAdminNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '@/app/admin/actions';

type Item = Awaited<ReturnType<typeof getMyAdminNotifications>>['items'][number];

const KIND_ICON: Record<string, React.ReactNode> = {
  ORDER_NEW: <ShoppingBag className="h-3.5 w-3.5 text-amber-700" />,
  ORDER_PAID: <CreditCard className="h-3.5 w-3.5 text-emerald-700" />,
  PAYMENT_SUBMITTED: <CreditCard className="h-3.5 w-3.5 text-sky-700" />,
  PAYMENT_VERIFIED: <CreditCard className="h-3.5 w-3.5 text-emerald-700" />,
  PAYMENT_REJECTED: <AlertOctagon className="h-3.5 w-3.5 text-amber-700" />,
  ORDER_SHIPPED: <Truck className="h-3.5 w-3.5 text-violet-700" />,
  ORDER_DELIVERED: <Package className="h-3.5 w-3.5 text-emerald-700" />,
  ORDER_REFUNDED: <AlertOctagon className="h-3.5 w-3.5 text-red-700" />,
  ORDER_CANCELED: <AlertOctagon className="h-3.5 w-3.5 text-slate-600" />,
  SHIPPING_MISSING: <AlertOctagon className="h-3.5 w-3.5 text-red-700" />,
  QUOTE_NEW: <FileText className="h-3.5 w-3.5 text-sky-700" />,
  QUOTE_APPROVED: <FileText className="h-3.5 w-3.5 text-emerald-700" />,
  ORDER_FROM_QUOTE: <ShoppingBag className="h-3.5 w-3.5 text-emerald-700" />,
  TICKET_NEW: <LifeBuoy className="h-3.5 w-3.5 text-red-700" />,
  SELL_NEW: <Wrench className="h-3.5 w-3.5 text-amber-700" />,
  ANNOUNCEMENT: <Megaphone className="h-3.5 w-3.5 text-primary" />,
  SYSTEM: <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />,
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600e3) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}h`;
  return `${Math.floor(diff / 86400e3)}d`;
}

export function AdminNotificationBell({ initialCount }: { initialCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(initialCount);
  const [items, setItems] = useState<Item[]>([]);
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  // Refresh count every 60s in the background so the bell stays live without
  // forcing a full page reload.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await getMyAdminNotifications();
        if (!cancelled) {
          setCount(r.unreadCount);
          setItems(r.items);
        }
      } catch {/* ignore */}
    }
    tick();
    const iv = setInterval(tick, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  // Close on click outside / Escape.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    if (open) {
      document.addEventListener('mousedown', onDoc);
      window.addEventListener('keydown', onKey);
    }
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function handleItemClick(n: Item) {
    if (!n.readAt) {
      // Optimistic
      setCount((c) => Math.max(0, c - 1));
      setItems((arr) => arr.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      start(() => markNotificationRead(n.id).catch(() => {}));
    }
    setOpen(false);
    if (n.href) router.push(n.href);
  }

  function handleMarkAll() {
    setCount(0);
    setItems((arr) => arr.map((x) => x.readAt ? x : { ...x, readAt: new Date().toISOString() }));
    start(() => markAllNotificationsRead().catch(() => {}));
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex items-center justify-center h-9 w-9 rounded-full hover:bg-foreground/5 transition-colors"
        aria-label={`${count} unread notification${count === 1 ? '' : 's'}`}
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <>
            <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold leading-4 text-center">
              {count > 99 ? '99+' : count}
            </span>
            <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-red-400 animate-ping opacity-40" />
          </>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[380px] rounded-2xl border border-border bg-card shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-foreground/[0.02]">
            <p className="text-sm font-bold">
              Notifications {count > 0 && <span className="text-red-600">({count} unread)</span>}
            </p>
            {count > 0 && (
              <button
                type="button"
                onClick={handleMarkAll}
                className="text-[11px] font-semibold text-primary hover:underline inline-flex items-center gap-1"
              >
                <CheckCheck className="h-3 w-3" /> Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-[480px] overflow-auto divide-y divide-border">
            {items.length === 0 ? (
              <li className="p-8 text-center text-sm text-muted-foreground">
                No notifications yet.
              </li>
            ) : (
              items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => handleItemClick(n)}
                    className={`w-full text-left p-3 hover:bg-foreground/[0.03] flex items-start gap-3 transition-colors ${
                      !n.readAt ? 'bg-primary/[0.025]' : ''
                    }`}
                  >
                    <span className="mt-0.5 flex-shrink-0">
                      {KIND_ICON[n.kind] ?? KIND_ICON.SYSTEM}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm leading-tight ${!n.readAt ? 'font-bold' : 'font-medium text-foreground/80'}`}>
                        {n.title}
                      </p>
                      <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{n.body}</p>
                      <p className="text-[10px] text-muted-foreground/70 mt-1">{timeAgo(n.createdAt)}</p>
                    </div>
                    {!n.readAt && (
                      <span className="mt-1 h-2 w-2 rounded-full bg-red-500 flex-shrink-0" />
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="px-4 py-2 border-t border-border bg-foreground/[0.02] text-center">
            <Link
              href="/app/notifications"
              onClick={() => setOpen(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Open full notifications →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
