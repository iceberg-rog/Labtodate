'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Copy,
  Check,
  Truck,
  Loader2,
  CircleAlert,
  Package as PackageIcon,
  Phone,
  Building2,
  CreditCard,
  ExternalLink,
  FileText,
  Receipt,
  Archive,
  ArchiveRestore,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
} from 'lucide-react';
import {
  setOrderFulfillment,
  refundOrder,
  cancelOrder,
  verifyPayment,
  rejectPayment,
  archiveOrder,
  unarchiveOrder,
  deleteOrderPermanently,
} from '@/app/admin/actions';
import { BuyerEmailReveal } from './BuyerEmailReveal';
import {
  PRIORITY_CLASS,
  PRIORITY_LABEL,
  trackingUrl,
  type Priority,
} from '@/lib/orders/display';

type Tone = 'amber' | 'sky' | 'emerald' | 'violet' | 'red' | 'slate';

const TONE_BADGE: Record<Tone, string> = {
  amber: 'bg-amber-50 text-amber-800 border-amber-200',
  sky: 'bg-sky-50 text-sky-800 border-sky-200',
  emerald: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  violet: 'bg-violet-50 text-violet-800 border-violet-200',
  red: 'bg-red-50 text-red-800 border-red-200',
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
};

const TONE_STRIPE: Record<Tone, string> = {
  amber: 'before:bg-amber-400',
  red: 'before:bg-red-500',
  sky: 'before:bg-sky-400',
  emerald: 'before:bg-emerald-500',
  violet: 'before:bg-violet-400',
  slate: 'before:bg-slate-300',
};

export type OrderRowProps = {
  id: string;
  orderNumber: string;
  firstItemSlug?: string | null;
  status: 'PENDING_PAYMENT' | 'PAID' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELED' | 'REFUNDED';
  statusTone: Tone;
  statusLabel: string;
  totalLabel: string;
  buyerPrimary: string;
  buyerSecondary?: string;
  buyerCompany?: string | null;
  buyerPhone?: string | null;
  buyerPaidOrderCount?: number;
  buyerLifetimeLabel?: string | null;
  anonymised?: boolean;
  itemsCount: number;
  dateLabel: string; // formatted "Ordered May 18, 2026 at 09:54"
  firstItemTitle: string | null;
  firstItemImage?: string | null;
  firstItemCategory?: string | null;
  itemCountExtra: number;
  supplierName: string | null;
  supplierCompany: string | null;
  distinctSuppliers: number;
  carrier: string | null;
  trackingNumber: string | null;
  hasReceipt?: boolean;
  shipTo?: { name: string | null; line: string | null; country: string | null; phone: string | null } | null;
  buyerCountry?: string | null;
  priority?: Priority;
  // Slice A: buyer-submitted payment proof awaiting admin review.
  paymentVerificationStatus?: 'AWAITING_VERIFICATION' | 'VERIFIED' | 'REJECTED' | null;
  paymentSubmittedAtISO?: string | null;
  // BUG-009 (RB) path C: when the order has no complete shipping address,
  // the inline status select hides SHIPPED + DELIVERED. The server-side
  // guard in setOrderFulfillment still catches any direct POST, but we
  // don't want to present a user-facing option that's known to fail.
  hasShippingAddress?: boolean;
  archived?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string, checked: boolean) => void;
  onOpenManualPaid?: (id: string) => void;
};

function flagFromCountry(code: string | null | undefined): string {
  if (!code || code.length !== 2) return '';
  const cp = code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...cp);
}

function nthOrderLabel(n: number): string {
  if (n === 0) return '1st order';
  const idx = n + 1;
  const s = ['th', 'st', 'nd', 'rd'];
  const v = idx % 100;
  return idx + (s[(v - 20) % 10] || s[v] || s[0]) + ' order';
}

const CARRIERS = ['DHL', 'UPS', 'FedEx', 'PostNL', 'DPD', 'GLS', 'TNT', 'USPS', 'Royal Mail', 'Poste Italiane', 'Other'];

/**
 * 5-column grid order card with a clickable body.
 *
 * COLUMNS: [select] [ORDER] [CUSTOMER] [SUPPLIER] [FULFILMENT] [MONEY+ACTION]
 *
 * Click anywhere in the body opens the quick-view modal — EXCEPT on
 * interactive children (button/input/select/a/label/checkbox/[data-noopen]).
 * That predicate keeps Save&notify, Refund, tracking-link, email reveal,
 * carrier dropdown, etc. from firing the modal by accident.
 */
export function OrderRow(p: OrderRowProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const [confirmDanger, setConfirmDanger] = useState(false);

  const canFulfil = p.status === 'PAID' || p.status === 'PROCESSING' || p.status === 'SHIPPED';
  const isAwaitingVerify = p.paymentVerificationStatus === 'AWAITING_VERIFICATION';
  // When a buyer has submitted proof, the operator's primary action is verify/
  // reject — not the legacy "mark paid manually" (that's the back-channel for
  // off-platform payments the buyer never uploaded).
  const canManualPay = p.status === 'PENDING_PAYMENT' && !isAwaitingVerify;
  const canCancel = p.status === 'PENDING_PAYMENT' && !isAwaitingVerify;
  const canRefund = p.status === 'PAID' || p.status === 'PROCESSING' || p.status === 'SHIPPED' || p.status === 'DELIVERED';
  const trackUrl = trackingUrl(p.carrier, p.trackingNumber);
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);

  async function copyNumber(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(p.orderNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {/* */}
  }

  function runDestructive(action: typeof refundOrder | typeof cancelOrder) {
    start(async () => {
      const fd = new FormData();
      fd.set('orderId', p.id);
      try {
        await action(fd);
        router.refresh();
      } catch (e) {
        alert(e instanceof Error ? e.message : 'Action failed');
      }
      setConfirmDanger(false);
    });
  }

  function openModal() {
    window.dispatchEvent(new CustomEvent('admin:orderquick', { detail: { id: p.id } }));
  }

  // Click predicate: open modal only when clicking inert area of the row.
  function handleBodyClick(e: React.MouseEvent<HTMLLIElement>) {
    const tag = (e.target as HTMLElement).tagName;
    const t = e.target as HTMLElement;
    if (['BUTTON', 'INPUT', 'SELECT', 'A', 'LABEL', 'TEXTAREA', 'OPTION'].includes(tag)) return;
    if (t.closest('[data-noopen]')) return;
    if (t.closest('button, a, input, select, label, textarea')) return;
    openModal();
  }

  return (
    <li
      onClick={handleBodyClick}
      className={`group relative rounded-2xl border border-border bg-card overflow-hidden transition-shadow hover:shadow-[0_8px_24px_-12px_rgba(15,79,64,0.18)] cursor-pointer
        before:content-[''] before:absolute before:inset-y-0 before:left-0 before:w-1 ${TONE_STRIPE[p.statusTone]} ${p.selected ? 'ring-2 ring-primary/40' : ''} ${p.archived ? 'opacity-70 grayscale-[0.2]' : ''}`}
    >
      {p.archived && (
        <div className="absolute top-2 right-3 z-10 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-2 py-0.5" data-noopen>
          <Archive className="h-3 w-3" /> Archived
        </div>
      )}
      {/* === Top row: checkbox + 5-col grid === */}
      <div className="pl-3 pr-4 py-3 flex items-start gap-3">
        {p.onToggleSelect && (
          <label className="flex items-center pt-1 cursor-pointer" data-noopen>
            <input
              type="checkbox"
              checked={!!p.selected}
              onChange={(e) => p.onToggleSelect?.(p.id, e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
          </label>
        )}

        {/* thumbnail = opens modal */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); openModal(); }}
          className="h-14 w-14 rounded-xl border border-border bg-foreground/[0.03] overflow-hidden flex items-center justify-center flex-shrink-0 hover:border-primary/40"
          aria-label="Quick view order"
        >
          {p.firstItemImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.firstItemImage} alt="" className="w-full h-full object-cover" />
          ) : (
            <PackageIcon className="h-5 w-5 text-muted-foreground" />
          )}
        </button>

        <div className="flex-1 min-w-0 grid grid-cols-1 lg:grid-cols-[1.5fr_1.5fr_1fr_1.5fr_1fr] gap-4">

          {/* ─── ORDER ─── */}
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5 text-[11px]">
              <button
                type="button"
                onClick={copyNumber}
                className="font-mono text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                title="Copy order number"
                data-noopen
              >
                {p.orderNumber}
                {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3 opacity-40" />}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">{p.dateLabel}</p>
            <h3 className="font-semibold text-[14px] leading-tight tracking-tight truncate">
              {p.firstItemSlug ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.dispatchEvent(new CustomEvent('admin:productquick', { detail: { slug: p.firstItemSlug } }));
                  }}
                  className="text-left hover:text-primary"
                  data-noopen
                >
                  {p.firstItemTitle}
                </button>
              ) : (
                p.firstItemTitle
              )}
              {p.itemCountExtra > 0 && (
                <span className="text-muted-foreground font-normal text-xs"> + {p.itemCountExtra} more</span>
              )}
            </h3>
            <div className="flex items-center gap-1 flex-wrap">
              {p.firstItemCategory && (
                <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-primary/8 text-primary border border-primary/20">
                  {p.firstItemCategory}
                </span>
              )}
              {p.priority && p.priority !== 'NORMAL' && (
                <span className={`text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full border ${PRIORITY_CLASS[p.priority]}`}>
                  {PRIORITY_LABEL[p.priority]}
                </span>
              )}
            </div>
          </div>

          {/* ─── CUSTOMER ─── */}
          <div className="min-w-0 space-y-1">
            <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Customer</p>
            {p.anonymised ? (
              <p className="text-sm">
                <span className="font-semibold text-slate-700">Deleted customer</span>
                <span className="text-[10px] text-muted-foreground block">original buyer anonymised</span>
              </p>
            ) : (
              <>
                <p className="font-semibold text-sm truncate">
                  {p.buyerCompany ?? (p.buyerPrimary.includes('@') ? (
                    <BuyerEmailReveal email={p.buyerPrimary} />
                  ) : p.buyerPrimary)}
                </p>
                <div className="text-[11px] text-muted-foreground space-y-0.5">
                  {p.buyerCompany && (p.buyerPrimary ?? '') && !p.buyerPrimary.includes('@') && (
                    <p className="truncate">{p.buyerPrimary}</p>
                  )}
                  {p.buyerSecondary ? (
                    <p className="truncate"><BuyerEmailReveal email={p.buyerSecondary} /></p>
                  ) : p.buyerPrimary.includes('@') && p.buyerCompany ? (
                    <p className="truncate"><BuyerEmailReveal email={p.buyerPrimary} /></p>
                  ) : null}
                  {(p.shipTo?.phone || p.buyerPhone) && (
                    <p className="inline-flex items-center gap-1"><Phone className="h-3 w-3" /> {p.shipTo?.phone ?? p.buyerPhone}</p>
                  )}
                  {(p.shipTo?.country || p.buyerCountry) && (
                    <p className="inline-flex items-center gap-1">
                      <span>{flagFromCountry(p.shipTo?.country ?? p.buyerCountry)}</span>
                      {p.shipTo?.country ?? p.buyerCountry}
                    </p>
                  )}
                  {typeof p.buyerPaidOrderCount === 'number' && (
                    <p className={p.buyerPaidOrderCount >= 1 ? 'text-emerald-700 font-semibold' : 'text-sky-700 font-semibold'}>
                      {nthOrderLabel(p.buyerPaidOrderCount)}
                      {p.buyerLifetimeLabel && <span className="ml-1 text-muted-foreground font-normal">· LTV {p.buyerLifetimeLabel}</span>}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          {/* ─── SUPPLIER ─── */}
          <div className="min-w-0 space-y-1">
            <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Supplier</p>
            {p.distinctSuppliers > 1 ? (
              <p className="text-sm">
                <span className="font-semibold inline-flex items-center gap-1"><Building2 className="h-3 w-3" /> {p.distinctSuppliers} suppliers</span>
                <span className="block text-[11px] text-muted-foreground">open detail for breakdown</span>
              </p>
            ) : p.supplierName ? (
              <>
                <p className="font-semibold text-sm truncate inline-flex items-center gap-1"><Building2 className="h-3 w-3" /> {p.supplierName}</p>
                {p.supplierCompany && p.supplierCompany !== p.supplierName && (
                  <p className="text-[11px] text-muted-foreground truncate">{p.supplierCompany}</p>
                )}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground italic">no supplier on file</p>
            )}
          </div>

          {/* ─── FULFILMENT ─── */}
          <div className="min-w-0 space-y-1">
            <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Fulfilment</p>
            {p.shipTo?.line ? (
              <p className="text-[11px] text-foreground/90 truncate">
                {p.shipTo.name && <span className="font-semibold">{p.shipTo.name}</span>}
                {p.shipTo.name && <span className="text-muted-foreground"> · </span>}
                <span className="text-muted-foreground">{p.shipTo.line}</span>
              </p>
            ) : (canFulfil || canCancel) ? (
              <p className="text-[11px] text-red-700 font-semibold inline-flex items-center gap-1">
                <CircleAlert className="h-3 w-3" /> no shipping address
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground/60">—</p>
            )}
            {(p.carrier || p.trackingNumber) && (
              <div className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5 flex-wrap">
                {p.carrier && <span className="font-semibold">{p.carrier}</span>}
                {p.trackingNumber && (
                  <code className="font-mono text-[10px] bg-foreground/5 px-1 py-0.5 rounded">{p.trackingNumber}</code>
                )}
                {trackUrl && (
                  <a
                    href={trackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-0.5 text-primary hover:underline font-semibold"
                    data-noopen
                  >
                    Track <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
            )}
            {p.hasReceipt && (
              <p className="text-[10px] text-emerald-700 font-semibold inline-flex items-center gap-1">
                <Receipt className="h-3 w-3" /> receipt on file
              </p>
            )}
          </div>

          {/* ─── MONEY + ACTION ─── */}
          <div className="min-w-0 space-y-1.5 lg:text-right">
            <p className="text-lg font-bold tabular-nums leading-none">{p.totalLabel}</p>
            <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${TONE_BADGE[p.statusTone]}`}>
              {p.statusLabel}
            </span>
            <div className="text-[10px] text-muted-foreground">
              {`${p.itemsCount} item${p.itemsCount === 1 ? '' : 's'}`}
            </div>
          </div>
        </div>
      </div>

      {/* === Footer action bar === */}
      {canFulfil && (
        <form
          action={setOrderFulfillment}
          className="border-t border-border bg-foreground/[0.02] px-5 py-2.5 flex flex-wrap items-end gap-2"
          data-noopen
          onClick={(e) => e.stopPropagation()}
        >
          <input type="hidden" name="orderId" value={p.id} />
          <label className="block">
            <span className="block text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">Status</span>
            <select name="status" defaultValue={p.status} className="h-8 px-2 rounded-md border border-input bg-background text-xs font-medium">
              {(['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const)
                .filter((s) => p.hasShippingAddress !== false || (s !== 'SHIPPED' && s !== 'DELIVERED'))
                .map((s) => (
                  <option key={s} value={s}>{s.toLowerCase()}</option>
                ))}
            </select>
          </label>
          {p.hasShippingAddress === false && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              <AlertTriangle className="h-3 w-3" /> No address — ship/deliver locked
            </span>
          )}
          <label className="block">
            <span className="block text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">Carrier</span>
            <select name="carrier" defaultValue={p.carrier ?? ''} className="h-8 px-2 rounded-md border border-input bg-background text-xs font-medium w-28">
              <option value="">—</option>
              {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="block flex-1 min-w-[140px]">
            <span className="block text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">Tracking #</span>
            <input name="trackingNumber" defaultValue={p.trackingNumber ?? ''} placeholder="1Z…" className="h-8 px-2 rounded-md border border-input bg-background text-xs font-mono w-full" />
          </label>
          <button type="submit" className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90 shadow-sm">
            <Truck className="h-3.5 w-3.5" /> Save &amp; notify
          </button>
          {canRefund && (
            <DestructiveAction
              pending={pending}
              confirming={confirmDanger}
              onArm={() => setConfirmDanger(true)}
              onCancelArm={() => setConfirmDanger(false)}
              onConfirm={() => runDestructive(refundOrder)}
              label="Refund"
              activeLabel="Refund this order?"
              toneText="text-red-700"
            />
          )}
        </form>
      )}

      {isAwaitingVerify && (
        <div
          className="border-t border-sky-200 bg-sky-50/60 px-5 py-2.5 flex items-center gap-3 text-xs flex-wrap"
          data-noopen
          onClick={(e) => e.stopPropagation()}
        >
          <ShieldAlert className="h-4 w-4 text-sky-700 flex-shrink-0" />
          <span className="flex-1 text-sky-900">
            <strong>Buyer submitted payment proof.</strong>{' '}
            {p.paymentSubmittedAtISO ? `Uploaded ${new Date(p.paymentSubmittedAtISO).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.` : ''} Verify or reject.
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={(e) => {
              e.stopPropagation();
              start(async () => {
                const fd = new FormData(); fd.set('orderId', p.id);
                try { await verifyPayment(fd); router.refresh(); }
                catch (err) { alert(err instanceof Error ? err.message : 'Verify failed'); }
              });
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-emerald-700 text-white text-xs font-bold hover:bg-emerald-800 disabled:opacity-50"
            data-noopen
          >
            <ShieldCheck className="h-3.5 w-3.5" /> Verify payment
          </button>
          {!showReject ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowReject(true); }}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-amber-300 bg-white text-amber-800 text-xs font-bold hover:bg-amber-50"
              data-noopen
            >
              Reject
            </button>
          ) : (
            <div className="flex items-center gap-2 w-full mt-2" data-noopen onClick={(e) => e.stopPropagation()}>
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Reason buyer will see (e.g. amount short, wrong reference)"
                maxLength={500}
                className="flex-1 h-8 px-2 rounded-md border border-amber-300 bg-white text-xs"
              />
              <button
                type="button"
                disabled={pending || rejectReason.trim().length < 4}
                onClick={() => {
                  start(async () => {
                    const fd = new FormData(); fd.set('orderId', p.id); fd.set('reason', rejectReason.trim());
                    try { await rejectPayment(fd); setShowReject(false); setRejectReason(''); router.refresh(); }
                    catch (err) { alert(err instanceof Error ? err.message : 'Reject failed'); }
                  });
                }}
                className="h-8 px-3 rounded-md bg-amber-700 text-white text-xs font-bold disabled:opacity-50"
              >
                Send rejection
              </button>
              <button
                type="button"
                onClick={() => { setShowReject(false); setRejectReason(''); }}
                className="text-xs text-muted-foreground underline"
              >
                cancel
              </button>
            </div>
          )}
        </div>
      )}

      {canManualPay && (
        <div
          className="border-t border-amber-200 bg-amber-50/40 px-5 py-2.5 flex items-center gap-3 text-xs flex-wrap"
          data-noopen
          onClick={(e) => e.stopPropagation()}
        >
          <CircleAlert className="h-4 w-4 text-amber-600 flex-shrink-0" />
          <span className="flex-1 text-amber-900">
            <strong>Awaiting payment.</strong> If buyer has paid off-platform (bank transfer / invoice), mark it paid manually.
          </span>
          {p.onOpenManualPaid && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); p.onOpenManualPaid?.(p.id); }}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-amber-700 text-white text-xs font-bold hover:bg-amber-800"
              data-noopen
            >
              <CreditCard className="h-3.5 w-3.5" /> Mark as paid
            </button>
          )}
          <DestructiveAction
            pending={pending}
            confirming={confirmDanger}
            onArm={() => setConfirmDanger(true)}
            onCancelArm={() => setConfirmDanger(false)}
            onConfirm={() => runDestructive(cancelOrder)}
            label="Cancel order"
            activeLabel="Cancel & release stock?"
            toneText="text-amber-800"
          />
        </div>
      )}

      {/* === Archived footer: Restore + Delete-forever (single-row UX
       *      parallel to the bulk bar in the Archived tab). === */}
      {p.archived && (
        <div
          className="border-t border-slate-200 bg-slate-50/60 px-5 py-2.5 flex items-center gap-3 text-xs flex-wrap"
          data-noopen
          onClick={(e) => e.stopPropagation()}
        >
          <Archive className="h-4 w-4 text-slate-600 flex-shrink-0" />
          <span className="flex-1 text-slate-700">
            <strong>Archived.</strong> Hidden from the default queues. Restore to put it back, or delete permanently.
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={(e) => {
              e.stopPropagation();
              start(async () => {
                const fd = new FormData(); fd.set('orderId', p.id);
                try { await unarchiveOrder(fd); router.refresh(); }
                catch (err) { alert(err instanceof Error ? err.message : 'Restore failed'); }
              });
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold disabled:opacity-50"
            data-noopen
          >
            <ArchiveRestore className="h-3.5 w-3.5" /> Restore
          </button>
          <DestructiveAction
            pending={pending}
            confirming={confirmDanger}
            onArm={() => setConfirmDanger(true)}
            onCancelArm={() => setConfirmDanger(false)}
            onConfirm={() => {
              start(async () => {
                const fd = new FormData(); fd.set('orderId', p.id);
                try { await deleteOrderPermanently(fd); router.refresh(); }
                catch (err) { alert(err instanceof Error ? err.message : 'Delete failed'); }
                setConfirmDanger(false);
              });
            }}
            label="Delete forever"
            activeLabel="Delete forever — confirm?"
            toneText="text-red-800"
          />
        </div>
      )}
    </li>
  );
}

function DestructiveAction({
  pending,
  confirming,
  onArm,
  onCancelArm,
  onConfirm,
  label,
  activeLabel,
  toneText,
}: {
  pending: boolean;
  confirming: boolean;
  onArm: () => void;
  onCancelArm: () => void;
  onConfirm: () => void;
  label: string;
  activeLabel: string;
  toneText: string;
}) {
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onArm(); }}
        className={`text-[11px] underline underline-offset-4 decoration-dotted text-muted-foreground hover:${toneText}`}
        data-noopen
      >
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-[11px] flex-wrap" data-noopen onClick={(e) => e.stopPropagation()}>
      <span className="text-muted-foreground">{activeLabel}</span>
      <button
        type="button"
        disabled={pending}
        onClick={onConfirm}
        className={`font-semibold underline underline-offset-4 disabled:opacity-50 ${toneText}`}
      >
        {pending && <Loader2 className="h-3 w-3 inline animate-spin mr-0.5" />}yes
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={onCancelArm}
        className="text-muted-foreground hover:text-foreground"
      >
        no
      </button>
    </span>
  );
}

export { FileText }; // re-export so consumers don't need to import lucide directly
