import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft,
  Building2,
  Mail,
  Phone,
  Crown,
  ShieldAlert,
  AlertCircle,
  FileText,
  ShoppingBag,
  ExternalLink,
  UserCircle,
  TrendingUp,
  Repeat,
  Hourglass,
  CircleDollarSign,
  Truck,
  Lock,
} from 'lucide-react';
import { requireCapability, getServerSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { MessageAttachments } from '@/components/util/MessageAttachments';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { TicketHeaderControls } from '@/components/admin/TicketHeaderControls';
import { TicketSidebarQuickActions } from '@/components/admin/TicketSidebarQuickActions';
import { TicketLinkOrder } from '@/components/admin/TicketLinkOrder';
import { TicketComposer } from '@/components/admin/TicketComposer';
import { CustomerHoverCard, type CustomerHoverInfo } from '@/components/admin/CustomerHoverCard';
import { ReissueMagicLink } from '@/components/admin/ReissueMagicLink';
import { EmailText } from '@/components/util/EmailText';

export const dynamic = 'force-dynamic';

function priorityChip(priority: string) {
  const styles: Record<string, { cls: string; icon: JSX.Element; label: string }> = {
    VIP:    { cls: 'bg-purple-100 text-purple-800 border-purple-300', icon: <Crown className="h-3 w-3" />,       label: 'VIP' },
    URGENT: { cls: 'bg-red-100 text-red-800 border-red-300',          icon: <ShieldAlert className="h-3 w-3" />, label: 'URGENT' },
    HIGH:   { cls: 'bg-amber-100 text-amber-800 border-amber-300',    icon: <AlertCircle className="h-3 w-3" />, label: 'HIGH' },
    NORMAL: { cls: 'bg-slate-100 text-slate-700 border-slate-200',    icon: <></>,                              label: 'normal' },
    LOW:    { cls: 'bg-slate-50 text-slate-600 border-slate-200',     icon: <></>,                              label: 'low' },
  };
  const s = styles[priority] ?? styles.NORMAL;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full border ${s.cls}`}>
      {s.icon}{s.label}
    </span>
  );
}

function statusChip(status: string) {
  const cls: Record<string, string> = {
    OPEN: 'bg-amber-50 text-amber-800 border-amber-200',
    WAITING_ON_SUPPORT: 'bg-amber-50 text-amber-800 border-amber-200',
    WAITING_ON_CUSTOMER: 'bg-sky-50 text-sky-800 border-sky-200',
    RESOLVED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    CLOSED: 'bg-slate-100 text-slate-600 border-slate-200',
    SPAM: 'bg-slate-100 text-slate-500 border-slate-200',
    PENDING: 'bg-sky-50 text-sky-800 border-sky-200',
  };
  return (
    <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border ${cls[status] ?? cls.OPEN}`}>
      {status.toLowerCase().replace(/_/g, ' ')}
    </span>
  );
}

function fmt(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function fmtAddr(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const ad = (o.address as Record<string, unknown>) || o;
  return [
    typeof ad.line1 === 'string' ? ad.line1 : null,
    [ad.postal_code, ad.city, ad.country].filter(Boolean).join(' '),
  ].filter((x): x is string => !!x && x.trim().length > 0);
}

export default async function AdminTicketDetailPage({ params }: { params: { id: string } }) {
  await requireCapability('tickets:view');
  const session = await getServerSession();

  const t = await prisma.supportTicket.findUnique({
    where: { id: params.id },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      assignedTo: { select: { id: true, name: true, email: true } },
      submittedBy: {
        select: {
          id: true,
          name: true,
          email: true,
          createdAt: true,
          company: { select: { name: true } },
        },
      },
    },
  });
  if (!t) notFound();

  // === Customer intel: orders + LTV + recent activity ===
  let buyerOrders: { id: string; orderNumber: string; status: string; totalCents: number; currency: string; createdAt: Date }[] = [];
  let buyerStats = { paidCount: 0, lifetimeCents: 0 };
  let buyerRfqs: { id: string; status: string; proformaNumber: string | null; quotedPriceCents: number | null; createdAt: Date }[] = [];
  const buyerPhone = t.submittedBy
    ? null // phone lives on Order.shippingAddress, not on User
    : null;
  if (t.submittedBy) {
    const [ords, agg, rfqs] = await Promise.all([
      prisma.order.findMany({
        where: { buyerId: t.submittedBy.id },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: { id: true, orderNumber: true, status: true, totalCents: true, currency: true, createdAt: true },
      }),
      prisma.order.aggregate({
        where: { buyerId: t.submittedBy.id, status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] } },
        _count: { _all: true },
        _sum: { totalCents: true },
      }),
      prisma.sourcingRequest.findMany({
        where: { submittedById: t.submittedBy.id },
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: { id: true, status: true, proformaNumber: true, quotedPriceCents: true, createdAt: true },
      }),
    ]);
    buyerOrders = ords;
    buyerStats = { paidCount: agg._count._all, lifetimeCents: agg._sum.totalCents ?? 0 };
    buyerRfqs = rfqs;
  }

  // === Linked-commerce row (auto-detected at submit, operator-overridable) ===
  const [linkedOrder, linkedRfq] = await Promise.all([
    t.orderId
      ? prisma.order.findUnique({
          where: { id: t.orderId },
          include: {
            buyer: { select: { name: true, email: true } },
            items: { select: { titleSnapshot: true, quantity: true } },
          },
        })
      : null,
    t.sourcingRequestId
      ? prisma.sourcingRequest.findUnique({
          where: { id: t.sourcingRequestId },
          select: {
            id: true, status: true, proformaNumber: true, quotedPriceCents: true,
            quotedCurrency: true, validUntilAt: true, description: true,
          },
        })
      : null,
  ]);

  const adminCandidates = await prisma.user.findMany({
    where: { role: 'ADMIN' },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });

  const totalBuyerSpend = buyerStats.lifetimeCents;
  const shipAddr = linkedOrder ? fmtAddr(linkedOrder.shippingAddress) : [];

  const customerInfo: CustomerHoverInfo = {
    userId: t.submittedBy?.id ?? null,
    name: t.name,
    email: t.email,
    company: t.submittedBy?.company?.name ?? null,
    joinedAtISO: t.submittedBy?.createdAt?.toISOString() ?? null,
    paidOrderCount: buyerStats.paidCount,
    lifetimeCents: buyerStats.lifetimeCents,
    isGuest: !t.submittedBy,
  };

  return (
    <div className="space-y-4">
      <AutoRefresh />
      <Link
        href="/admin/tickets"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back to queue
      </Link>

      {/* === Header card === */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <span className="font-mono text-[11px] text-muted-foreground">{t.ref}</span>
              {priorityChip(t.priority)}
              {statusChip(t.status)}
              {t.customerType === 'GUEST' && (
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0.5">
                  guest
                </span>
              )}
              {t.archivedAt && (
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-slate-200 text-slate-700 border border-slate-300 px-1.5 py-0.5">
                  archived
                </span>
              )}
              {t.assignedTo ? (
                <span className="text-[11px] text-muted-foreground">
                  assigned to <strong className="text-foreground">{t.assignedTo.email}</strong>
                </span>
              ) : (
                <span className="text-[11px] text-amber-700 font-semibold">unassigned</span>
              )}
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{t.subject}</h1>
            <p className="text-sm text-muted-foreground mt-1 inline-flex items-center gap-1.5 flex-wrap">
              <CustomerHoverCard
                info={customerInfo}
                trigger={<span className="font-medium text-foreground">{t.name}</span>}
              />
              <span>·</span>
              <EmailText email={t.email} className="hover:text-foreground" asLink />
              {t.category && (
                <>
                  <span>·</span>
                  <span>{t.category}</span>
                </>
              )}
            </p>
          </div>
          {/* Controls — client component for status / priority / claim / transfer */}
          <TicketHeaderControls
            ticketId={t.id}
            status={t.status}
            priority={t.priority}
            assignedToId={t.assignedTo?.id ?? null}
            myUserId={session?.user.id ?? null}
            admins={adminCandidates}
            archived={!!t.archivedAt}
          />
        </div>
      </div>

      {/* === Split layout === */}
      <div className="grid xl:grid-cols-[1fr_360px] gap-4 items-start">
        {/* === LEFT: conversation + reply forms === */}
        <div className="space-y-4">
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider">Conversation</h2>
              <span className="text-xs text-muted-foreground">{`${t.messages.length} message${t.messages.length === 1 ? '' : 's'}`}</span>
            </div>
            <ul className="p-5 space-y-3 max-h-[700px] overflow-y-auto bg-foreground/[0.02]">
              {t.messages.map((m) => (
                <li key={m.id}>
                  <div
                    className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                      m.isInternalNote
                        ? 'bg-amber-50 border border-amber-200 text-amber-900 mx-auto w-full max-w-[92%]'
                        : m.fromStaff
                        ? 'bg-primary text-primary-foreground ml-auto'
                        : 'bg-card border border-border'
                    }`}
                  >
                    <p className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-1 inline-flex items-center gap-1">
                      {m.isInternalNote && <Lock className="h-3 w-3" />}
                      {m.isInternalNote ? (
                        <span>Internal note</span>
                      ) : m.fromStaff ? (
                        <span>Support</span>
                      ) : (
                        <CustomerHoverCard info={customerInfo} trigger={<span>{t.name}</span>} />
                      )}
                      <span>·</span>
                      <span>
                        {new Date(m.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </p>
                    <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
                    <MessageAttachments urls={m.attachments} />
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <TicketComposer ticketId={t.id} customerEmail={t.email} />
        </div>

        {/* === RIGHT sidebar: customer profile + linked commerce + actions === */}
        <aside className="space-y-3 xl:sticky xl:top-20 xl:self-start xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto pb-6">
          {/* Customer profile */}
          <SidebarCard title="Customer" icon={<UserCircle className="h-3.5 w-3.5 text-primary" />}>
            <div className="space-y-1.5">
              <p className="font-bold text-sm">{t.name}</p>
              <p className="text-xs inline-flex items-center gap-1.5">
                <Mail className="h-3 w-3 text-muted-foreground" />
                <EmailText email={t.email} className="hover:text-primary" asLink />
              </p>
              {t.submittedBy?.company?.name && (
                <p className="text-xs inline-flex items-center gap-1.5 text-muted-foreground">
                  <Building2 className="h-3 w-3" />
                  <span>{t.submittedBy.company.name}</span>
                </p>
              )}
              {t.submittedBy && (
                <p className="text-[10px] text-muted-foreground">
                  Joined {new Date(t.submittedBy.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border mt-2">
                <Stat
                  label="Paid orders"
                  value={String(buyerStats.paidCount)}
                  icon={<Repeat className="h-3 w-3" />}
                />
                <Stat
                  label="LTV"
                  value={totalBuyerSpend > 0 ? fmt(totalBuyerSpend, 'EUR') : '—'}
                  icon={<TrendingUp className="h-3 w-3" />}
                />
              </div>
              {!t.submittedBy && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2 mt-2">
                  Guest ticket — no account on file. Reply emails include a magic link the customer can use to follow up without signing up.
                </p>
              )}
              {t.customerType === 'GUEST' && <ReissueMagicLink ticketId={t.id} />}
            </div>
          </SidebarCard>

          {/* Linked commerce — always shown so admin can attach/replace an
           *  order from here even if the auto-detect missed the order number
           *  in the body. */}
          <SidebarCard title="Linked commerce" icon={<ShoppingBag className="h-3.5 w-3.5 text-primary" />}>
            {!linkedOrder && !linkedRfq && (
              <p className="text-[11px] text-muted-foreground italic">No order or RFQ linked yet.</p>
            )}
            {(linkedOrder || linkedRfq) && (
              <>
              {linkedOrder && (
                <div className="space-y-1.5">
                  <Link
                    href={`/admin/orders/${linkedOrder.id}`}
                    className="inline-flex items-center gap-1 font-mono text-[12px] font-semibold hover:text-primary"
                  >
                    {linkedOrder.orderNumber} <ExternalLink className="h-3 w-3" />
                  </Link>
                  <p className="text-[11px]">
                    <span className="font-semibold">{linkedOrder.status.toLowerCase().replace(/_/g, ' ')}</span>
                    {' · '}
                    <span className="text-muted-foreground">{fmt(linkedOrder.totalCents, linkedOrder.currency)}</span>
                  </p>
                  {linkedOrder.items[0] && (
                    <p className="text-[11px] text-muted-foreground line-clamp-1">
                      {linkedOrder.items[0].titleSnapshot}{linkedOrder.items.length > 1 ? ` +${linkedOrder.items.length - 1}` : ''}
                    </p>
                  )}
                  {linkedOrder.trackingCarrier && (
                    <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                      <Truck className="h-3 w-3" />
                      <span>{`${linkedOrder.trackingCarrier} ${linkedOrder.trackingNumber ?? ''}`}</span>
                    </p>
                  )}
                  {shipAddr.length > 0 && (
                    <p className="text-[11px] text-muted-foreground">{shipAddr.join(', ')}</p>
                  )}
                </div>
              )}
              {linkedRfq && (
                <div className="space-y-1.5">
                  <Link
                    href={`/admin/quotes`}
                    className="inline-flex items-center gap-1 font-mono text-[12px] font-semibold hover:text-primary"
                  >
                    {linkedRfq.proformaNumber ?? linkedRfq.id.slice(-8)} <ExternalLink className="h-3 w-3" />
                  </Link>
                  <p className="text-[11px]">
                    <span className="font-semibold">{linkedRfq.status}</span>
                    {linkedRfq.quotedPriceCents && (
                      <>
                        {' · '}
                        <span className="text-muted-foreground">{fmt(linkedRfq.quotedPriceCents, linkedRfq.quotedCurrency ?? 'EUR')}</span>
                      </>
                    )}
                  </p>
                  {linkedRfq.validUntilAt && (
                    <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                      <Hourglass className="h-3 w-3" /> valid until {linkedRfq.validUntilAt.toISOString().slice(0, 10)}
                    </p>
                  )}
                </div>
              )}
              {linkedOrder && (
                <TicketSidebarQuickActions
                  orderId={linkedOrder.id}
                  orderNumber={linkedOrder.orderNumber}
                  status={linkedOrder.status}
                  paymentVerificationStatus={linkedOrder.paymentVerificationStatus}
                />
              )}
              </>
            )}
            {/* Always-on link/relink form. Empty input clears the link. */}
            <TicketLinkOrder ticketId={t.id} currentOrderNumber={linkedOrder?.orderNumber ?? null} />
          </SidebarCard>

          {/* Order history (last 6) */}
          {buyerOrders.length > 0 && (
            <SidebarCard title="Recent orders" icon={<CircleDollarSign className="h-3.5 w-3.5 text-primary" />}>
              <ul className="space-y-1.5">
                {buyerOrders.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-2 text-[11px]">
                    <Link href={`/admin/orders/${o.id}`} className="font-mono font-semibold hover:text-primary truncate">
                      {o.orderNumber}
                    </Link>
                    <span className="text-muted-foreground">{fmt(o.totalCents, o.currency)}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {o.status.toLowerCase().replace(/_/g, ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            </SidebarCard>
          )}

          {/* RFQs */}
          {buyerRfqs.length > 0 && (
            <SidebarCard title="Recent RFQs" icon={<FileText className="h-3.5 w-3.5 text-primary" />}>
              <ul className="space-y-1.5">
                {buyerRfqs.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-mono font-semibold truncate">{r.proformaNumber ?? r.id.slice(-8)}</span>
                    <span className="text-muted-foreground">
                      {r.quotedPriceCents ? fmt(r.quotedPriceCents, 'EUR') : '—'}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{r.status}</span>
                  </li>
                ))}
              </ul>
            </SidebarCard>
          )}

          {/* SLA / timestamps */}
          <SidebarCard title="Timeline" icon={<Hourglass className="h-3.5 w-3.5 text-primary" />}>
            <div className="space-y-1 text-[11px]">
              <div className="flex justify-between"><span className="text-muted-foreground">Opened</span><span>{t.createdAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
              {t.dueAt && (
                <div className="flex justify-between"><span className="text-muted-foreground">SLA due</span><span className="font-semibold">{t.dueAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
              )}
              {t.lastReplyAt && (
                <div className="flex justify-between"><span className="text-muted-foreground">Last reply</span><span>{t.lastReplyByStaff ? 'support' : 'customer'} · {t.lastReplyAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
              )}
            </div>
          </SidebarCard>
        </aside>
      </div>
    </div>
  );
}

function SidebarCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-2 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
        {icon}
        <h3 className="text-xs font-bold uppercase tracking-wider">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground inline-flex items-center gap-1">
        {icon} {label}
      </p>
      <p className="text-sm font-bold tabular-nums">{value}</p>
    </div>
  );
}
