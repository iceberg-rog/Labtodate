import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft,
  CircleDollarSign,
  Package,
  MapPin,
  CreditCard,
  Clock,
  Truck,
  StickyNote,
  ExternalLink,
  Building2,
  Globe2,
  Bell,
  FileText,
  ReceiptText,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { emailTransportStatus } from '@/lib/email';
import { hasCapability, requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { formatPrice } from '@/lib/utils';
import {
  setOrderNotes,
  setOrderShippingAddress,
  verifyPayment,
  rejectPayment,

} from '@/app/admin/actions';
import { BuyerEmailReveal } from '@/components/admin/BuyerEmailReveal';
import { documentHref } from '@/lib/documents';
import { getOrderDocuments, prePaymentHoldMessage } from '@/lib/documents/issue';
import { ensureSettingsLoaded, settingBool, settingInt } from '@/lib/settings';
import { OrderDocumentsPanel } from '@/components/documents/OrderDocumentsPanel';
import { OrderPricingPanel } from '@/components/admin/OrderPricingPanel';
import { OrderFinancePanel } from '@/components/admin/OrderFinancePanel';
import { hasPrePaymentHold } from '@/lib/checkout/holds';
import { countryOptions } from '@/lib/compliance/country';
import { vatTreatmentLabel } from '@/lib/tax/determine';
import { OrderActionForm } from '@/components/admin/OrderActionForm';
import { StickyDetails } from '@/components/admin/StickyDetails';
import { OrderPaymentPanels } from '@/components/admin/OrderPaymentPanels';
import { detailsSummary, orderDetailsProblems } from '@/lib/orders/details';
import { heldMoneyCents, LIVE_REFUNDS_SELECT } from '@/lib/finance/held';
import { bookingHoldBlocker, briefText, fmtValueDay, proofKeyOf, receiptHistory, type ReceiptStatus } from '@/lib/payments/rules';
import { orderFulfilmentView } from '@/lib/fulfilment/view';
import { NextSteps } from '@/components/orders/NextSteps';
import { AdminShipments } from '@/components/admin/fulfilment/AdminShipments';
import { AdminCancelCard, AdminMoney } from '@/components/admin/fulfilment/AdminMoney';
import { AdminReturns } from '@/components/admin/fulfilment/AdminReturns';
import { requireDetailsBeforePayment, vatIdRule } from '@/lib/quotes/policy';
import {
  humaniseBuyer,
  proxyProofUrl,
  shippingAddressIsComplete,
  smartDate,
  STATUS_LABEL,
  STATUS_TONE,
} from '@/lib/orders/display';
import { QUOTE_REF } from '@/lib/quotes/offer';

export const dynamic = 'force-dynamic';

export function generateMetadata(props: { params: Promise<{ id: string }> }) {
  return adminDetailTitle('orders:view', 'Order', async () => {
    const { id } = await props.params;
    const o = await prisma.order.findUnique({ where: { id }, select: { orderNumber: true } });
    return o && `Order ${o.orderNumber}`;
  });
}

const TONE_CLASS: Record<string, string> = {
  amber: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800',
  sky: 'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800',
  emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800',
  violet: 'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800',
  red: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800',
  slate: 'bg-muted text-muted-foreground border-border',
};

function fmtAddr(a: unknown): { name?: string; lines: string[] } | null {
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
    typeof o.email === 'string' ? `✉ ${o.email}` : null,
  ].filter((x): x is string => !!x && x.trim().length > 0);
  return { name: typeof o.name === 'string' ? o.name : undefined, lines };
}

function maskId(id: string | null | undefined): string {
  if (!id) return '—';
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function flagFromCountry(code: string | null | undefined): string {
  if (!code || code.length !== 2) return '🌐';
  const cp = code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...cp);
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

/** Prefill values for the admin shipping-address editor. */
function addrFormSeed(a: unknown): Record<'name' | 'phone' | 'line1' | 'line2' | 'city' | 'postal' | 'state' | 'country', string> {
  const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
  const ad = ((o.address as Record<string, unknown>) || o) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    name: str(o.name),
    phone: str(o.phone),
    line1: str(ad.line1),
    line2: str(ad.line2),
    city: str(ad.city),
    postal: str(ad.postal_code) || str(ad.postal),
    state: str(ad.state),
    country: str(ad.country),
  };
}

export default async function AdminOrderDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  await requireCapability('orders:view');
  await ensureSettingsLoaded();

  const order = await prisma.order.findUnique({
    where: { id: params.id },
    include: {
      buyer: { select: { id: true, name: true, email: true } },
      items: {
        include: {
          product: {
            select: {
              slug: true,
              status: true,
              seller: { select: { id: true, name: true, email: true } },
              company: { select: { slug: true, name: true, country: true } },
            },
          },
        },
      },
      refunds: LIVE_REFUNDS_SELECT,
      // The money ledger and every receipt event: the timeline and the receipts list.
      payments: { select: { id: true, amountCents: true, receivedAt: true, method: true, source: true, proofKey: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
      paymentProofs: { select: { id: true, key: true, kind: true, fileName: true, amountCents: true, rejectedReason: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!order) notFound();

  const buyer = humaniseBuyer(order.buyer);
  const tone = STATUS_TONE[order.status] ?? 'slate';
  const shipAddr = fmtAddr(order.shippingAddress);
  const billAddr = fmtAddr(order.billingAddress);
  const sameAddr = shipAddr && billAddr && JSON.stringify(shipAddr) === JSON.stringify(billAddr);

  // Other orders by the same buyer (most-recent first, max 6, excluding this one).
  const otherOrders = order.buyer.id
    ? await prisma.order.findMany({
        where: { buyerId: order.buyer.id, NOT: { id: order.id } },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: {
          id: true,
          orderNumber: true,
          totalCents: true,
          currency: true,
          status: true,
          createdAt: true,
        },
      })
    : [];

  // Buyer-side notifications for this order (so we know an email/inapp fired).
  const buyerNotifs = order.buyer.id
    ? await prisma.notification.findMany({
        where: {
          userId: order.buyer.id,
          OR: [
            { title: { contains: order.orderNumber } },
            { href: { contains: order.orderNumber } },
            { body: { contains: order.orderNumber } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true, title: true, kind: true, createdAt: true, readAt: true },
      })
    : [];

  // Activity feed: every audit log + admin notification that references this
  // order, merged + sorted oldest→newest. Operator gets a chronological story
  // of who did what.
  const [auditEvents, adminEvents] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        OR: [
          { target: order.id },
          { target: order.orderNumber },
          { meta: { contains: order.orderNumber } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true, action: true, actorEmail: true, meta: true, createdAt: true },
    }),
    prisma.notification.findMany({
      where: {
        OR: [
          { href: { contains: `/admin/orders/${order.id}` } },
          { title: { contains: order.orderNumber } },
        ],
        user: { role: 'ADMIN' },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true, title: true, body: true, kind: true, createdAt: true },
      distinct: ['title', 'createdAt'],
    }),
  ]);

  type FeedEntry = { id: string; at: Date; label: string; sub?: string; actor?: string | null; kind: 'audit' | 'notif' };
  const money = (c: number) => formatPrice(c, order.currency);
  const feed: FeedEntry[] = [
    ...auditEvents.map((a) => ({
      id: 'a:' + a.id,
      at: a.createdAt,
      label: a.action.replace(/\./g, ' '),
      sub: a.meta ?? undefined,
      actor: a.actorEmail,
      kind: 'audit' as const,
    })),
    ...adminEvents.map((n) => ({
      id: 'n:' + n.id,
      at: n.createdAt,
      label: n.title,
      sub: n.body,
      kind: 'notif' as const,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  // Build a timeline of state-change facts we actually have. A value date (bank
  // statement) is a day, shown without a time and sorted by when it was booked.
  const events: { label: string; at: Date; icon: React.ReactNode; dateOnly?: boolean; sortAt?: Date }[] = [];
  events.push({ label: order.sourcingRequestId ? 'Created (offer accepted by the buyer)' : 'Created (checkout)', at: order.createdAt, icon: <Clock className="h-3.5 w-3.5" /> });
  let ledgerSum = 0;
  order.payments.forEach((p, i) => {
    ledgerSum += p.amountCents;
    const last = i === order.payments.length - 1;
    const part = !(last && ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'].includes(order.status)) && ledgerSum < order.totalCents;
    const card = p.source === 'STRIPE';
    events.push({
      label: `${part ? 'Part payment' : 'Payment'} ${money(p.amountCents)} received${card ? ' (card)' : ` — value date ${fmtValueDay(p.receivedAt)} (${p.method.toLowerCase().replace(/_/g, ' ')})`}${part ? ` · ${money(Math.max(0, order.totalCents - ledgerSum))} still due` : ''}`,
      at: p.receivedAt,
      sortAt: card ? p.receivedAt : p.createdAt,
      dateOnly: !card,
      icon: <CreditCard className="h-3.5 w-3.5" />,
    });
  });
  if (!order.payments.length && order.paidAt) {
    const card = !!order.stripePaymentIntentId;
    events.push({ label: card ? 'Payment received' : 'Payment received (value date)', at: order.paidAt, dateOnly: !card, icon: <CreditCard className="h-3.5 w-3.5" /> });
  }
  for (const pr of order.paymentProofs) {
    const file = pr.fileName ? ` (${pr.fileName})` : '';
    if (pr.kind === 'SUBMITTED') events.push({ label: `Payment receipt uploaded by the buyer${file}`, at: pr.createdAt, icon: <FileText className="h-3.5 w-3.5" /> });
    else if (pr.kind === 'REJECTED') events.push({ label: `Receipt rejected${file}${pr.rejectedReason ? ` — ${briefText(pr.rejectedReason, 160)}` : ''}`, at: pr.createdAt, icon: <FileText className="h-3.5 w-3.5" /> });
    else if (pr.kind === 'MANUAL') events.push({ label: `Proof attached by staff${file}`, at: pr.createdAt, icon: <FileText className="h-3.5 w-3.5" /> });
  }
  const fv = await orderFulfilmentView(order.id);
  if (!fv) notFound();
  for (const s of fv.shipments) {
    if (s.shippedAt) events.push({ label: `Shipment ${s.seq} sent — ${s.carrier ?? 'carrier not set'}${s.trackingNumber ? ` ${s.trackingNumber}` : ''}`, at: s.shippedAt, icon: <Truck className="h-3.5 w-3.5" /> });
    if (s.deliveredAt) events.push({ label: `Shipment ${s.seq} delivered${s.deliveredBy === 'BUYER' ? ' (confirmed by the buyer)' : ''}`, at: s.deliveredAt, icon: <Package className="h-3.5 w-3.5" /> });
  }
  if (!fv.shipments.length && order.shippedAt) events.push({ label: 'Marked shipped', at: order.shippedAt, icon: <Truck className="h-3.5 w-3.5" /> });
  for (const r of fv.refunds) {
    events.push({ label: `Refund ${r.amountLabel} recorded (${r.methodLabel})`, at: r.createdAt, icon: <CircleDollarSign className="h-3.5 w-3.5" /> });
    if (r.sentAt && r.method !== 'STRIPE') events.push({ label: `Refund ${r.amountLabel} sent${r.bankRef ? ` — ref ${r.bankRef}` : ''}`, at: r.sentAt, icon: <CircleDollarSign className="h-3.5 w-3.5" /> });
  }
  for (const r of fv.returns) events.push({ label: `${r.rmaNumber} opened — ${r.typeLabel.toLowerCase()} (now: ${r.statusLabel.toLowerCase()})`, at: r.createdAt, icon: <Clock className="h-3.5 w-3.5" /> });
  if (order.status === 'CANCELED') {
    const c = auditEvents.find((e) => e.action.startsWith('order.cancel'));
    events.push({ label: `Canceled${c?.actorEmail ? ` by ${c.actorEmail}` : ''}${c?.meta ? ` — ${briefText(c.meta, 200)}` : ''}`, at: c?.createdAt ?? order.updatedAt, icon: <Clock className="h-3.5 w-3.5" /> });
  }
  events.sort((a, b) => (a.sortAt ?? a.at).getTime() - (b.sortAt ?? b.at).getTime());
  const [canMoney, canFinance] = await Promise.all([hasCapability('orders:refund'), hasCapability('finance:manage')]);
  // Money received and kept on an unpaid order (part payment), and what is still open.
  const receivedCents = heldMoneyCents(order.amountPaidCents, order.refunds);
  const openCents = Math.max(0, order.totalCents - receivedCents);
  const partPaid = order.status === 'PENDING_PAYMENT' && receivedCents > 0;
  const receipts = receiptHistory({ proofs: order.paymentProofs, payments: order.payments, currentProofUrl: order.paymentProofUrl, verificationStatus: order.paymentVerificationStatus });
  // A hold put on while the receipt waits: verifying is refused (verifyPayment) — say so instead of the form.
  const verifyHoldBlock = order.status === 'PENDING_PAYMENT' && order.paymentVerificationStatus === 'AWAITING_VERIFICATION'
    ? bookingHoldBlocker({ holdMessage: prePaymentHoldMessage(order), holdReason: order.holdReason, openHolds: order.openHolds }, 'VERIFY')
    : null;
  // The receipt shown here: Verify / Reject refuse when the buyer replaced it meanwhile.
  const reviewedProofKey = proofKeyOf(order.paymentProofUrl) ?? '';
  const billing = detailsSummary(order);

  const itemsTotal = order.items.reduce((s, i) => s + i.priceCentsSnapshot * i.quantity, 0);
  const hasCompleteAddress = shippingAddressIsComplete(order.shippingAddress);
  // Address stays editable until the parcel leaves (proforma orders start
  // without one; the buyer form closes at PAID).
  // Unpaid orders: billing + delivery are edited together in the details card
  // below (with a proforma revision); after payment only the delivery address.
  const canEditAddress = ['PAID', 'PROCESSING'].includes(order.status) && fv.shipments.length === 0;
  const detailsMissing = orderDetailsProblems(order, { vatIdRule: vatIdRule() });
  const addrSeed = addrFormSeed(order.shippingAddress);
  // One country list everywhere (Settings → Compliance & countries); BLOCK is never offered.
  const shipCountries = canEditAddress ? await countryOptions() : [];
  const shippingPending = order.openHolds.includes('SHIPPING_PENDING') || order.holdReason === 'SHIPPING_PENDING';
  const vatPending = order.vatTreatment === 'REVIEW_REQUIRED';
  const isPaidFamily = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'].includes(order.status);
  const receiptUrl = proxyProofUrl(order.paymentProofUrl);
  const paidByAdmin = order.paidByAdminId
    ? await prisma.user.findUnique({ where: { id: order.paidByAdminId }, select: { email: true } })
    : null;
  const verifiedBy = order.paymentVerifiedById
    ? await prisma.user.findUnique({ where: { id: order.paymentVerifiedById }, select: { email: true } })
    : null;
  const docsForHeader = await getOrderDocuments(order.id);
  const requireAmountOnVerify = settingBool('PAYMENT_REQUIRE_AMOUNT_ON_VERIFY');
  const headerHolds = Array.from(new Set([...order.openHolds, ...(order.holdReason ? [order.holdReason] : [])])).filter((h) => h === 'VAT_REVIEW' || h === 'INVOICE_PENDING' || h === 'STOCK_SHORTAGE');

  return (
    <div className="space-y-6 max-w-6xl">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/admin/orders" className="hover:text-foreground inline-flex items-center gap-1">
          <ChevronLeft className="h-3 w-3" /> Orders
        </Link>
        <span className="opacity-50">/</span>
        <span className="text-foreground font-mono">{order.orderNumber}</span>
      </nav>
      <div className="sticky top-16 z-30 -mx-2 px-2 py-3 bg-background/95 backdrop-blur border-b border-border flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Order</p>
          <h1 className="text-2xl font-bold tracking-tight font-mono">{order.orderNumber}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {smartDate(order.createdAt)}
            {buyer.anonymised && (
              <span className="ml-2 inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">
                buyer anonymised
              </span>
            )}
          </p>
        </div>
        <div className="text-right flex flex-col items-end gap-2">
          <p className="text-2xl font-bold tabular-nums">{formatPrice(order.totalCents, order.currency)}</p>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <span className={`inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border ${TONE_CLASS[tone]}`}>
              {STATUS_LABEL[order.status] ?? order.status.toLowerCase()}
            </span>
            {order.financialStatus === 'PARTIALLY_REFUNDED' && (
              <span className="inline-flex items-center text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border border-border bg-muted text-muted-foreground">partly refunded</span>
            )}
            {fv.refunds.some((r) => r.status === 'REQUESTED') && (
              <a href="#money" className="inline-flex items-center text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                refund to send
              </a>
            )}
            {fv.returns.some((r) => r.open) && (
              <a href="#returns" className="inline-flex items-center text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                open return
              </a>
            )}
            {headerHolds.map((h) => (
              <a key={h} href={h === 'STOCK_SHORTAGE' ? '#stock-shortage' : '#invoice-held'} className="inline-flex items-center text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                {h === 'VAT_REVIEW' ? 'VAT review' : h === 'STOCK_SHORTAGE' ? 'stock shortage' : 'invoice not issued'}
              </a>
            ))}
            {partPaid && (
              <span className="inline-flex items-center text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                part paid · {money(openCents)} due
              </span>
            )}
            {order.paymentMethodManual === 'INVOICE' && ['INVOICED_ON_TERMS', 'OVERDUE', 'PARTIALLY_PAID'].includes(order.financialStatus) && (
              <span className="inline-flex items-center text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
                on invoice terms · {order.financialStatus === 'PARTIALLY_PAID' ? 'partly paid' : 'unpaid'}
              </span>
            )}
            {/* Stored PDF of the issued invoice, else the current proforma (unpaid). */}
            {(docsForHeader.invoice || (order.status === 'PENDING_PAYMENT' && !hasPrePaymentHold(order))) && (
              <a
                href={documentHref(docsForHeader.invoice ? 'invoice' : 'proforma', order.orderNumber, 'pdf')}
                className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-border bg-card text-[11px] font-semibold hover:bg-foreground/5"
              >
                <ReceiptText className="h-3 w-3" /> {docsForHeader.invoice ? `Invoice ${docsForHeader.invoice.number}` : 'Proforma PDF'}
              </a>
            )}
            <Link
              href={`/admin/orders/${order.id}/invoice`}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] font-semibold text-muted-foreground hover:text-foreground"
            >
              Preview
            </Link>
          </div>
        </div>
      </div>
      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
        {/* === Left column === */}
        <div className="space-y-5 min-w-0">
          <NextSteps steps={fv.nextSteps.staff} audience="staff" />

          <OrderPricingPanel orderId={order.id} />

          <OrderDocumentsPanel
            order={{ id: order.id, orderNumber: order.orderNumber, status: order.status, holdReason: order.holdReason, holdNote: order.holdNote }}
            audience="admin"
          />

          <OrderFinancePanel orderId={order.id} />

          {/* Items */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <Package className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold">Items ({order.items.length})</h2>
            </div>
            <ul className="divide-y divide-border">
              {order.items.map((it) => (
                <li key={it.id} className="p-4 space-y-2">
                  <div className="flex items-start gap-4">
                    <div className="flex-1 min-w-0">
                      {it.product ? (
                        <Link
                          href={`/marketplace/${it.product.slug}`}
                          target="_blank"
                          className="font-semibold hover:text-primary block truncate"
                        >
                          {it.titleSnapshot}
                        </Link>
                      ) : (
                        <p className="font-semibold text-muted-foreground italic">
                          {it.titleSnapshot} <span className="text-[10px]">(product removed)</span>
                        </p>
                      )}
                      {it.brandSnapshot && (
                        <p className="text-xs text-muted-foreground mt-0.5">{it.brandSnapshot}</p>
                      )}
                    </div>
                    <div className="text-right text-sm">
                      <p className="font-bold tabular-nums">
                        {formatPrice(it.priceCentsSnapshot, order.currency)} × {it.quantity}
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        = {formatPrice(it.priceCentsSnapshot * it.quantity, order.currency)}
                      </p>
                    </div>
                  </div>
                  {it.product?.seller && (
                    <p className="text-[11px] inline-flex items-center gap-1.5 bg-foreground/[0.03] px-2 py-1 rounded-md">
                      <Building2 className="h-3 w-3 text-muted-foreground" />
                      <span className="text-muted-foreground">Supplier:</span>
                      <Link
                        href={`/admin/users/${it.product.seller.id}`}
                        className="font-semibold hover:text-primary"
                      >
                        {it.product.seller.name}
                      </Link>
                      {it.product.company && (
                        <>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-foreground">{it.product.company.name}</span>
                          {it.product.company.country && (
                            <span className="text-muted-foreground">({it.product.company.country})</span>
                          )}
                        </>
                      )}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <div className="p-4 border-t border-border bg-foreground/[0.02] space-y-1 text-sm">
              <Row label="Items subtotal" value={formatPrice(itemsTotal, order.currency)} />
              <Row label="Order subtotal (snapshot)" value={formatPrice(order.subtotalCents, order.currency)} muted />
              <Row label="Shipping" value={shippingPending ? 'to be confirmed' : order.shippingCents > 0 ? formatPrice(order.shippingCents, order.currency) : 'free'} muted />
              <Row
                label={`VAT${order.vatTreatment ? ` — ${vatTreatmentLabel(order.vatTreatment)}` : ''}`}
                value={vatPending ? 'to be confirmed' : formatPrice(order.taxCents, order.currency)}
                muted
              />
              <div className="pt-1 border-t border-border" />
              <Row label={shippingPending || vatPending ? 'Total so far' : 'Total'} value={formatPrice(order.totalCents, order.currency)} bold />
            </div>
          </section>

          {/* Addresses */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold">Addresses</h2>
            </div>
            <div className="p-5 grid sm:grid-cols-2 gap-5 text-sm">
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
                  Ship to
                </p>
                {shipAddr ? (
                  <address className="not-italic">
                    {shipAddr.name && <p className="font-semibold">{shipAddr.name}</p>}
                    {shipAddr.lines.map((l, i) => <p key={i} className="text-muted-foreground">{l}</p>)}
                  </address>
                ) : (
                  <p className="text-muted-foreground italic text-xs">No address captured.</p>
                )}
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
                  Billing
                </p>
                {billing.billing.length > 0 ? (
                  <address className="not-italic" data-testid="admin-billing">
                    {billing.billing.map((l, i) => <p key={i} className={i === 0 ? 'font-semibold' : 'text-muted-foreground'} dir="auto">{l}</p>)}
                    {billing.vatId && <p className="text-muted-foreground">VAT ID <span className="font-mono text-foreground">{billing.vatId}</span></p>}
                    {billing.po && <p className="text-muted-foreground">PO <span className="font-mono text-foreground">{billing.po}</span></p>}
                  </address>
                ) : sameAddr ? (
                  <p className="text-xs text-muted-foreground italic">Same as shipping</p>
                ) : billAddr ? (
                  <address className="not-italic">
                    {billAddr.name && <p className="font-semibold">{billAddr.name}</p>}
                    {billAddr.lines.map((l, i) => <p key={i} className="text-muted-foreground">{l}</p>)}
                  </address>
                ) : (
                  <p className="text-muted-foreground italic text-xs">
                    {order.sourcingRequestId || order.status === 'PENDING_PAYMENT' ? 'Not given yet — see “Billing & delivery details”.' : 'No separate billing address: the invoice uses the delivery address.'}
                  </p>
                )}
              </div>
            </div>
            {canEditAddress && (
              // Stays open after a save (the address is complete now), so the
              // operator sees "Shipping address saved.".
              <StickyDetails className="border-t border-border" defaultOpen={!hasCompleteAddress}>
                <summary className="cursor-pointer px-5 py-2.5 text-xs font-semibold text-primary hover:bg-foreground/[0.02]">
                  {hasCompleteAddress ? 'Edit shipping address' : 'Add the shipping address (required before shipping)'}
                </summary>
                <OrderActionForm
                  action={setOrderShippingAddress}
                  className="px-5 pb-4 pt-1 grid sm:grid-cols-2 gap-3 text-sm"
                  messageClassName="sm:col-span-2"
                >
                  <input type="hidden" name="orderId" value={order.id} />
                  <AddrField label="Recipient name" name="name" defaultValue={addrSeed.name} required />
                  <AddrField label="Phone" name="phone" defaultValue={addrSeed.phone} />
                  <AddrField label="Address line 1" name="line1" defaultValue={addrSeed.line1} required />
                  <AddrField label="Address line 2" name="line2" defaultValue={addrSeed.line2} />
                  <AddrField label="City" name="city" defaultValue={addrSeed.city} required />
                  <AddrField label="Postal code" name="postal" defaultValue={addrSeed.postal} required />
                  <AddrField label="State / region" name="state" defaultValue={addrSeed.state} />
                  <label className="block">
                    <span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">
                      Country <span className="text-red-600 dark:text-red-400">*</span>
                    </span>
                    <select name="country" defaultValue={shipCountries.some((c) => c.code === addrSeed.country) ? addrSeed.country : ''} required className="w-full h-9 px-2 rounded-lg border border-input bg-background text-sm">
                      <option value="">Choose…</option>
                      {shipCountries.map((c) => (
                        <option key={c.code} value={c.code}>{c.name}{c.review ? ' — compliance review' : ''}</option>
                      ))}
                    </select>
                  </label>
                  <div className="sm:col-span-2">
                    <Button type="submit" size="sm" className="rounded-full">
                      <MapPin className="h-3.5 w-3.5" /> Save address
                    </Button>
                  </div>
                </OrderActionForm>
              </StickyDetails>
            )}
            <div className="px-5 py-3 border-t border-border bg-foreground/[0.02] grid sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
                  Buyer location (at checkout)
                </p>
                <p className="inline-flex items-center gap-1.5">
                  <span className="text-base">{flagFromCountry(order.buyerCountry)}</span>
                  <span className="font-semibold">{order.buyerCountry ?? 'Unknown'}</span>
                  {order.buyerIp && (
                    <span className="font-mono text-xs text-muted-foreground">· {order.buyerIp}</span>
                  )}
                </p>
              </div>
            </div>
          </section>

          {/* === Payment-side panels: details, due date, hold, credit terms === */}
          <OrderPaymentPanels orderId={order.id} />

          {/* === Shipments, returns, money back (lib/fulfilment) ============ */}
          <AdminShipments v={fv} />
          <AdminReturns v={fv} canRefund={canMoney} />
          <AdminMoney v={fv} canRefund={canMoney} />

          {/* Payment */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold">Payment</h2>
            </div>
            <div className="p-5 grid sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Method</p>
                <p className="font-semibold">
                  {paymentLabel(order.paymentMethodBrand, order.paymentMethodLast4, order.paymentMethodWallet, order.paymentMethodManual)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Currency</p>
                <p className="font-semibold">{order.currency}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
                  Stripe session
                </p>
                <p className="font-mono text-xs">{maskId(order.stripeSessionId)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
                  Payment intent
                </p>
                <p className="font-mono text-xs inline-flex items-center gap-1">
                  {maskId(order.stripePaymentIntentId)}
                  {order.stripePaymentIntentId && (
                    <a
                      href={`https://dashboard.stripe.com/payments/${order.stripePaymentIntentId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center"
                      title="Open in Stripe Dashboard"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
                  Deposited into
                </p>
                <p className="font-semibold inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" />
                  {/* What THIS order uses — not merely whether Stripe keys exist (card and bank transfer coexist). */}
                  {order.stripeSessionId || order.stripePaymentIntentId
                    ? process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')
                      ? 'lab2date Stripe account (live mode)'
                      : 'lab2date Stripe account (test mode)'
                    : order.amountPaidCents > 0 || order.paymentMethodManual
                      ? 'Bank account · manual settlement (bank transfer)'
                      : 'Nothing received yet · bank transfer expected'}
                </p>
              </div>
              {order.sourcingRequestId && (
                <div className="sm:col-span-2">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Origin</p>
                  <p>
                    From accepted quote{' '}
                    <Link
                      href={`/admin/quotes/${order.sourcingRequestId}`}
                      className="text-primary hover:underline font-mono text-xs"
                    >
                      {QUOTE_REF(order.sourcingRequestId)}
                    </Link>
                    {order.proformaNumber && <span className="text-muted-foreground"> · proforma <span className="font-mono">{order.proformaNumber}</span></span>}
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* === Payment verification ====================================
              Shown when the buyer has submitted a receipt and admin needs
              to verify or reject. Reads paymentVerificationStatus, payment
              method, note (PO + bank ref), and the proof file. */}
          {order.paymentVerificationStatus === 'AWAITING_VERIFICATION' && (
            <section id="verify" className="rounded-2xl border-2 border-amber-300 bg-amber-50/60 dark:bg-amber-950/30 dark:border-amber-800 overflow-hidden scroll-mt-32">
              <div className="px-5 py-3 border-b border-amber-200 bg-amber-100/60 dark:border-amber-800 dark:bg-amber-900/40 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-amber-800 dark:text-amber-300" />
                <h2 className="text-sm font-bold text-amber-900 dark:text-amber-300">Verify payment</h2>
                <span className="ml-auto text-[10px] uppercase font-bold tracking-wider bg-amber-200 text-amber-900 dark:bg-amber-900/40 dark:text-amber-300 px-1.5 py-0.5 rounded-full">
                  awaiting verification
                </span>
              </div>
              <div className="p-5 space-y-4">
                <dl className="grid sm:grid-cols-[160px_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Method</dt>
                  <dd className="font-semibold">{order.paymentMethodManual?.replace(/_/g, ' ') ?? '—'}</dd>
                  <dt className="text-muted-foreground">Submitted at</dt>
                  <dd className="font-semibold">{order.paymentSubmittedAt ? smartDate(order.paymentSubmittedAt) : '—'}</dd>
                  {order.paymentNote && (
                    <>
                      <dt className="text-muted-foreground">Buyer note</dt>
                      <dd className="text-foreground whitespace-pre-wrap font-mono text-[12px] bg-white border border-amber-200 dark:bg-transparent dark:border-amber-800 rounded p-2">
                        {order.paymentNote}
                      </dd>
                    </>
                  )}
                  {order.paymentProofUrl && (() => {
                    const proxyUrl = proxyProofUrl(order.paymentProofUrl);
                    const isImg = /\.(png|jpe?g|webp|gif)(\?|$)/i.test(order.paymentProofUrl);
                    return proxyUrl ? (
                      <>
                        <dt className="text-muted-foreground">Proof file</dt>
                        <dd className="space-y-2">
                          <a
                            href={proxyUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white dark:bg-transparent dark:border-amber-800 dark:hover:bg-amber-900/40 px-3 py-1.5 text-xs font-semibold hover:bg-amber-100"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            Open receipt
                            <ExternalLink className="h-3 w-3 opacity-60" />
                          </a>
                          {isImg && (
                            // eslint-disable-next-line @next/next/no-img-element
                            (<img
                              src={proxyUrl}
                              alt="Payment receipt"
                              className="max-w-md max-h-96 rounded-lg border border-amber-200 dark:border-amber-800 bg-white"
                            />)
                          )}
                        </dd>
                      </>
                    ) : null;
                  })()}
                </dl>

                {requireDetailsBeforePayment() && detailsMissing.length > 0 && (
                  <p role="alert" className="text-xs font-semibold text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-md px-3 py-2">
                    Billing / delivery details missing ({detailsMissing.join(', ')}). Add them under “Billing & delivery details” before verifying — the invoice and the shipment need them.
                  </p>
                )}
                {!canFinance ? (
                  <p className="text-xs font-semibold text-amber-900 dark:text-amber-300 pt-3 border-t border-amber-200 dark:border-amber-800" data-testid="verify-finance-only">
                    Verifying or rejecting a receipt books money: it needs the “Register payments and credit terms” permission (finance:manage) — Finance does it.
                  </p>
                ) : (
                <div className="grid sm:grid-cols-2 gap-3 pt-3 border-t border-amber-200 dark:border-amber-800">
                  {/* Verify — with what the bank statement says (amount, value date, reference);
                      not while a blocking hold is open (the action refuses it too). */}
                  {verifyHoldBlock ? (
                    <p role="alert" className="text-xs font-semibold text-amber-900 dark:text-amber-300 rounded-md border border-amber-300 dark:border-amber-800 bg-white dark:bg-transparent px-3 py-2" data-testid="verify-held">
                      {verifyHoldBlock}
                    </p>
                  ) : (
                  <OrderActionForm action={verifyPayment} className="space-y-2" announce>
                    <input type="hidden" name="orderId" value={order.id} />
                    <input type="hidden" name="proofKey" value={reviewedProofKey} />
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="block text-[10px] uppercase tracking-wider font-bold text-amber-900/80 dark:text-amber-300 mb-1">Amount received ({order.currency})</span>
                        <input name="amount" inputMode="decimal" required={requireAmountOnVerify} defaultValue={(openCents / 100).toFixed(2)} className="w-full h-9 px-2 rounded-md border border-amber-300 bg-white dark:bg-transparent dark:border-amber-800 text-xs tabular-nums" />
                      </label>
                      <label className="block">
                        <span className="block text-[10px] uppercase tracking-wider font-bold text-amber-900/80 dark:text-amber-300 mb-1">Value date</span>
                        <input type="date" name="receivedAt" required={requireAmountOnVerify} defaultValue={new Date().toISOString().slice(0, 10)} className="w-full h-9 px-2 rounded-md border border-amber-300 bg-white dark:bg-transparent dark:border-amber-800 text-xs" />
                      </label>
                      <label className="block col-span-2">
                        <span className="block text-[10px] uppercase tracking-wider font-bold text-amber-900/80 dark:text-amber-300 mb-1">Bank reference (optional)</span>
                        <input name="bankRef" maxLength={120} placeholder="As on the bank statement" className="w-full h-9 px-2 rounded-md border border-amber-300 bg-white dark:bg-transparent dark:border-amber-800 text-xs" />
                      </label>
                      {/* Only needed when the check below the button asks for it. */}
                      <label className="col-span-2 flex items-start gap-1.5 text-[11px] text-amber-900/90 dark:text-amber-300">
                        <input type="checkbox" name="confirmEarlierDate" className="mt-0.5 h-3.5 w-3.5 accent-primary" />
                        Value date before the order date ({fmtValueDay(order.createdAt)}) — confirmed
                      </label>
                      <label className="col-span-2 flex items-start gap-1.5 text-[11px] text-amber-900/90 dark:text-amber-300">
                        <input type="checkbox" name="confirmLowAmount" className="mt-0.5 h-3.5 w-3.5 accent-primary" />
                        Part payment below {settingInt('PAYMENT_LOW_AMOUNT_CONFIRM_PCT', 50)}% of {money(openCents)} — confirmed
                      </label>
                    </div>
                    <Button type="submit" size="sm" className="w-full rounded-full bg-emerald-600 hover:bg-emerald-700 text-white">
                      <ShieldCheck className="h-3.5 w-3.5" /> Verify payment
                    </Button>
                    <p className="text-[11px] text-muted-foreground">Check the bank statement: the invoice prints this value date. Less than the open amount (beyond the tolerance) is booked as a part payment and the buyer is asked for the rest.</p>
                  </OrderActionForm>
                  )}
                  {/* Reject — reason required */}
                  <OrderActionForm action={rejectPayment} className="space-y-2" announce>
                    <input type="hidden" name="orderId" value={order.id} />
                    <input type="hidden" name="proofKey" value={reviewedProofKey} />
                    <input
                      type="text"
                      name="reason"
                      required
                      minLength={4}
                      maxLength={500}
                      placeholder="Reason (e.g. wrong amount, illegible receipt)"
                      className="w-full h-9 px-2 rounded-md border border-amber-300 bg-white dark:bg-transparent dark:border-amber-800 text-xs"
                    />
                    <Button type="submit" size="sm" variant="outline" className="w-full rounded-full border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40">
                      Reject &amp; ask for resubmit
                    </Button>
                  </OrderActionForm>
                </div>
                )}
              </div>
            </section>
          )}

          {/* === Payment summary (paid states) ============================
              Shown for every paid-family order — verified proof, manual
              mark-paid, or Stripe — with the receipt link whenever one exists. */}
          {isPaidFamily && (order.paymentVerificationStatus === 'VERIFIED' || order.paidByAdminId || receiptUrl) && (
            <section className="rounded-2xl border border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/30 dark:border-emerald-800 p-4 text-sm flex items-start gap-3">
              <ShieldCheck className="h-5 w-5 text-emerald-700 dark:text-emerald-300 mt-0.5" />
              <div className="flex-1">
                <p className="font-bold text-emerald-900 dark:text-emerald-300">
                  {order.paymentVerificationStatus === 'VERIFIED' ? 'Payment verified' : order.paidByAdminId ? 'Marked as paid manually' : 'Payment received'}
                </p>
                <p className="text-emerald-800 dark:text-emerald-300 text-xs mt-1">
                  {order.paymentVerificationStatus === 'VERIFIED'
                    ? <>Verified {order.paymentVerifiedAt ? smartDate(order.paymentVerifiedAt) : ''}{verifiedBy ? ` by ${verifiedBy.email}` : ''}.</>
                    : order.paidAt
                      ? <>Paid {order.stripePaymentIntentId ? smartDate(order.paidAt) : `— value date ${fmtValueDay(order.paidAt)}`}{paidByAdmin ? ` · marked by ${paidByAdmin.email}` : ''}.</>
                      : null}
                  {order.paymentNote && <span className="block mt-1 whitespace-pre-wrap">Note: {order.paymentNote}</span>}
                </p>
                {receiptUrl ? (
                  <a
                    href={receiptUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 mt-2 rounded-lg border border-emerald-300 bg-white dark:bg-transparent dark:border-emerald-800 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
                  >
                    <FileText className="h-3.5 w-3.5" /> Open receipt <ExternalLink className="h-3 w-3 opacity-60" />
                  </a>
                ) : (
                  <p className="text-[11px] text-emerald-800/80 dark:text-emerald-300/80 mt-1">No receipt file on record.</p>
                )}
              </div>
            </section>
          )}

          {/* === Part payment: booked, the rest is still due ================ */}
          {partPaid && order.paymentVerificationStatus !== 'AWAITING_VERIFICATION' && (
            <section className="rounded-2xl border border-amber-300 bg-amber-50/60 dark:bg-amber-950/30 dark:border-amber-800 p-4 text-sm flex items-start gap-3" data-testid="admin-part-paid">
              <CircleDollarSign className="h-5 w-5 text-amber-700 dark:text-amber-300 mt-0.5" />
              <div className="flex-1">
                <p className="font-bold text-amber-900 dark:text-amber-300">Part payment received — {money(receivedCents)} received, {money(openCents)} still due</p>
                <p className="text-amber-900 dark:text-amber-300 text-xs mt-1">The buyer was asked to pay the rest and upload that receipt; the order stays unpaid and no invoice is issued until then. Cancelling needs the part payment refunded or credited first (Money back).</p>
              </div>
            </section>
          )}

          {/* === Rejected payment summary ================================ */}
          {order.paymentVerificationStatus === 'REJECTED' && !partPaid && (
            <section className="rounded-2xl border border-red-200 bg-red-50/50 dark:bg-red-950/30 dark:border-red-800 p-4 text-sm flex items-start gap-3">
              <CircleDollarSign className="h-5 w-5 text-red-700 dark:text-red-300 mt-0.5" />
              <div className="flex-1">
                <p className="font-bold text-red-900 dark:text-red-300">Payment rejected — buyer notified</p>
                {order.paymentRejectionReason && (
                  <p className="text-red-800 dark:text-red-300 text-xs mt-1 italic">Reason: {order.paymentRejectionReason}</p>
                )}
                <p className="text-red-800 dark:text-red-300 text-xs mt-1">Waiting for the buyer to resubmit.</p>
              </div>
            </section>
          )}

          {/* === Every receipt of the order (kept after a rejection or a new upload) === */}
          {receipts.length > 0 && (
            <section className="rounded-2xl border border-border bg-card overflow-hidden" data-testid="admin-receipts">
              <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-bold">Payment receipts ({receipts.length})</h2>
              </div>
              <ul className="divide-y divide-border text-sm">
                {receipts.map((r) => {
                  const href = proxyProofUrl(r.key);
                  return (
                    <li key={r.key} className="px-5 py-3 flex items-start justify-between gap-3">
                      <div className="min-w-0 [overflow-wrap:anywhere]">
                        <p className="font-semibold" dir="auto">{r.fileName ?? r.key.replace(/^order-proofs\//, '')}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.by === 'STAFF' ? 'Attached by staff' : 'From the buyer'}{r.at ? ` · ${smartDate(r.at)}` : ''} · {RECEIPT_STATUS[r.status]}
                          {r.amountCents != null && (r.status === 'PART' || r.status === 'VERIFIED' || r.status === 'BOOKED') ? ` · ${money(r.amountCents)}` : ''}
                          {r.reason ? ` — ${r.reason}` : ''}
                        </p>
                      </div>
                      {href && (
                        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-border text-xs font-semibold hover:bg-foreground/5 flex-shrink-0">
                          Open <ExternalLink className="h-3 w-3 opacity-60" />
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* Timeline */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold">Timeline</h2>
            </div>
            <ol className="p-5 space-y-3 text-sm">
              {events.map((e, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-primary/10 text-primary mt-0.5">
                    {e.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold [overflow-wrap:anywhere]">{e.label}</p>
                    <p className="text-xs text-muted-foreground">{e.dateOnly ? fmtValueDay(e.at) : smartDate(e.at)}</p>
                  </div>
                </li>
              ))}
              {events.length === 1 && (
                <li className="text-xs text-muted-foreground italic">
                  No further state changes yet — order is still in {STATUS_LABEL[order.status] ?? order.status}.
                </li>
              )}
            </ol>
          </section>

          {/* Activity feed — every audit event + admin notification touching this order */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold">Activity feed ({feed.length})</h2>
              <span className="text-[10px] text-muted-foreground ml-auto">audit + admin events, oldest first</span>
            </div>
            {feed.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground italic">
                No recorded activity yet beyond the timeline above.
              </p>
            ) : (
              <ol className="relative pl-6 py-4 pr-4 space-y-2 before:content-[''] before:absolute before:left-3 before:top-4 before:bottom-4 before:w-px before:bg-border">
                {feed.map((e) => (
                  <li key={e.id} className="relative">
                    <span className={`absolute -left-[14px] top-1.5 h-2 w-2 rounded-full ring-2 ring-card ${
                      e.kind === 'audit' ? 'bg-primary' : 'bg-amber-500'
                    }`} />
                    <p className="text-xs [overflow-wrap:anywhere]" title={e.sub && e.sub.length > 240 ? e.sub : undefined}>
                      <span className="font-semibold">{e.label}</span>
                      {e.sub && <span className="text-muted-foreground"> · {briefText(e.sub, 240)}</span>}
                    </p>
                    <p className="text-[10px] text-muted-foreground/80 mt-0.5">
                      {smartDate(e.at)}
                      {e.actor && <span> · by <strong>{e.actor}</strong></span>}
                      <span className="ml-2 inline-block uppercase tracking-wider text-[9px] font-bold opacity-60">
                        {e.kind}
                      </span>
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* Notification log */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold">Buyer notifications fired ({buyerNotifs.length})</h2>
            </div>
            <ul className="divide-y divide-border">
              {buyerNotifs.length === 0 ? (
                <li className="p-4 text-xs text-muted-foreground italic">
                  No in-app notifications sent to the buyer about this order yet.
                </li>
              ) : (
                buyerNotifs.map((n) => (
                  <li key={n.id} className="p-3 flex items-center gap-3 text-sm">
                    <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-foreground/5 text-muted-foreground">
                      {n.kind.toLowerCase()}
                    </span>
                    <p className="flex-1 min-w-0 truncate">{n.title}</p>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {smartDate(n.createdAt)}
                    </span>
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider ${
                        n.readAt ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'
                      }`}
                    >
                      {n.readAt ? 'read' : 'unread'}
                    </span>
                  </li>
                ))
              )}
            </ul>
            <p className="px-4 py-2 text-[10px] text-muted-foreground border-t border-border">
              In-app delivery is tracked here. E-mail goes out via {emailTransportStatus().label}
              {emailTransportStatus().configured ? '' : ' — nothing is being e-mailed until it is configured in Settings → Email'}.
            </p>
          </section>
        </div>

        {/* === Right column === */}
        <aside className="space-y-5">
          <AdminCancelCard v={fv} canRefund={canMoney} />
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <CircleDollarSign className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold">Buyer</h2>
            </div>
            <div className="p-5 space-y-2 text-sm">
              <p className="font-semibold">{buyer.primary}</p>
              {buyer.secondary && (
                <p className="text-muted-foreground">
                  <BuyerEmailReveal email={buyer.secondary} />
                </p>
              )}
              {!buyer.anonymised && order.buyer.id && (
                <Link
                  href={`/admin/users/${order.buyer.id}`}
                  className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  Open user profile <ExternalLink className="h-3 w-3" />
                </Link>
              )}
            </div>
          </section>

          {otherOrders.length > 0 && (
            <section className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-bold">Other orders by this buyer ({otherOrders.length})</h2>
              </div>
              <ul className="divide-y divide-border">
                {otherOrders.map((o) => (
                  <li key={o.id}>
                    <Link
                      href={`/admin/orders/${o.id}`}
                      className="flex items-center gap-3 p-3 hover:bg-foreground/[0.03]"
                    >
                      <span className="font-mono text-[10px] text-muted-foreground flex-shrink-0">
                        {o.orderNumber}
                      </span>
                      <span className="flex-1 text-xs text-muted-foreground truncate">
                        {smartDate(o.createdAt)}
                      </span>
                      <span className="text-xs font-bold tabular-nums flex-shrink-0">
                        {formatPrice(o.totalCents, o.currency)}
                      </span>
                      <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${TONE_CLASS[STATUS_TONE[o.status] ?? 'slate']}`}>
                        {STATUS_LABEL[o.status] ?? o.status.toLowerCase()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <Globe2 className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold">Provenance summary</h2>
            </div>
            <div className="p-5 space-y-2 text-xs">
              <Stat label="Buyer country" value={`${flagFromCountry(order.buyerCountry)} ${order.buyerCountry ?? 'unknown'}`} />
              <Stat label="Buyer IP" value={order.buyerIp ?? 'not captured'} mono />
              <Stat label="Payment method" value={paymentLabel(order.paymentMethodBrand, order.paymentMethodLast4, order.paymentMethodWallet, order.paymentMethodManual)} />
              <Stat label="Items sold" value={`${order.items.length}`} />
              <Stat label="Distinct suppliers" value={String(new Set(order.items.map((i) => i.product?.seller?.id).filter(Boolean)).size)} />
            </div>
          </section>

          <OrderActionForm action={setOrderNotes} className="rounded-2xl border border-border bg-card overflow-hidden" messageClassName="px-5 pb-4">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <StickyNote className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold">Internal notes</h2>
            </div>
            <div className="p-5 space-y-3">
              <input type="hidden" name="orderId" value={order.id} />
              <textarea
                name="notes"
                defaultValue={order.adminNotes ?? ''}
                placeholder="e.g. buyer phoned, hold for new address"
                rows={6}
                maxLength={4000}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
              <Button type="submit" size="sm" className="rounded-full font-semibold w-full">
                Save notes
              </Button>
              <p className="text-[10px] text-muted-foreground">
                Internal only — never sent to buyer. Audit-logged.
              </p>
            </div>
          </OrderActionForm>
        </aside>
      </div>
    </div>
  );
}

const RECEIPT_STATUS: Record<ReceiptStatus, string> = {
  AWAITING: 'awaiting verification',
  REJECTED: 'rejected',
  PART: 'booked as a part payment',
  VERIFIED: 'verified',
  BOOKED: 'booked with the payment',
  REPLACED: 'replaced by a newer upload before review',
  ON_FILE: 'on file',
};

function Row({
  label,
  value,
  muted,
  bold,
}: {
  label: string;
  value: string;
  muted?: boolean;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? 'text-xs text-muted-foreground' : 'text-sm'}>{label}</span>
      <span className={`tabular-nums ${bold ? 'font-bold' : muted ? 'text-xs text-muted-foreground' : 'font-semibold'}`}>
        {value}
      </span>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold text-right ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</span>
    </div>
  );
}

function AddrField({
  label,
  name,
  defaultValue,
  required,
  maxLength,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue: string;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">
        {label} {required && <span className="text-red-600 dark:text-red-400">*</span>}
      </span>
      <input
        name={name}
        defaultValue={defaultValue}
        required={required}
        maxLength={maxLength}
        placeholder={placeholder}
        className="h-9 px-2 rounded-md border border-input bg-background text-xs w-full"
      />
    </label>
  );
}
