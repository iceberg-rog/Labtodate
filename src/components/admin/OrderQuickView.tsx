'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  X,
  Loader2,
  Package,
  MapPin,
  CreditCard,
  Clock,
  Truck,
  ExternalLink,
  ReceiptText,
  Building2,
  Globe2,
  Image as ImageIcon,
  Receipt,
  FileText,
  Phone,
  Mail,
  UserCircle,
  TrendingUp,
  Repeat,
  ShieldCheck,
  ShieldAlert,
  Archive,
  ArchiveRestore,
  Trash2,
} from 'lucide-react';
import {
  getOrderQuickDetail,
  archiveOrder,
  unarchiveOrder,
  verifyPayment,
  deleteOrderPermanently,
} from '@/app/admin/actions';
import { humaniseBuyer, smartDate, STATUS_LABEL, STATUS_TONE, trackingUrl } from '@/lib/orders/display';
import { openManualPaid } from './ManualPaidPanel';
import { BuyerEmailReveal } from './BuyerEmailReveal';

type Detail = NonNullable<Awaited<ReturnType<typeof getOrderQuickDetail>>>;

const TONE_CLASS: Record<string, string> = {
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  sky: 'bg-sky-100 text-sky-800 border-sky-200',
  emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  violet: 'bg-violet-100 text-violet-800 border-violet-200',
  red: 'bg-red-100 text-red-800 border-red-200',
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
};

function fmt(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function flagFromCountry(code: string | null | undefined): string {
  if (!code || code.length !== 2) return '';
  const cp = code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...cp);
}

function fmtAddrLines(a: unknown): { name?: string; lines: string[] } | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const ad = (o.address as Record<string, unknown>) || o;
  const lines = [
    typeof ad.line1 === 'string' ? ad.line1 : null,
    typeof ad.line2 === 'string' ? ad.line2 : null,
    [
      typeof ad.postal_code === 'string' ? ad.postal_code : null,
      typeof ad.city === 'string' ? ad.city : null,
      typeof ad.state === 'string' ? ad.state : null,
    ].filter(Boolean).join(' '),
    typeof ad.country === 'string' ? ad.country : null,
    typeof o.phone === 'string' ? `☎ ${o.phone}` : null,
  ].filter((x): x is string => !!x && x.trim().length > 0);
  return { name: typeof o.name === 'string' ? o.name : undefined, lines };
}

function paymentLabel(
  brand: string | null,
  last4: string | null,
  wallet: string | null,
  manual?: string | null,
): string {
  if (brand || last4 || wallet) {
    const pretty = brand ? brand.toUpperCase().replace(/_/g, ' ') : 'CARD';
    const tail = last4 ? `•••• ${last4}` : '';
    const w = wallet ? ` · ${wallet.replace(/_/g, ' ')}` : '';
    return `${pretty} ${tail}${w}`.trim();
  }
  if (manual) return manual.toUpperCase().replace(/_/g, ' ');
  return '—';
}

export function OrderQuickView() {
  const router = useRouter();
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<Detail | null>(null);
  const [pending, start] = useTransition();
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Re-fetch the order so banners + buttons reflect the new state without
  // closing the modal. Cheap and predictable — no SWR/cache invalidation.
  function refetch(orderId: string) {
    start(async () => {
      try {
        const r = await getOrderQuickDetail(orderId);
        if (r) setData(r);
      } catch {/* keep stale */}
      router.refresh();
    });
  }
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ id: string }>).detail;
      if (!detail?.id) return;
      setId(detail.id);
      setData(null);
      setErr(null);
      start(async () => {
        try {
          const r = await getOrderQuickDetail(detail.id);
          if (!r) setErr('Order not found.');
          else setData(r);
        } catch (e) {
          setErr(e instanceof Error ? e.message : 'Failed to load.');
        }
      });
    }
    window.addEventListener('admin:orderquick', handler);
    return () => window.removeEventListener('admin:orderquick', handler);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setId(null);
    }
    if (id) {
      window.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [id]);

  if (!id) return null;

  const buyer = data ? humaniseBuyer(data.buyer) : null;
  const tone = data ? STATUS_TONE[data.status] ?? 'slate' : 'slate';
  const ship = data ? fmtAddrLines(data.shippingAddress) : null;
  const bill = data ? fmtAddrLines(data.billingAddress) : null;
  const sameAddr = ship && bill && JSON.stringify(ship) === JSON.stringify(bill);

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" role="dialog" aria-modal>
      <button
        type="button"
        aria-label="Close"
        onClick={() => setId(null)}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="relative w-full md:max-w-4xl bg-card border border-border md:rounded-2xl shadow-xl max-h-[92vh] overflow-auto">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 p-5 border-b border-border bg-card">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Order</p>
            {data ? (
              <>
                <h2 className="text-lg font-bold font-mono">{data.orderNumber}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {smartDate(new Date(data.createdAtISO))} · {buyer?.primary}
                  {buyer?.anonymised && (
                    <span className="ml-2 text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                      anonymised
                    </span>
                  )}
                </p>
              </>
            ) : (
              <h2 className="text-lg font-bold">Loading…</h2>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {data && (
              <>
                <p className="text-xl font-bold tabular-nums">{fmt(data.totalCents, data.currency)}</p>
                <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border ${TONE_CLASS[tone]}`}>
                  {STATUS_LABEL[data.status] ?? data.status.toLowerCase()}
                </span>
              </>
            )}
            <button
              type="button"
              onClick={() => setId(null)}
              className="p-1.5 rounded-lg hover:bg-foreground/5 text-muted-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-5">
          {pending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Fetching order…
            </div>
          )}
          {err && <p className="text-sm text-red-600">{err}</p>}

          {data && (
            <div className="space-y-5">
              {/* === Verification + archive banner === */}
              {data.archivedAt && (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 flex items-center gap-3 text-xs flex-wrap">
                  <Archive className="h-4 w-4 text-slate-600 flex-shrink-0" />
                  <span className="flex-1 text-slate-700">
                    <strong>Archived</strong> {smartDate(new Date(data.archivedAt))} by {data.archivedByEmail ?? 'unknown'}. Hidden from the default queue.
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setActionMsg(null);
                      start(async () => {
                        const fd = new FormData(); fd.set('orderId', data.id);
                        try { const r = await unarchiveOrder(fd); setActionMsg(r?.message ?? 'Restored.'); if (r?.ok) refetch(data.id); }
                        catch (e) { setActionMsg(e instanceof Error ? e.message : 'Failed'); }
                      });
                    }}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold disabled:opacity-50"
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" /> Restore
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      if (!window.confirm(`Delete order ${data.orderNumber} forever? This is irreversible. An audit row preserves the buyer + total for forensic recovery, but the order itself cannot be brought back.`)) return;
                      setActionMsg(null);
                      start(async () => {
                        const fd = new FormData(); fd.set('orderId', data.id);
                        try {
                          const r = await deleteOrderPermanently(fd);
                          setActionMsg(r?.message ?? 'Deleted.');
                          if (r?.ok) { setId(null); router.refresh(); }
                        } catch (e) { setActionMsg(e instanceof Error ? e.message : 'Failed'); }
                      });
                    }}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-red-700 hover:bg-red-800 text-white text-xs font-bold disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete forever
                  </button>
                </div>
              )}
              {data.paymentVerificationStatus === 'AWAITING_VERIFICATION' && (
                <div className="rounded-2xl border border-sky-200 bg-sky-50 p-3 flex items-center gap-3 text-xs">
                  <ShieldAlert className="h-4 w-4 text-sky-700 flex-shrink-0" />
                  <span className="flex-1 text-sky-900">
                    <strong>Payment proof submitted</strong>
                    {data.paymentSubmittedAt && ` ${smartDate(new Date(data.paymentSubmittedAt))}`}. Review the receipt and verify (or use the row-level reject control to ask the buyer for a corrected one).
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setActionMsg(null);
                      start(async () => {
                        const fd = new FormData(); fd.set('orderId', data.id);
                        try { const r = await verifyPayment(fd); setActionMsg(r.message); if (r.ok) refetch(data.id); }
                        catch (e) { setActionMsg(e instanceof Error ? e.message : 'Verify failed'); }
                      });
                    }}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold disabled:opacity-50"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Verify payment
                  </button>
                </div>
              )}
              {data.paymentVerificationStatus === 'VERIFIED' && data.paymentVerifiedByEmail && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 flex items-center gap-2 text-xs text-emerald-900">
                  <ShieldCheck className="h-4 w-4" />
                  <span><strong>Payment verified</strong> {data.paymentVerifiedAt ? smartDate(new Date(data.paymentVerifiedAt)) : ''} by {data.paymentVerifiedByEmail}.</span>
                </div>
              )}
              {data.paymentVerificationStatus === 'REJECTED' && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <strong>Last receipt rejected.</strong> {data.paymentRejectionReason ? `Reason: "${data.paymentRejectionReason}"` : ''} Buyer can resubmit from their workspace.
                </div>
              )}
              {actionMsg && (
                <p className="text-[11px] text-emerald-700 font-semibold">{actionMsg}</p>
              )}

              {/* === Customer panel — full B2B contact + buyer intel === */}
              <section className="rounded-xl border border-border overflow-hidden">
                <div className="px-4 py-2 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
                  <UserCircle className="h-3.5 w-3.5 text-primary" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Customer</h3>
                </div>
                <div className="p-3 grid sm:grid-cols-[1.4fr_1fr] gap-4">
                  <div className="space-y-1.5">
                    <p className="font-bold text-sm">{data.buyer.name || '—'}</p>
                    {data.buyer.company && (
                      <p className="text-xs inline-flex items-center gap-1.5 text-muted-foreground">
                        <Building2 className="h-3 w-3" /> {data.buyer.company}
                      </p>
                    )}
                    <p className="text-xs inline-flex items-center gap-1.5">
                      <Mail className="h-3 w-3 text-muted-foreground" />
                      <BuyerEmailReveal email={data.buyer.email} />
                    </p>
                    {data.buyer.phone && (
                      <p className="text-xs inline-flex items-center gap-1.5">
                        <Phone className="h-3 w-3 text-muted-foreground" />
                        <a href={`tel:${data.buyer.phone}`} className="hover:text-primary tabular-nums">{data.buyer.phone}</a>
                      </p>
                    )}
                    {data.buyer.vat && (
                      <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                        <FileText className="h-3 w-3" /> VAT / reg.: <span className="font-mono text-foreground">{data.buyer.vat}</span>
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5 sm:border-l sm:border-border sm:pl-4">
                    <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Buyer history</p>
                    <p className="text-sm inline-flex items-center gap-1.5">
                      <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
                      <strong className="tabular-nums">{data.buyer.repeatOrderCount}</strong> paid order{data.buyer.repeatOrderCount === 1 ? '' : 's'} to date
                    </p>
                    {data.buyer.lifetimeCents > 0 && (
                      <p className="text-sm inline-flex items-center gap-1.5">
                        <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                        Lifetime value <strong className="ml-1 tabular-nums">{fmt(data.buyer.lifetimeCents, data.currency)}</strong>
                      </p>
                    )}
                  </div>
                </div>
              </section>

              {/* === Supplier panel — always visible (was implicit before) === */}
              {data.supplierNames.length > 0 && (
                <section className="rounded-xl border border-border overflow-hidden">
                  <div className="px-4 py-2 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
                    <Building2 className="h-3.5 w-3.5 text-primary" />
                    <h3 className="text-xs font-bold uppercase tracking-wider">Supplier{data.supplierNames.length === 1 ? '' : 's'}</h3>
                  </div>
                  <div className="p-3 flex items-center gap-2 flex-wrap">
                    {data.supplierNames.map((s) => (
                      <span key={s} className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full bg-primary/[0.07] text-primary border border-primary/15">
                        {s}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {/* Items */}
              <section className="rounded-xl border border-border overflow-hidden">
                <div className="px-4 py-2 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
                  <Package className="h-3.5 w-3.5 text-primary" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Items ({data.items.length})</h3>
                </div>
                <ul className="divide-y divide-border">
                  {data.items.map((it) => (
                    <li key={it.id} className="p-3 flex items-center gap-3">
                      <div className="h-12 w-12 rounded-lg bg-foreground/5 border border-border overflow-hidden flex-shrink-0 flex items-center justify-center">
                        {it.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={it.image} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <ImageIcon className="h-5 w-5 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        {it.productSlug ? (
                          <Link
                            href={`/marketplace/${it.productSlug}`}
                            target="_blank"
                            className="font-semibold text-sm hover:text-primary truncate block"
                          >
                            {it.titleSnapshot}
                          </Link>
                        ) : (
                          <p className="font-semibold text-sm truncate text-muted-foreground italic">{it.titleSnapshot}</p>
                        )}
                        <p className="text-[11px] text-muted-foreground mt-0.5 inline-flex items-center gap-2 flex-wrap">
                          {it.brandSnapshot && <span>{it.brandSnapshot}</span>}
                          {it.supplierName && (
                            <span className="inline-flex items-center gap-1">
                              <Building2 className="h-3 w-3" /> {it.supplierName}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="text-right text-sm">
                        <p className="font-bold tabular-nums">
                          {fmt(it.priceCentsSnapshot, data.currency)} × {it.quantity}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Addresses */}
              <section className="grid sm:grid-cols-2 gap-3">
                <Card icon={<MapPin className="h-3.5 w-3.5 text-primary" />} title="Ship to">
                  {ship ? (
                    <address className="not-italic text-sm space-y-0.5">
                      {ship.name && <p className="font-semibold">{ship.name}</p>}
                      {ship.lines.map((l, i) => <p key={i} className="text-muted-foreground text-xs">{l}</p>)}
                    </address>
                  ) : (
                    <p className="text-xs text-red-700 font-semibold">⚠ No shipping address — close this and ask the buyer.</p>
                  )}
                </Card>
                <Card icon={<MapPin className="h-3.5 w-3.5 text-primary" />} title="Billing">
                  {sameAddr ? (
                    <p className="text-xs text-muted-foreground italic">Same as shipping</p>
                  ) : bill ? (
                    <address className="not-italic text-sm space-y-0.5">
                      {bill.name && <p className="font-semibold">{bill.name}</p>}
                      {bill.lines.map((l, i) => <p key={i} className="text-muted-foreground text-xs">{l}</p>)}
                    </address>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">Not captured.</p>
                  )}
                </Card>
              </section>

              {/* Payment + Provenance + Carrier */}
              <section className="grid sm:grid-cols-3 gap-3">
                <Card icon={<CreditCard className="h-3.5 w-3.5 text-primary" />} title="Payment">
                  <p className="text-sm font-semibold">
                    {paymentLabel(data.paymentMethodBrand, data.paymentMethodLast4, data.paymentMethodWallet, data.paymentMethodManual)}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{data.currency}</p>
                </Card>
                <Card icon={<Globe2 className="h-3.5 w-3.5 text-primary" />} title="Buyer location">
                  <p className="text-sm font-semibold inline-flex items-center gap-1.5">
                    <span className="text-base">{flagFromCountry(data.buyerCountry)}</span>
                    {data.buyerCountry ?? 'Unknown'}
                  </p>
                  {data.buyerIp && <p className="text-[10px] font-mono text-muted-foreground">{data.buyerIp}</p>}
                </Card>
                <Card icon={<Truck className="h-3.5 w-3.5 text-primary" />} title="Carrier">
                  <p className="text-sm font-semibold">{data.trackingCarrier ?? '—'}</p>
                  {data.trackingNumber && (
                    <>
                      <code className="text-[10px] font-mono bg-foreground/5 px-1.5 py-0.5 rounded block mt-0.5">
                        {data.trackingNumber}
                      </code>
                      {trackingUrl(data.trackingCarrier, data.trackingNumber) && (
                        <a
                          href={trackingUrl(data.trackingCarrier, data.trackingNumber)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-primary hover:underline"
                        >
                          Track shipment <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </>
                  )}
                </Card>
              </section>

              {/* Timeline */}
              <section className="rounded-xl border border-border overflow-hidden">
                <div className="px-4 py-2 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-primary" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Timeline</h3>
                </div>
                <ol className="p-4 space-y-2 text-sm">
                  <TimelineRow label="Created" iso={data.createdAtISO} />
                  {data.paidAtISO && <TimelineRow label="Payment received" iso={data.paidAtISO} />}
                  {data.shippedAtISO && <TimelineRow label="Shipped" iso={data.shippedAtISO} />}
                  {data.deliveredAtISO && <TimelineRow label="Delivered" iso={data.deliveredAtISO} />}
                </ol>
              </section>

              {data.adminNotes && (
                <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-amber-800 mb-1">
                    Internal note
                  </p>
                  <p className="whitespace-pre-wrap text-amber-900">{data.adminNotes}</p>
                </section>
              )}

              {/* Manual paid + receipt — only when relevant */}
              {data.status === 'PENDING_PAYMENT' && (
                <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-3 flex items-center gap-3 flex-wrap">
                  <CreditCard className="h-4 w-4 text-amber-700" />
                  <span className="text-xs flex-1 text-amber-900">
                    Buyer paid off-platform? Mark this as paid and attach the receipt.
                  </span>
                  <button
                    type="button"
                    onClick={() => openManualPaid(data.id)}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-amber-700 text-white text-xs font-bold hover:bg-amber-800"
                  >
                    Mark as paid
                  </button>
                </section>
              )}
              {data.paymentProofUrl && (
                <section className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 flex items-center gap-3 flex-wrap">
                  <Receipt className="h-4 w-4 text-emerald-700" />
                  <span className="text-xs flex-1 text-emerald-900">
                    <strong>Receipt on file</strong>
                    {data.paymentMethodManual && ` · ${data.paymentMethodManual.toLowerCase().replace('_', ' ')}`}
                    {data.paidByAdminEmail && ` · marked by ${data.paidByAdminEmail}`}
                    {data.paymentNote && (
                      <span className="block text-[11px] text-emerald-800 mt-0.5">Note: {data.paymentNote}</span>
                    )}
                  </span>
                  <a
                    href={data.paymentProofUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 h-8 px-3 rounded-md border border-emerald-300 bg-white text-emerald-700 text-xs font-bold hover:bg-emerald-100"
                  >
                    <FileText className="h-3.5 w-3.5" /> View receipt
                  </a>
                </section>
              )}

              {/* Actions */}
              <div className="flex items-center justify-between gap-2 flex-wrap pt-2 border-t border-border">
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <Link
                    href={`/admin/orders/${data.id}`}
                    className="inline-flex items-center gap-1 h-9 px-3 rounded-full bg-primary text-primary-foreground font-semibold"
                  >
                    Open full page →
                  </Link>
                  <Link
                    href={`/admin/orders/${data.id}/invoice`}
                    target="_blank"
                    className="inline-flex items-center gap-1 h-9 px-3 rounded-full border border-border bg-card font-semibold hover:bg-foreground/5"
                  >
                    <ReceiptText className="h-3.5 w-3.5" /> Invoice
                  </Link>
                  {!buyer?.anonymised && (
                    <Link
                      href={`/admin/users/${data.buyer.id}`}
                      className="inline-flex items-center gap-1 h-9 px-3 rounded-full border border-border bg-card font-semibold hover:bg-foreground/5"
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> Buyer profile
                    </Link>
                  )}
                </div>
                {!data.archivedAt && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setActionMsg(null);
                      start(async () => {
                        const fd = new FormData(); fd.set('orderId', data.id);
                        try { const r = await archiveOrder(fd); setActionMsg(r.message); if (r.ok) refetch(data.id); }
                        catch (e) { setActionMsg(e instanceof Error ? e.message : 'Failed'); }
                      });
                    }}
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-slate-300 bg-white text-slate-700 text-xs font-bold hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Archive className="h-3.5 w-3.5" /> Archive
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5 inline-flex items-center gap-1">
        {icon} {title}
      </p>
      {children}
    </div>
  );
}

function TimelineRow({ label, iso }: { label: string; iso: string }) {
  return (
    <li className="flex items-center justify-between">
      <span className="font-semibold">{label}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{smartDate(new Date(iso))}</span>
    </li>
  );
}

export function OrderQuickTrigger({
  id,
  children,
  className,
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('admin:orderquick', { detail: { id } }));
      }}
      className={className}
    >
      {children}
    </button>
  );
}
