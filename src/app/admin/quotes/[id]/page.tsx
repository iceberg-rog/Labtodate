import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft, Crown, ShieldAlert, AlertCircle, ShoppingBag, ExternalLink,
  Building2, FileText, Mail, Hourglass, TrendingUp, ArrowRight,
} from 'lucide-react';
import { requireCapability, getServerSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { EmailText } from '@/components/util/EmailText';
import { QuoteComposer } from '@/components/admin/QuoteComposer';
import { QuoteReissueMagicLink } from '@/components/admin/QuoteReissueMagicLink';
import { computeDealState, toneClasses } from '@/lib/quotes/deal-state';
import { DealStateBadge } from '@/components/quotes/DealStateBadge';
import { AssigneeBadge } from '@/components/quotes/AssigneeBadge';
import { ProformaStepper } from '@/components/quotes/ProformaStepper';
import { BuyerIntelCard } from '@/components/quotes/BuyerIntelCard';
import { ActivityTimeline } from '@/components/quotes/ActivityTimeline';
import { buildBuyerIntel } from '@/lib/quotes/buyer-intel';
import { buildActivityTimeline } from '@/lib/quotes/activity-timeline';
import { MessageAttachments } from '@/components/util/MessageAttachments';

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

function fmtMoney(cents: number, ccy = 'EUR'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(cents / 100);
}

export default async function AdminQuoteDetailPage({ params }: { params: { id: string } }) {
  await requireCapability('quotes:view');
  const session = await getServerSession();

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: params.id },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, email: true } } },
      },
      assignedTo: { select: { id: true, name: true, email: true } },
      submittedBy: { select: { id: true, name: true, email: true, createdAt: true, company: { select: { name: true } } } },
      product: { select: { id: true, title: true, slug: true } },
    },
  });
  if (!sr) notFound();

  const linkedOrder = await prisma.order.findUnique({
    where: { sourcingRequestId: sr.id },
    select: { id: true, orderNumber: true, status: true, totalCents: true, currency: true, paidAt: true },
  });

  const [intel, timeline, admins] = await Promise.all([
    buildBuyerIntel(sr.buyerEmail, sr.submittedBy?.id ?? null),
    buildActivityTimeline(sr.id),
    prisma.user.findMany({
      where: { OR: [{ role: 'ADMIN' }, { role: 'SELLER' }] },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
      take: 30,
    }),
  ]);

  const deal = computeDealState({
    status: sr.status,
    lastReplyByStaff: sr.lastReplyByStaff,
    proformaNumber: sr.proformaNumber,
    linkedOrder: linkedOrder ? { status: linkedOrder.status } : null,
  });
  const dealTone = toneClasses(deal.tone);
  const ref = sr.proformaNumber ?? `RFQ-${sr.id.slice(-6).toUpperCase()}`;
  const title = sr.product?.title ?? sr.productCategory ?? 'General sourcing request';
  const canCompose = !sr.archivedAt && sr.status !== 'CLOSED' && sr.status !== 'ACCEPTED' && sr.status !== 'DECLINED';

  return (
    <div className="space-y-4">
      <AutoRefresh />
      <Link
        href="/admin/quotes"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back to deals
      </Link>

      {/* Stuck-state warning: status=ACCEPTED but no linked order. Surfaces
          legacy quotes where admin replied with a text price and buyer
          clicked the (old) Accept button. New flow prevents this entirely
          (proforma-send is the order trigger) but legacy data may still
          present this state. */}
      {sr.status === 'ACCEPTED' && !linkedOrder && (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-700 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-bold text-red-900">This quote is accepted but no order exists.</p>
            <p className="text-sm text-red-800 mt-1">
              The buyer marked the quote as accepted, but no formal proforma was issued so
              no purchase workspace was created. Send a Proforma below with the agreed
              price — that will materialise the order and email the buyer the payment
              workspace link.
            </p>
          </div>
        </div>
      )}

      {/* ============ HERO: amount + deal state + ownership ============ */}
      <div className={`rounded-2xl border-2 bg-card overflow-hidden ${dealTone.ring} ring-1 ring-inset`}>
        <div className="p-6 grid lg:grid-cols-[1fr_auto] gap-6 items-start">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="font-mono text-[11px] text-muted-foreground">{ref}</span>
              {priorityChip(sr.priority)}
              {sr.customerType === 'GUEST' && (
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0.5">
                  guest
                </span>
              )}
              {sr.archivedAt && (
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-bold rounded-full bg-slate-200 text-slate-700 border border-slate-300 px-1.5 py-0.5">
                  archived
                </span>
              )}
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground mt-1.5 inline-flex items-center gap-1.5 flex-wrap">
              <span className="font-medium text-foreground">{sr.buyerName}</span>
              <span>·</span>
              <EmailText email={sr.buyerEmail} className="hover:text-foreground" asLink />
              {sr.companyName && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3" /> {sr.companyName}</span>
                </>
              )}
            </p>

            {/* Funnel stepper */}
            <div className="mt-5">
              <ProformaStepper badge={deal} />
            </div>
          </div>

          {/* Right rail of hero — DOMINANT amount */}
          <div className="flex flex-col items-end gap-3 lg:min-w-[260px]">
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                {sr.quotedPriceCents ? 'Quoted amount' : 'Awaiting quote'}
              </p>
              {sr.quotedPriceCents ? (
                <p className={`text-4xl font-bold tabular-nums tracking-tight leading-none mt-1 ${
                  deal.state === 'won_paid' ? 'text-emerald-700'
                    : deal.state.startsWith('won_') ? 'text-purple-700'
                    : 'text-foreground'
                }`}>
                  {fmtMoney(sr.quotedPriceCents, sr.quotedCurrency ?? 'EUR')}
                </p>
              ) : (
                <p className="text-2xl text-muted-foreground italic mt-1">—</p>
              )}
              {sr.proformaNumber && sr.validUntilAt && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  {sr.proformaNumber} · valid until {new Date(sr.validUntilAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </p>
              )}
            </div>
            <DealStateBadge badge={deal} />
            <AssigneeBadge
              quoteId={sr.id}
              assignee={sr.assignedTo}
              myUserId={session?.user.id ?? null}
              admins={admins}
              variant="block"
            />
            {linkedOrder && (
              <Link
                href={`/admin/orders/${linkedOrder.id}`}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs font-bold hover:bg-emerald-100"
              >
                Open order {linkedOrder.orderNumber}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* ============ MAIN: conversation-centric + sidebar ============ */}
      <div className="grid xl:grid-cols-[1fr_340px] gap-4 items-start">
        {/* LEFT — original request, conversation, composer */}
        <div className="space-y-4">
          <section className="rounded-2xl border border-border bg-card p-5">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2 inline-flex items-center gap-1">
              <FileText className="h-3 w-3" /> Original request
            </p>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{sr.description}</p>
            {(sr.budget || sr.timeframe || sr.productCategory) && (
              <div className="mt-3 grid sm:grid-cols-3 gap-3 text-xs">
                {sr.budget && <Stat label="Budget" value={sr.budget} />}
                {sr.timeframe && <Stat label="Timeframe" value={sr.timeframe} />}
                {sr.productCategory && <Stat label="Category" value={sr.productCategory} />}
              </div>
            )}
          </section>

          {/* Conversation — the HERO of the workspace */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider">Negotiation</h2>
              <span className="text-xs text-muted-foreground">{`${sr.messages.length} message${sr.messages.length === 1 ? '' : 's'}`}</span>
            </div>
            <div className="p-5 space-y-3 max-h-[760px] overflow-y-auto bg-foreground/[0.02]">
              {sr.messages.length === 0 ? (
                <div className="rounded-xl border-2 border-dashed border-border bg-card p-5">
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
                    Lifecycle so far
                  </p>
                  <ActivityTimeline events={timeline} />
                </div>
              ) : (
                <ul className="space-y-3">
                  {sr.messages.map((m) => (
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
                        <p className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-1">
                          {m.isInternalNote
                            ? `Internal note · ${m.author?.name ?? m.author?.email ?? 'staff'}`
                            : m.fromStaff
                            ? (m.author?.name ?? m.author?.email ?? 'Staff')
                            : sr.buyerName}
                          {' · '}
                          {new Date(m.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </p>
                        <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
                        <MessageAttachments urls={m.attachments} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Composer — collapsed by default; expands to compose */}
          {canCompose && (
            <QuoteComposer quoteId={sr.id} buyerEmail={sr.buyerEmail} canSendProforma />
          )}
        </div>

        {/* RIGHT — sidebar: customer intelligence, linked commerce, activity, magic-link */}
        <aside className="space-y-3 xl:sticky xl:top-20 xl:self-start xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto pb-6">
          <BuyerIntelCard
            intel={intel}
            buyerName={sr.buyerName}
            buyerEmail={sr.buyerEmail}
            company={sr.submittedBy?.company?.name ?? sr.companyName ?? null}
            isGuest={sr.customerType === 'GUEST'}
          />

          {/* Linked commerce — product anchor + accepted order */}
          <SidebarCard title="Linked commerce" icon={<ShoppingBag className="h-3.5 w-3.5 text-primary" />}>
            {sr.product && (
              <p className="text-[11px] mb-2">
                <span className="text-muted-foreground">Product · </span>
                <Link href={`/marketplace/${sr.product.slug}`} className="font-semibold hover:text-primary inline-flex items-center gap-1">
                  {sr.product.title} <ExternalLink className="h-3 w-3" />
                </Link>
              </p>
            )}
            {linkedOrder ? (
              <div className="space-y-1.5">
                <Link href={`/admin/orders/${linkedOrder.id}`} className="inline-flex items-center gap-1 font-mono text-[12px] font-semibold hover:text-primary">
                  {linkedOrder.orderNumber} <ExternalLink className="h-3 w-3" />
                </Link>
                <p className="text-[11px]">
                  <span className="font-semibold">{linkedOrder.status.toLowerCase().replace(/_/g, ' ')}</span>
                  {' · '}
                  <span className="text-muted-foreground">{fmtMoney(linkedOrder.totalCents, linkedOrder.currency)}</span>
                </p>
              </div>
            ) : sr.quotedPriceCents ? (
              <p className="text-[11px]">
                Quote sent: <strong>{fmtMoney(sr.quotedPriceCents, sr.quotedCurrency ?? 'EUR')}</strong>
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground italic">No order or proforma yet.</p>
            )}
            {sr.customerType === 'GUEST' && <QuoteReissueMagicLink quoteId={sr.id} />}
          </SidebarCard>

          {/* Activity log */}
          <SidebarCard title="Activity" icon={<Hourglass className="h-3.5 w-3.5 text-primary" />}>
            <ActivityTimeline events={timeline} />
          </SidebarCard>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
      <p className="font-bold text-sm mt-0.5">{value}</p>
    </div>
  );
}

function SidebarCard({ title, icon, children }: { title: string; icon?: JSX.Element; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-2 inline-flex items-center gap-1">
        {icon}{title}
      </p>
      {children}
    </div>
  );
}
