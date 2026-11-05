'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { CONDITION_OPTIONS, FIELD_LABEL, MODE_OPTIONS, type InventoryRow } from '@/lib/inventory/fields';
import { createInventoryItem, getItemHistory, getReservations, type HistoryEntry } from '@/app/admin/inventory/actions';
import type { ReservationLine } from '@/lib/inventory/stock';

export type Toast = { id: string; kind: 'success' | 'info' | 'warn' | 'error'; text: string };

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex w-[min(420px,calc(100vw-32px))] flex-col gap-2" aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm shadow-lg bg-card ${
            t.kind === 'error' ? 'border-red-500/50' : t.kind === 'warn' ? 'border-amber-500/50' : t.kind === 'success' ? 'border-emerald-500/50' : 'border-border'
          }`}
        >
          {t.kind === 'error' || t.kind === 'warn' ? (
            <AlertTriangle className={`h-4 w-4 mt-0.5 shrink-0 ${t.kind === 'error' ? 'text-red-500' : 'text-amber-500'}`} />
          ) : t.kind === 'success' ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-500" />
          ) : (
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1">{t.text}</span>
          <button type="button" onClick={() => onDismiss(t.id)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  PROCESSING: 'Processing',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELED: 'Canceled',
  REFUNDED: 'Refunded',
};

const SOURCE_LABEL: Record<string, string> = { GRID: 'sheet', BULK: 'bulk edit', IMPORT: 'import', SYSTEM: 'system' };

export function ReservedPopover({ id, rect, onClose }: { id: string; rect: DOMRect; onClose: () => void }) {
  const [lines, setLines] = useState<ReservationLine[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEscape(onClose);
  useEffect(() => {
    getReservations(id).then(setLines).catch(() => setFailed(true));
  }, [id]);
  const top = Math.min(rect.bottom + 6, window.innerHeight - 260);
  const left = Math.max(12, Math.min(rect.left - 120, window.innerWidth - 352));
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div role="dialog" aria-label="Reserved units" className="fixed z-50 w-[340px] rounded-xl border border-border bg-card p-3 shadow-2xl text-sm" style={{ top, left }}>
        <p className="font-semibold">Reserved in orders that have not shipped</p>
        {!lines && !failed && <Loader2 className="h-4 w-4 animate-spin mt-2" />}
        {failed && <p className="text-red-600 mt-2">Could not load the orders.</p>}
        {lines && lines.length === 0 && <p className="text-muted-foreground mt-2">None right now.</p>}
        {lines && lines.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {lines.map((l) => (
              <li key={l.orderNumber} className="flex items-center justify-between gap-2">
                <Link href={`/admin/orders/${l.orderId}`} className="font-mono text-xs text-primary hover:underline">
                  {l.orderNumber}
                </Link>
                <span className="text-xs text-muted-foreground truncate">{l.buyer}</span>
                <span className="text-xs whitespace-nowrap">
                  {l.quantity} × {l.kind === 'proforma' ? 'accepted offer, awaiting payment (not reserved yet)' : STATUS_LABEL[l.status] ?? l.status}
                  {l.sold !== null && <span className="block text-amber-600 dark:text-amber-400">sold {l.sold}, only {l.quantity} {l.quantity === 1 ? 'was' : 'were'} in stock</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Units leave On hand when the order is marked shipped. A canceled or refunded order gives them back.</p>
      </div>
    </>
  );
}

export function HistoryDrawer({ id, row, onClose }: { id: string; row: InventoryRow | null; onClose: () => void }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEscape(onClose);
  useEffect(() => {
    setEntries(null);
    getItemHistory(id).then(setEntries).catch(() => setFailed(true));
  }, [id, row?.updatedAt]);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside role="dialog" aria-label="Item history" className="fixed right-0 top-0 z-50 h-full w-[min(440px,100vw)] overflow-y-auto border-l border-border bg-card p-5 shadow-2xl" data-testid="history-drawer">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-bold">History</p>
            <h2 className="text-lg font-bold leading-snug mt-1">{row?.title ?? 'Item'}</h2>
            {row && (
              <p className="text-xs text-muted-foreground mt-1">
                {[row.sku, row.mpn, row.location].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {row && (
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <Stat label="On hand" value={row.onHand} />
            <Stat label="Reserved" value={row.reserved} />
            <Stat label="Available" value={row.available} />
          </div>
        )}
        {!entries && !failed && <Loader2 className="h-5 w-5 animate-spin mt-6" />}
        {failed && <p className="mt-6 text-sm text-red-600">Could not load the history.</p>}
        {entries && entries.length === 0 && <p className="mt-6 text-sm text-muted-foreground">No changes recorded yet.</p>}
        {entries && entries.length > 0 && (
          <ol className="mt-6 space-y-3">
            {entries.map((e, i) => (
              <li key={i} className="border-l-2 border-border pl-3">
                <p className="text-[11px] text-muted-foreground">
                  {new Date(e.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  {e.kind === 'change' && (
                    <>
                      {' · '}
                      {e.actor ?? 'system'} via {SOURCE_LABEL[e.source ?? ''] ?? e.source}
                    </>
                  )}
                </p>
                {e.kind === 'change' ? (
                  <p className="text-sm">
                    <b>{e.field === 'created' ? 'Created' : FIELD_LABEL[e.field ?? ''] ?? e.field}</b>{' '}
                    {e.field === 'created' ? (
                      <span>{e.to}</span>
                    ) : (
                      <>
                        <span className="text-muted-foreground line-through">{e.from || 'empty'}</span> → <span className="font-medium">{e.to || 'empty'}</span>
                      </>
                    )}
                  </p>
                ) : (
                  <p className="text-sm">
                    Order{' '}
                    <Link href={`/admin/orders/${e.order!.id}`} className="font-mono text-primary hover:underline">
                      {e.order!.number}
                    </Link>{' '}
                    · {e.order!.quantity} unit{e.order!.quantity === 1 ? '' : 's'} · {STATUS_LABEL[e.order!.status] ?? e.order!.status}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </aside>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/50 py-2">
      <p className="text-lg font-bold tabular-nums">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

export function NewItemDialog({
  categories,
  defaults,
  canPublish,
  onClose,
  onCreated,
}: {
  categories: { name: string; slug: string }[];
  defaults: { mode: string; condition: string };
  canPublish: boolean;
  onClose: () => void;
  onCreated: (row: InventoryRow, notes: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEscape(onClose);
  useEffect(() => first.current?.focus(), []);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await createInventoryItem({
        title: String(f.get('title') ?? ''),
        category: String(f.get('category') ?? ''),
        condition: String(f.get('condition') ?? ''),
        mode: String(f.get('mode') ?? ''),
        onHand: String(f.get('onHand') ?? ''),
        priceCents: String(f.get('price') ?? ''),
        publish: f.get('publish') === 'on',
      });
      if (!res.ok) setError(res.message);
      else onCreated(res.row, res.notes);
    } catch {
      setError('Could not reach the server. Nothing was saved.');
    }
    setBusy(false);
  };
  const field = 'mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm';
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <form onSubmit={submit} role="dialog" aria-label="New stock item" className="fixed left-1/2 top-[10vh] z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border border-border bg-card p-6 shadow-2xl space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">New stock item</h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">This also creates its listing{canPublish ? '' : ' as a draft'}. Add photos and a description later on the product page.</p>
        <label className="block text-sm font-medium">
          Name
          <input ref={first} name="title" required minLength={2} maxLength={200} className={field} placeholder="e.g. Agilent G1312-60010 solenoid assembly" />
        </label>
        <label className="block text-sm font-medium">
          Category
          <select name="category" required className={field} defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {categories.map((c) => (
              <option key={c.slug} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">
            Condition
            <select name="condition" className={field} defaultValue={defaults.condition}>
              {CONDITION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Sale mode
            <select name="mode" className={field} defaultValue={defaults.mode}>
              {MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            On hand
            <input name="onHand" inputMode="numeric" defaultValue="1" className={field} />
          </label>
          <label className="block text-sm font-medium">
            Selling price (€)
            <input name="price" inputMode="decimal" placeholder="optional" className={field} />
          </label>
        </div>
        {canPublish && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="publish" /> Publish on the site right away
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="h-10 px-4 rounded-full border border-border text-sm font-semibold">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="h-10 px-5 rounded-full bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Add item
          </button>
        </div>
      </form>
    </>
  );
}
