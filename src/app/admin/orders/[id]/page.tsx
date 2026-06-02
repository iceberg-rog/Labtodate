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
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { setOrderNotes, setOrderFulfillment, verifyPayment, rejectPayment } from '@/app/admin/actions';
import { BuyerEmailReveal } from '@/components/admin/BuyerEmailReveal';
import {
  humaniseBuyer,
  smartDate,
  STATUS_LABEL,
  STATUS_TONE,
} from '@/lib/orders/display';

export const dynamic = 'force-dynamic';

const TONE_CLASS: Record<string, string> = {
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  sky: 'bg-sky-100 text-sky-800 border-sky-200',
  emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  violet: 'bg-violet-100 text-violet-800 border-violet-200',
  red: 'bg-red-100 text-red-800 border-red-200',
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
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

/**
 * Receipts are stored in a PRIVATE S3 prefix. The DB still has the raw S3
 * URL for back-compat, but we serve via /api/order-proof/<key> which auth-
 * checks the requester is admin or the order's buyer. Returns null if the
 * URL doesn't look like an order-proofs key (defensive).
 */
function proxyProofUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const m = rawUrl.match(/order-proofs\/[^?#]+/);
  return m ? `/api/order-proof/${m[0]}` : null;
}

// Inline server-action adapters — form `action={...}` requires Promise<void>,
// but verifyPayment/rejectPayment return { ok, message } for programmatic use.
async function verifyPaymentAction(formData: FormData): Promise<void> {
  'use server';
  await verifyPayment(formData);
}
async function rejectPaymentAction(formData: FormData): Promise<void> {
  'use server';
  await rejectPayment(formData);
}

export default async function AdminOrderDetailPage({ params }: { params: { id: string } }) {
  await requireCapability('orders:view');

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

  // Build a timeline of state-change facts we actually have.
  const events: { label: string; at: Date; icon: React.ReactNode }[] = [];
  events.push({ label: 'Created (cart submitted)', at: order.createdAt, icon: <Clock className="h-3.5 w-3.5" /> });
  if (order.paidAt) events.push({ label: 'Payment received', at: order.paidAt, icon: <CreditCard className="h-3.5 w-3.5" /> });
  if (order.shippedAt) events.push({ label: 'Marked shipped', at: order.shippedAt, icon: <Truck className="h-3.5 w-3.5" /> });
  if (order.deliveredAt) events.push({ label: 'Delivered', at: order.deliveredAt, icon: <Package className="h-3.5 w-3.5" /> });
  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  const itemsTotal = order.items.reduce((s, i) => s + i.priceCentsSnapshot * i.quantity, 0);

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
              <span className="ml-2 inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
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
            <Link
              href={`/admin/orders/${order.id}/invoice`}
              target="_blank"
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-border bg-card text-[11px] font-semibold hover:bg-foreground/5"
            >
              <ReceiptText className="h-3 w-3" /> Invoice
            </Link>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
        {/* === Left column === */}
        <div className="space-y-5 min-w-0">

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
              {order.shippingCents > 0 && (
                <Row label="Shipping" value={formatPrice(order.shippingCents, order.currency)} muted />
              )}
              {order.taxCents > 0 && (
                <Row label="Tax" value={formatPrice(order.taxCents, order.currency)} muted />
              )}
              <div className="pt-1 border-t border-border" />
              <Row label="Total" value={formatPrice(order.totalCents, order.currency)} bold />
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
                {sameAddr ? (
                  <p className="text-xs text-muted-foreground italic">Same as shipping</p>
                ) : billAddr ? (
                  <address className="not-italic">
                    {billAddr.name && <p className="font-semibold">{billAddr.name}</p>}
                    {billAddr.lines.map((l, i) => <p key={i} className="text-muted-foreground">{l}</p>)}
                  </address>
                ) : (
                  <p className="text-muted-foreground italic text-xs">Not provided (Stripe didn’t return billing).</p>
                )}
              </div>
            </div>
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

          {/* === Fulfillment controls — only on shippable orders =========== */}
          {['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status) && (
            <section className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
                <Truck className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-bold">Fulfillment</h2>
              </div>
              <form action={setOrderFulfillment} className="p-5 grid sm:grid-cols-4 gap-3 items-end text-sm">
                <input type="hidden" name="orderId" value={order.id} />
                <label className="block sm:col-span-1">
                  <span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Status</span>
                  <select
                    name="status"
                    defaultValue={order.status}
                    className="h-9 px-2 rounded-md border border-input bg-background text-xs font-medium w-full"
                  >
                    {(['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const).map((s) => (
                      <option key={s} value={s}>{s.toLowerCase()}</option>
                    ))}
                  </select>
                </label>
                <label className="block sm:col-span-1">
                  <span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Carrier</span>
                  <select
                    name="carrier"
                    defaultValue={order.trackingCarrier ?? ''}
                    className="h-9 px-2 rounded-md border border-input bg-background text-xs font-medium w-full"
                  >
                    <option value="">—</option>
                    {['DHL', 'UPS', 'FedEx', 'TNT', 'GLS', 'DPD', 'USPS', 'Other'].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className="block sm:col-span-1">
                  <span className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Tracking #</span>
                  <input
                    type="text"
                    name="trackingNumber"
                    defaultValue={order.trackingNumber ?? ''}
                    placeholder="1Z…"
                    className="h-9 px-2 rounded-md border border-input bg-background text-xs font-mono w-full"
                  />
                </label>
                <div className="sm:col-span-1">
                  <Button type="submit" size="sm" className="w-full rounded-full gap-1.5">
                    <Truck className="h-3.5 w-3.5" /> Save &amp; notify buyer
                  </Button>
                </div>
                <p className="sm:col-span-4 text-[11px] text-muted-foreground">
                  Entering a tracking number auto-advances status to <strong>Shipped</strong>. Mark{' '}
                  <strong>Delivered</strong> manually here, or the buyer can confirm receipt from their order page.
                </p>
              </form>
              {order.shippedAt && (
                <div className="px-5 pb-4 text-xs text-muted-foreground">
                  Shipped {smartDate(order.shippedAt)}
                  {order.deliveredAt && <> · Delivered {smartDate(order.deliveredAt)}</>}
                </div>
              )}
            </section>
          )}

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
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-700" />
                  {process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')
                    ? 'lab2date Stripe account (live mode)'
                    : process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')
                    ? 'lab2date Stripe account (test mode)'
                    : 'Manual settlement · bank transfer (no Stripe)'}
                </p>
              </div>
              {order.sourcingRequestId && (
                <div className="sm:col-span-2">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Origin</p>
                  <p>
                    From accepted quote{' '}
                    <Link
                      href={`/app/seller/inbox/${order.sourcingRequestId}`}
                      className="text-primary hover:underline font-mono text-xs"
                    >
                      {maskId(order.sourcingRequestId)}
                    </Link>
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
            <section className="rounded-2xl border-2 border-amber-300 bg-amber-50/60 overflow-hidden">
              <div className="px-5 py-3 border-b border-amber-200 bg-amber-100/60 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-amber-800" />
                <h2 className="text-sm font-bold text-amber-900">Verify payment</h2>
                <span className="ml-auto text-[10px] uppercase font-bold tracking-wider bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded-full">
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
                      <dd className="text-foreground whitespace-pre-wrap font-mono text-[12px] bg-white border border-amber-200 rounded p-2">
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
                            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-amber-100"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            Open receipt
                            <ExternalLink className="h-3 w-3 opacity-60" />
                          </a>
                          {isImg && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={proxyUrl}
                              alt="Payment receipt"
                              className="max-w-md max-h-96 rounded-lg border border-amber-200 bg-white"
                            />
                          )}
                        </dd>
                      </>
                    ) : null;
                  })()}
                </dl>

                <div className="grid sm:grid-cols-2 gap-3 pt-3 border-t border-amber-200">
                  {/* Verify */}
                  <form action={verifyPaymentAction}>
                    <input type="hidden" name="orderId" value={order.id} />
                    <Button type="submit" size="sm" className="w-full rounded-full bg-emerald-600 hover:bg-emerald-700 text-white">
                      <ShieldCheck className="h-3.5 w-3.5" /> Verify payment
                    </Button>
                  </form>
                  {/* Reject — reason required */}
                  <form action={rejectPaymentAction} className="space-y-2">
                    <input type="hidden" name="orderId" value={order.id} />
                    <input
                      type="text"
                      name="reason"
                      required
                      minLength={4}
                      maxLength={500}
                      placeholder="Reason (e.g. wrong amount, illegible receipt)"
                      className="w-full h-9 px-2 rounded-md border border-amber-300 bg-white text-xs"
                    />
                    <Button type="submit" size="sm" variant="outline" className="w-full rounded-full border-red-300 text-red-700 hover:bg-red-50">
                      Reject &amp; ask for resubmit
                    </Button>
                  </form>
                </div>
              </div>
            </section>
          )}

          {/* === Verified payment summary (PAID state) ==================== */}
          {order.paymentVerificationStatus === 'VERIFIED' && order.paidByAdminId && (
            <section className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4 text-sm flex items-start gap-3">
              <ShieldCheck className="h-5 w-5 text-emerald-700 mt-0.5" />
              <div className="flex-1">
                <p className="font-bold text-emerald-900">Payment verified</p>
                <p className="text-emerald-800 text-xs mt-1">
                  Verified {order.paymentVerifiedAt ? smartDate(order.paymentVerifiedAt) : ''}.
                  {(() => {
                    const u = proxyProofUrl(order.paymentProofUrl);
                    return u ? <> <a href={u} target="_blank" rel="noreferrer" className="underline font-semibold">Open receipt</a>.</> : null;
                  })()}
                </p>
              </div>
            </section>
          )}

          {/* === Rejected payment summary ================================ */}
          {order.paymentVerificationStatus === 'REJECTED' && (
            <section className="rounded-2xl border border-red-200 bg-red-50/50 p-4 text-sm flex items-start gap-3">
              <CircleDollarSign className="h-5 w-5 text-red-700 mt-0.5" />
              <div className="flex-1">
                <p className="font-bold text-red-900">Payment rejected — buyer notified</p>
                {order.paymentRejectionReason && (
                  <p className="text-red-800 text-xs mt-1 italic">Reason: {order.paymentRejectionReason}</p>
                )}
                <p className="text-red-800 text-xs mt-1">Waiting for the buyer to resubmit.</p>
              </div>
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
                    <p className="font-semibold">{e.label}</p>
                    <p className="text-xs text-muted-foreground">{smartDate(e.at)}</p>
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
                    <p className="text-xs">
                      <span className="font-semibold">{e.label}</span>
                      {e.sub && <span className="text-muted-foreground"> · {e.sub.slice(0, 200)}</span>}
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
                        n.readAt ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      {n.readAt ? 'read' : 'unread'}
                    </span>
                  </li>
                ))
              )}
            </ul>
            <p className="px-4 py-2 text-[10px] text-muted-foreground border-t border-border">
              In-app delivery is tracked here. Email delivery requires <code>RESEND_API_KEY</code> + verified domain
              {process.env.RESEND_API_KEY ? ' (configured)' : ' (not configured — emails land in Mailpit dev mailbox only)'}.
            </p>
          </section>
        </div>

        {/* === Right column === */}
        <aside className="space-y-5">
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

          <form action={setOrderNotes} className="rounded-2xl border border-border bg-card overflow-hidden">
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
          </form>
        </aside>
      </div>
    </div>
  );
}

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
