'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ShoppingBag, X, ArrowRight } from 'lucide-react';
import { getMyAdminNotifications } from '@/app/admin/actions';

type Notif = Awaited<ReturnType<typeof getMyAdminNotifications>>['items'][number];

const KEY = 'l2d_lastSeenNotifAt';
const TRIGGER_KINDS = new Set([
  'ORDER_NEW',
  'ORDER_PAID',
  'PAYMENT_SUBMITTED',
  'PAYMENT_VERIFIED',
  'PAYMENT_REJECTED',
  'SHIPPING_MISSING',
  'QUOTE_APPROVED',
  'ORDER_FROM_QUOTE',
  // Slice A support desk events: any new ticket / customer reply should
  // also surface a toast — the bell badge alone is too easy to miss while
  // operators are elsewhere in /admin.
  'TICKET_NEW',
]);

/**
 * Background poller. Fires a slide-in toast in the bottom-right when a NEW
 * admin notification appears (ORDER_NEW / ORDER_PAID / SHIPPING_MISSING).
 *
 * Uses a per-browser localStorage marker so reloads don't re-pop old events.
 */
export function NewOrderToast() {
  const [toast, setToast] = useState<Notif | null>(null);

  useEffect(() => {
    let cancelled = false;
    let lastSeen = (typeof window !== 'undefined' && window.localStorage.getItem(KEY)) || new Date().toISOString();

    async function tick() {
      try {
        const r = await getMyAdminNotifications();
        if (cancelled) return;
        // Find the first new trigger-kind notification we haven't seen.
        const fresh = r.items.find((n) => n.createdAt > lastSeen && TRIGGER_KINDS.has(n.kind));
        if (fresh) {
          setToast(fresh);
          lastSeen = fresh.createdAt;
          try { window.localStorage.setItem(KEY, lastSeen); } catch {/* */}
        }
      } catch {/* */}
    }
    const iv = setInterval(tick, 30_000);
    // First check after 2s so we don't double-bell with bell init.
    const t = setTimeout(tick, 2_000);
    return () => { cancelled = true; clearInterval(iv); clearTimeout(t); };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 12_000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[70] w-[340px] rounded-2xl border border-primary/40 bg-card shadow-[0_20px_50px_-20px_rgba(15,79,64,0.45)] overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
      <div className="px-4 py-3 border-b border-border bg-primary text-primary-foreground flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wider inline-flex items-center gap-1.5">
          <ShoppingBag className="h-3.5 w-3.5" /> New event
        </p>
        <button type="button" onClick={() => setToast(null)} className="opacity-80 hover:opacity-100">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-4">
        <p className="font-bold text-sm leading-tight">{toast.title}</p>
        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{toast.body}</p>
        {toast.href && (
          <Link
            href={toast.href}
            onClick={() => setToast(null)}
            className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
          >
            Open <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    </div>
  );
}
