'use client';

import { useStepUp } from '@/components/security/useStepUp';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { XCircle, Loader2, CheckSquare, Square, Truck, Download, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { OrderRow, type OrderRowProps } from './OrderRow';
import { ManualPaidPanel, openManualPaid } from './ManualPaidPanel';
import { announceAdminResult } from './AdminResultToast';
import {
  bulkCancelOrders,
  bulkArchiveOrders,
  bulkUnarchiveOrders,
  bulkDeleteOrders,
} from '@/app/admin/actions';
import { bulkShipAction } from '@/app/admin/fulfilment-actions';

export type CarrierOption = { name: string; needsTracking: boolean };

type Row = Omit<OrderRowProps, 'selected' | 'onToggleSelect' | 'onOpenManualPaid'>;

const FAILED = 'Something went wrong — refresh to see what changed, then retry.';

// Result text is unioned across action returns + errors, so we always have a
// string to render even if a server action returns nothing (e.g. transparent
// redirect on cap mismatch).
function resultText(r: unknown, fallback: string): string {
  if (r && typeof r === 'object' && 'message' in r && typeof (r as { message: unknown }).message === 'string') {
    return (r as { message: string }).message;
  }
  return fallback;
}

/**
 * Report a bulk result. A success goes to the admin-wide toast: the refresh
 * that follows can empty this list (the page then renders its empty state
 * instead of this shell), and an inline result went with it. A failure
 * changed nothing, so it stays inline under the bulk bar.
 */
function report(
  setResult: (r: { ok: boolean; text: string } | null) => void,
  ok: boolean,
  text: string,
) {
  if (ok) {
    announceAdminResult({ ok, message: text });
    setResult(null);
  } else {
    setResult({ ok, text });
  }
}

export function OrdersListShell({ rows, view, carriers = [], cancelReasons = [] }: { rows: Row[]; view?: 'archived' | 'awaiting_verify' | 'invoice_hold' | 'refunds_open' | ''; carriers?: CarrierOption[]; cancelReasons?: string[] }) {
  const router = useRouter();
  // Permanent delete asks for a fresh authenticator code (Settings → Security).
  const { run: withStepUp, dialog: stepUpDialog } = useStepUp();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<'cancel' | 'ship' | 'archive' | 'unarchive' | 'delete' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const isArchivedView = view === 'archived';
  // Bulk ship: one carrier + tracking number per order (the server checks
  // address, billing details, holds and the tracking rule for each).
  const [shipRows, setShipRows] = useState<Record<string, { carrier: string; tracking: string }>>({});
  const [cancelReason, setCancelReason] = useState('');

  // Reset selection when the row list changes (router.refresh).
  useEffect(() => {
    setSelected((s) => new Set(Array.from(s).filter((id) => rows.some((r) => r.id === id))));
  }, [rows]);

  const allOnPage = rows.map((r) => r.id);
  const allSelected = allOnPage.length > 0 && allOnPage.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  const cancelable = useMemo(
    () => rows.filter((r) => selected.has(r.id) && r.status === 'PENDING_PAYMENT'),
    [rows, selected],
  );
  const shippable = useMemo(
    () => rows.filter((r) => selected.has(r.id) && (r.status === 'PAID' || r.status === 'PROCESSING')),
    [rows, selected],
  );

  function toggleOne(id: string, on: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function toggleAll(on: boolean) {
    setSelected(on ? new Set(allOnPage) : new Set());
  }

  function runCancel() {
    setResult(null);
    start(async () => {
      const fd = new FormData();
      fd.set('ids', cancelable.map((r) => r.id).join(','));
      fd.set('reason', cancelReason);
      try {
        const r = await bulkCancelOrders(fd);
        report(setResult, !!r?.ok, resultText(r, 'Cancelled.'));
        if (r?.ok) { setSelected(new Set()); router.refresh(); }
      } catch {
        setResult({ ok: false, text: FAILED });
      }
      setConfirm(null);
    });
  }
  function runShip() {
    setResult(null);
    start(async () => {
      // Only the selected PAID/PROCESSING rows, each with its own carrier + tracking.
      const fd = new FormData();
      fd.set('rows', JSON.stringify(shippable.map((r) => ({ orderId: r.id, carrier: shipRows[r.id]?.carrier ?? '', tracking: shipRows[r.id]?.tracking ?? '' }))));
      try {
        const r = await bulkShipAction(fd);
        // Partial outcomes stay inline (every refused order says why).
        if (r?.ok && r.shipped === shippable.length) report(setResult, true, resultText(r, 'Shipped.'));
        else setResult({ ok: !!r?.ok, text: resultText(r, 'Nothing shipped.') });
        if (r?.ok) { setSelected(new Set()); setShipRows({}); router.refresh(); }
      } catch {
        setResult({ ok: false, text: FAILED });
      }
      setConfirm(null);
    });
  }
  function runArchive() {
    setResult(null);
    start(async () => {
      const fd = new FormData();
      fd.set('ids', Array.from(selected).join(','));
      try {
        const r = await bulkArchiveOrders(fd);
        report(setResult, !!r?.ok, resultText(r, 'Archived.'));
        if (r?.ok) { setSelected(new Set()); router.refresh(); }
      } catch {
        setResult({ ok: false, text: FAILED });
      }
      setConfirm(null);
    });
  }
  function runUnarchive() {
    setResult(null);
    start(async () => {
      const fd = new FormData();
      fd.set('ids', Array.from(selected).join(','));
      try {
        const r = await bulkUnarchiveOrders(fd);
        report(setResult, !!r?.ok, resultText(r, 'Restored.'));
        if (r?.ok) { setSelected(new Set()); router.refresh(); }
      } catch {
        setResult({ ok: false, text: FAILED });
      }
      setConfirm(null);
    });
  }
  function runDelete() {
    setResult(null);
    start(async () => {
      const fd = new FormData();
      fd.set('ids', Array.from(selected).join(','));
      try {
        const r = await withStepUp(() => bulkDeleteOrders(fd));
        report(setResult, !!r?.ok, resultText(r, 'Deleted.'));
        if (r?.ok) { setSelected(new Set()); router.refresh(); }
      } catch {
        setResult({ ok: false, text: FAILED });
      }
      setConfirm(null);
    });
  }

  return (
    <>
      {stepUpDialog}
      {/* Sticky select-all + bulk bar */}
      <div className="sticky top-14 z-20 -mx-px">
        <div className={`rounded-2xl border border-border bg-card/95 backdrop-blur p-3 transition-colors ${selected.size > 0 ? 'ring-2 ring-primary/30' : ''}`}>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="inline-flex items-center gap-2 cursor-pointer text-sm font-semibold">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = someSelected; }}
                onChange={(e) => toggleAll(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              {allSelected ? (
                <span className="inline-flex items-center gap-1"><CheckSquare className="h-3.5 w-3.5" /> All on page</span>
              ) : someSelected ? (
                <span className="inline-flex items-center gap-1 text-primary">{selected.size} selected</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground"><Square className="h-3.5 w-3.5" /> Select all visible</span>
              )}
            </label>

            {selected.size > 0 && (
              <>
                <div className="ml-auto flex items-center gap-2 flex-wrap">
                  {/* Live-queue actions: hidden in the Archived view since
                   *  shipping/cancelling archived rows is nonsensical. */}
                  {!isArchivedView && shippable.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setConfirm('ship')}
                      disabled={pending}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90"
                    >
                      <Truck className="h-3.5 w-3.5" /> Ship {shippable.length} selected…
                    </button>
                  )}
                  {!isArchivedView && cancelable.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setConfirm('cancel')}
                      disabled={pending}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-amber-300 bg-white text-amber-800 text-xs font-bold hover:bg-amber-50 dark:bg-transparent dark:text-amber-300 dark:border-amber-800"
                    >
                      <XCircle className="h-3.5 w-3.5" /> Cancel {cancelable.length} pending
                    </button>
                  )}
                  <a
                    href={`/admin/orders/export${selected.size > 0 ? `?ids=${Array.from(selected).join(',')}` : ''}`}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-card text-xs font-semibold hover:bg-foreground/5"
                  >
                    <Download className="h-3.5 w-3.5" /> Export {selected.size}
                  </a>
                  {/* Archive vs Restore + Delete swap based on which tab we're
                   *  on. Delete is irreversible — sits last + red to slow the
                   *  click. */}
                  {!isArchivedView ? (
                    <button
                      type="button"
                      onClick={() => setConfirm('archive')}
                      disabled={pending}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-card text-muted-foreground text-xs font-bold hover:bg-muted"
                    >
                      <Archive className="h-3.5 w-3.5" /> Archive {selected.size}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setConfirm('unarchive')}
                        disabled={pending}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-card text-muted-foreground text-xs font-bold hover:bg-muted"
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" /> Restore {selected.size}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirm('delete')}
                        disabled={pending}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-red-300 bg-white text-red-800 text-xs font-bold hover:bg-red-50 dark:bg-transparent dark:text-red-300 dark:border-red-800"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete {selected.size}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4"
                  >
                    clear
                  </button>
                </div>
              </>
            )}
          </div>
          {result && (
            <p
              role="status"
              className={`text-[11px] font-semibold mt-2 ${result.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}
            >
              {result.text}
            </p>
          )}
        </div>
      </div>

      <ul className="space-y-3 mt-3">
        {rows.map((r) => (
          <OrderRow
            key={r.id}
            {...r}
            selected={selected.has(r.id)}
            onToggleSelect={toggleOne}
            onOpenManualPaid={openManualPaid}
          />
        ))}
      </ul>

      {/* Destructive confirm modal */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal>
          <button type="button" aria-label="Close" onClick={() => setConfirm(null)} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative w-full md:max-w-md bg-card border border-border md:rounded-2xl shadow-xl p-6">
            <h2 className="text-lg font-bold">
              {confirm === 'cancel'
                ? `Cancel ${cancelable.length} pending order${cancelable.length === 1 ? '' : 's'}?`
                : confirm === 'ship'
                ? `Ship ${shippable.length} selected order${shippable.length === 1 ? '' : 's'}`
                : confirm === 'archive'
                ? `Archive ${selected.size} order${selected.size === 1 ? '' : 's'}?`
                : confirm === 'unarchive'
                ? `Restore ${selected.size} order${selected.size === 1 ? '' : 's'} from archive?`
                : `Permanently delete ${selected.size} order${selected.size === 1 ? '' : 's'}?`}
            </h2>
            <p className="text-sm text-muted-foreground mt-2">
              {confirm === 'cancel'
                ? 'The proformas become void, reserved stock is released and each buyer is emailed with the reason. Only unpaid orders without a receipt in review are canceled (nothing was paid, so nothing is refunded).'
                : confirm === 'ship'
                ? 'One shipment per order with everything not shipped yet. Orders without complete delivery and billing details, or on hold, are refused and listed. Each buyer is emailed the carrier and tracking link.'
                : confirm === 'archive'
                ? "Archived orders are hidden from the default queues but kept forever — nothing is deleted. You can restore them from the Archived tab."
                : confirm === 'unarchive'
                ? 'Restored orders return to the default operator queues and will reappear in the relevant status tabs.'
                : 'This is irreversible. The orders and their items are wiped (in-app notifications that mention them are kept); unpaid orders release their reserved stock first. An audit log entry preserves the order number, buyer, total, and item snapshot for forensic recovery, but the order itself cannot be recovered.'}
            </p>
            {confirm === 'ship' && (
              <div className="mt-3 space-y-2 max-h-[50vh] overflow-y-auto" data-testid="bulk-ship-rows">
                {shippable.map((r) => {
                  const row = shipRows[r.id] ?? { carrier: '', tracking: '' };
                  const needs = carriers.find((c) => c.name === row.carrier)?.needsTracking ?? false;
                  return (
                    <div key={r.id} className="rounded-lg border border-border p-2 space-y-1.5">
                      <p className="text-xs font-semibold"><span className="font-mono">{r.orderNumber}</span>{r.hasShippingAddress === false && <span className="ml-2 text-red-700 dark:text-red-300">no complete address — will be refused</span>}</p>
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-2">
                        <select
                          aria-label={`Carrier for ${r.orderNumber}`}
                          value={row.carrier}
                          onChange={(e) => setShipRows((m) => ({ ...m, [r.id]: { ...row, carrier: e.target.value } }))}
                          className="h-9 px-2 rounded-md border border-input bg-background text-xs w-full"
                        >
                          <option value="">Carrier…</option>
                          {carriers.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                        </select>
                        <input
                          aria-label={`Tracking number for ${r.orderNumber}`}
                          value={row.tracking}
                          onChange={(e) => setShipRows((m) => ({ ...m, [r.id]: { ...row, tracking: e.target.value } }))}
                          placeholder={needs ? 'Tracking number (required)' : 'Tracking number'}
                          className="h-9 px-2 rounded-md border border-input bg-background text-xs font-mono w-full"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {confirm === 'cancel' && cancelReasons.length > 0 && (
              <label className="block mt-3">
                <span className="block text-xs font-semibold mb-1">Reason (sent to every buyer)</span>
                <select value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} className="h-9 w-full px-2 rounded-md border border-input bg-background text-sm">
                  <option value="">Choose…</option>
                  {cancelReasons.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
            {confirm === 'delete' && (
              <p className="text-[11px] text-red-700 dark:text-red-300 font-semibold mt-2">
                Buyers will no longer see this order in their history. Make sure that’s intended before proceeding.
              </p>
            )}
            <div className="flex items-center justify-end gap-2 mt-5">
              <button type="button" disabled={pending} onClick={() => setConfirm(null)} className="h-9 px-3 rounded-full text-xs font-semibold hover:bg-foreground/5">
                Cancel
              </button>
              <button
                type="button"
                disabled={pending || (confirm === 'ship' && shippable.some((r) => !shipRows[r.id]?.carrier)) || (confirm === 'cancel' && cancelReasons.length > 0 && !cancelReason)}
                onClick={
                  confirm === 'cancel' ? runCancel
                  : confirm === 'ship' ? runShip
                  : confirm === 'archive' ? runArchive
                  : confirm === 'unarchive' ? runUnarchive
                  : runDelete
                }
                className={`h-9 px-4 rounded-full text-white text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 ${
                  confirm === 'cancel' ? 'bg-amber-700 hover:bg-amber-800' :
                  confirm === 'archive' ? 'bg-slate-700 hover:bg-slate-800' :
                  confirm === 'unarchive' ? 'bg-slate-700 hover:bg-slate-800' :
                  confirm === 'delete' ? 'bg-red-700 hover:bg-red-800' :
                  'bg-primary hover:bg-primary/90'
                }`}
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {confirm === 'delete' ? 'Yes, delete forever' : confirm === 'ship' ? `Ship ${shippable.length} and email the buyer${shippable.length === 1 ? '' : 's'}` : confirm === 'cancel' ? 'Cancel and email the buyers' : 'Yes, do it'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ManualPaidPanel />
    </>
  );
}
