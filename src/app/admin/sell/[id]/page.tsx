import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft, Check, X, Mail, Phone, Building2, MapPin, Package,
  Banknote, FileText, Hourglass, ImageIcon, ExternalLink, ShieldCheck,
  Inbox, MessageSquare, Sparkles, Truck, CheckCheck, Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireCapability, getServerSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { setSellStatus } from '@/app/admin/actions';
import {
  replySellSubmission,
  proposeAcquisitionPrice,
  markAcquisitionReceived,
  uploadReceiptAndComplete,
} from '@/lib/sell/actions';
import { ReplyForm } from '@/components/util/ReplyForm';
import { MessageAttachments } from '@/components/util/MessageAttachments';
import { EmailText } from '@/components/util/EmailText';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { computeSellState, sellToneClasses } from '@/lib/sell/deal-state';

export const dynamic = 'force-dynamic';

function smartDate(d: Date | null | undefined): string {
  if (!d) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400e3);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Server-action wrappers — bound status transitions as Promise<void> for the
// <form action={...}> contract.
async function acceptAction(formData: FormData): Promise<void> {
  'use server';
  await setSellStatus(String(formData.get('id') ?? ''), 'ACCEPTED');
}
async function declineAction(formData: FormData): Promise<void> {
  'use server';
  await setSellStatus(String(formData.get('id') ?? ''), 'DECLINED');
}
async function respondedAction(formData: FormData): Promise<void> {
  'use server';
  await setSellStatus(String(formData.get('id') ?? ''), 'RESPONDED');
}
async function closeAction(formData: FormData): Promise<void> {
  'use server';
  await setSellStatus(String(formData.get('id') ?? ''), 'CLOSED');
}

export default async function AdminSellDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  await requireCapability('sell:view');
  await getServerSession();

  const sub = await prisma.sellSubmission.findUnique({
    where: { id: params.id },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
      submittedBy: { select: { id: true, name: true, email: true, createdAt: true } },
    },
  });
  if (!sub) notFound();

  const lastReplyByStaff = [...sub.messages].reverse().find(() => true)?.fromStaff ?? false;
  const deal = computeSellState({
    status: sub.status,
    lastReplyByStaff,
    messageCount: sub.messages.length,
  });
  const tone = sellToneClasses(deal.tone);

  // Past submissions from the same seller — quick relationship signal so the
  // operator sees if they're a repeat seller before negotiating.
  const sellerHistory = sub.submittedBy?.id
    ? await prisma.sellSubmission.count({
        where: { submittedById: sub.submittedBy.id, id: { not: sub.id } },
      })
    : await prisma.sellSubmission.count({
        where: { email: sub.email, id: { not: sub.id } },
      });

  const ref = `SS-${sub.id.slice(-6).toUpperCase()}`;
  // canAct gates the REPLY composer + the PRICE composer. We want admin to
  // be able to keep chatting throughout the lifecycle (e.g. answering
  // shipping logistics questions). Only fully-terminal states hide the
  // composer: declined/closed, OR completed acquisition.
  const isTerminal =
    sub.status === 'DECLINED' ||
    sub.status === 'CLOSED' ||
    sub.acquisitionStage === 'COMPLETED';
  const canAct = !isTerminal;

  return (
    <div className="space-y-4">
      <AutoRefresh />
      <Link
        href="/admin/sell"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back to acquisitions
      </Link>
      {/* HERO ========================================================== */}
      <section className={`rounded-2xl border-2 bg-card overflow-hidden ${tone.ring} ring-1 ring-inset`}>
        <div className="p-6 grid lg:grid-cols-[1fr_auto] gap-6 items-start">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="font-mono text-[11px] text-muted-foreground">{ref}</span>
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${tone.pill}`}>
                {deal.label}
              </span>
              {sub.sellerType === 'COMPANY' && (
                <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider rounded-full bg-violet-50 text-violet-800 border border-violet-200 px-1.5 py-0.5">
                  <Building2 className="h-3 w-3" /> company
                </span>
              )}
              {sellerHistory > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 px-1.5 py-0.5">
                  repeat seller · {sellerHistory + 1}
                </span>
              )}
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{sub.itemTitle}</h1>
            <p className="text-sm text-muted-foreground mt-1.5 inline-flex items-center gap-1.5 flex-wrap">
              <span className="font-medium text-foreground">{sub.contactName}</span>
              <span>·</span>
              <EmailText email={sub.email} className="hover:text-foreground" asLink />
              {sub.companyName && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3" /> {sub.companyName}</span>
                </>
              )}
              {sub.location && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {sub.location}{sub.country && `, ${sub.country}`}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2 lg:min-w-[220px]">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Asking price</p>
            {sub.askingPrice ? (
              <p className="text-3xl font-bold tabular-nums tracking-tight leading-none inline-flex items-center gap-2">
                <Banknote className="h-6 w-6 text-emerald-600" />{sub.askingPrice}
              </p>
            ) : (
              <p className="text-xl text-muted-foreground italic">— not stated</p>
            )}
            <p className="text-[10px] text-muted-foreground">
              Submitted {smartDate(sub.createdAt)}
            </p>
          </div>
        </div>
      </section>
      <div className="grid xl:grid-cols-[1fr_320px] gap-4 items-start">
        {/* LEFT: item + photos + conversation + composer + actions */}
        <div className="space-y-4">
          {/* ITEM DETAILS */}
          <section className="rounded-2xl border border-border bg-card p-5">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-3 inline-flex items-center gap-1">
              <FileText className="h-3 w-3" /> Item details
            </p>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{sub.description}</p>
            <div className="mt-4 grid sm:grid-cols-3 gap-3 text-xs">
              {sub.brand && <Stat label="Brand" value={sub.brand} />}
              {sub.model && <Stat label="Model" value={sub.model} />}
              {sub.category && <Stat label="Category" value={sub.category} />}
              <Stat label="Condition" value={sub.condition.toLowerCase()} />
              <Stat label="Quantity" value={`×${sub.quantity}`} />
              {sub.yearMade && <Stat label="Year made" value={String(sub.yearMade)} />}
              {sub.accessories && <Stat label="Accessories" value={sub.accessories} />}
              {sub.reason && <Stat label="Reason for selling" value={sub.reason} />}
              {sub.availability && <Stat label="Availability" value={sub.availability} />}
            </div>
            {sub.photosUrl && (
              <p className="mt-3 text-xs text-muted-foreground">
                External photos link:{' '}
                <a href={sub.photosUrl} target="_blank" rel="noreferrer" className="text-primary underline inline-flex items-center gap-1">
                  open <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            )}
          </section>

          {/* PHOTOS */}
          {sub.images.length > 0 && (
            <section className="rounded-2xl border border-border bg-card p-5">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-3 inline-flex items-center gap-1">
                <ImageIcon className="h-3 w-3" /> Photos · {sub.images.length}
              </p>
              <div className="flex gap-2 flex-wrap">
                {sub.images.map((src) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  (<a key={src} href={src} target="_blank" rel="noreferrer">
                    <img src={src} alt="" className="h-24 w-24 rounded-lg object-cover border border-border hover:opacity-80 transition" />
                  </a>)
                ))}
              </div>
            </section>
          )}

          {/* CONVERSATION */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
              <MessageSquare className="h-3.5 w-3.5 text-primary" />
              <h2 className="text-xs font-bold uppercase tracking-wider">Conversation</h2>
              <span className="text-xs text-muted-foreground">
                {sub.messages.length === 0 ? 'no replies yet' : `${sub.messages.length} message${sub.messages.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="p-5 space-y-3 max-h-[640px] overflow-y-auto bg-foreground/[0.02]">
              {sub.messages.length === 0 ? (
                <div className="text-center py-8">
                  <Inbox className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No replies yet. Use the composer below to ask the seller a question or send a valuation.
                  </p>
                </div>
              ) : (
                sub.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex gap-2.5 ${m.fromStaff ? 'flex-row-reverse' : ''}`}
                  >
                    <div className={`h-8 w-8 rounded-full inline-flex items-center justify-center text-[11px] font-bold flex-shrink-0 shadow-sm ${m.fromStaff ? 'bg-primary text-primary-foreground' : 'bg-slate-100 text-slate-700 border border-slate-200'}`}>
                      {m.fromStaff ? <ShieldCheck className="h-3.5 w-3.5" /> : (sub.contactName.charAt(0).toUpperCase() || '?')}
                    </div>
                    <div className={`flex flex-col gap-1 max-w-[80%] ${m.fromStaff ? 'items-end' : 'items-start'}`}>
                      <div className={`text-[11px] font-semibold inline-flex items-center gap-2 ${m.fromStaff ? 'flex-row-reverse' : ''}`}>
                        <span>{m.fromStaff ? 'Acquisitions' : sub.contactName}</span>
                        <span className="text-muted-foreground font-normal">
                          {new Date(m.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                        m.fromStaff
                          ? 'bg-primary text-primary-foreground rounded-tr-sm'
                          : 'bg-card border border-border rounded-tl-sm'
                      }`}>
                        {m.body}
                        <MessageAttachments urls={m.attachments} />
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* PRICE PROPOSAL COMPOSER — only while we're still negotiating
              (no agreedPriceCents yet and no acquisitionStage). Lets admin
              shoot a counter offer with one field; renders as a typed
              message on the seller side they can accept or counter back. */}
          {canAct && !sub.acquisitionStage && sub.agreedPriceCents == null && (
            <section className="rounded-2xl border-2 border-accent/40 bg-accent/[0.06] p-5">
              <p className="text-xs font-bold uppercase tracking-wider mb-3 inline-flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-accent" /> Send a price offer
              </p>
              <form action={proposeAcquisitionPrice} className="space-y-3">
                <input type="hidden" name="submissionId" value={sub.id} />
                <div className="grid sm:grid-cols-[1fr_140px_140px] gap-3">
                  <label className="block">
                    <span className="block text-xs font-semibold mb-1">Amount</span>
                    <input type="number" name="amount" min="1" step="0.01" required placeholder={sub.askingPrice ? `seller asked ${sub.askingPrice}` : '0.00'} className="h-10 w-full px-3 rounded-lg border border-input bg-background text-sm font-mono" />
                  </label>
                  <label className="block">
                    <span className="block text-xs font-semibold mb-1">Currency</span>
                    <select name="currency" defaultValue="EUR" className="h-10 w-full px-3 rounded-lg border border-input bg-background text-sm">
                      {['EUR','USD','GBP','CHF'].map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                  <div className="flex items-end">
                    <Button type="submit" className="w-full rounded-full font-semibold bg-accent text-accent-foreground hover:bg-accent/90">
                      Send offer
                    </Button>
                  </div>
                </div>
                <label className="block">
                  <span className="block text-xs font-semibold mb-1">Note (optional)</span>
                  <textarea name="note" rows={2} maxLength={500} placeholder="Pricing rationale, conditions of offer (subject to inspection, etc.)…" className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm resize-y" />
                </label>
              </form>
              <p className="text-[11px] text-muted-foreground mt-2">
                Seller sees this as a typed offer card in the conversation. They click <strong>Accept</strong> to advance into the bank-details stage; or send a counter via the regular reply.
              </p>
            </section>
          )}

          {/* ACQUISITION-STAGE PANEL — drives the post-accept actions
              (mark received, complete + upload payment receipt). */}
          {sub.acquisitionStage && (
            <section className="rounded-2xl border-2 border-primary/40 bg-card p-5 space-y-4">
              <p className="text-xs font-bold uppercase tracking-wider inline-flex items-center gap-1.5">
                <Package className="h-3.5 w-3.5 text-primary" /> Acquisition lifecycle · stage: {sub.acquisitionStage.replace(/_/g, ' ').toLowerCase()}
              </p>

              {sub.acquisitionStage === 'AWAITING_BANK' && (
                <p className="text-sm text-muted-foreground">Waiting for seller to submit bank-payout details.</p>
              )}
              {sub.acquisitionStage === 'AWAITING_SHIPPING' && (
                <p className="text-sm text-muted-foreground">Bank details received. Waiting for seller to ship + enter tracking.</p>
              )}
              {sub.acquisitionStage === 'IN_TRANSIT' && (
                <>
                  <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm inline-flex items-center gap-2">
                    <Truck className="h-4 w-4 text-sky-700" />
                    <strong>{sub.sellerShippingCarrier}</strong>
                    <span className="font-mono">{sub.sellerShippingTracking}</span>
                    {sub.sellerShippedAt && <span className="text-xs text-muted-foreground">· shipped {smartDate(sub.sellerShippedAt)}</span>}
                  </div>
                  <form action={markAcquisitionReceived}>
                    <input type="hidden" name="submissionId" value={sub.id} />
                    <Button type="submit" className="rounded-full font-semibold bg-amber-600 hover:bg-amber-700 text-white">
                      <ShieldCheck className="h-4 w-4" /> Mark package received
                    </Button>
                  </form>
                </>
              )}
              {sub.acquisitionStage === 'RECEIVED' && (
                <>
                  <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
                    Package received {smartDate(sub.receivedAt)}. Run QC, then complete with payment receipt below.
                  </div>
                  <form action={uploadReceiptAndComplete} encType="multipart/form-data" className="space-y-3 pt-2">
                    <input type="hidden" name="submissionId" value={sub.id} />
                    <label className="block">
                      <span className="block text-xs font-semibold mb-1">Payment-transfer receipt (JPG / PNG / PDF, max 8 MB)</span>
                      <input type="file" name="receipt" accept="image/jpeg,image/png,image/webp,application/pdf" required className="text-sm" />
                    </label>
                    <Button type="submit" className="rounded-full font-semibold bg-emerald-600 hover:bg-emerald-700 text-white">
                      <CheckCheck className="h-4 w-4" /> Complete acquisition + send receipt
                    </Button>
                  </form>
                </>
              )}
              {sub.acquisitionStage === 'COMPLETED' && (
                <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 space-y-2">
                  <p>
                    <CheckCheck className="h-4 w-4 inline mr-1" />
                    Completed {smartDate(sub.completedAt)}. Payment of{' '}
                    <strong>{((sub.agreedPriceCents ?? 0) / 100).toLocaleString()} {sub.agreedCurrency ?? 'EUR'}</strong> wired.
                  </p>
                  {sub.paymentReceiptUrl && (() => {
                    const m = sub.paymentReceiptUrl.match(/order-proofs\/[^?#]+/);
                    const proxyUrl = m ? `/api/order-proof/${m[0]}` : null;
                    return proxyUrl ? (
                      <a href={proxyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-emerald-800 font-semibold underline">
                        <FileText className="h-3.5 w-3.5" /> Open the receipt we sent
                      </a>
                    ) : null;
                  })()}
                </div>
              )}
            </section>
          )}

          {/* COMPOSER */}
          {canAct && (
            <section className="rounded-2xl border-2 border-primary/40 bg-card p-5">
              <p className="text-xs font-bold mb-3 inline-flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5 text-primary" /> Reply to {sub.contactName}
              </p>
              <ReplyForm
                action={replySellSubmission}
                hidden={{ submissionId: sub.id }}
                placeholder={`Ask a question, send a valuation, request more photos…`}
                label="Send reply"
              />
              <p className="text-[11px] text-muted-foreground mt-2">
                Reply triggers an in-app notification immediately; email is throttled — only the first reply within EMAIL_THROTTLE_HOURS (Settings) is emailed.
              </p>
            </section>
          )}

          {/* ACTION BAR — only shown pre-acceptance and pre-terminal. Once we
              accept (and the lifecycle is in flight) or the deal is closed,
              the in-flight controls live in the Acquisition lifecycle panel
              above. A "Decline" here after the seller has paid+shipped
              would be nonsensical. */}
          {sub.status !== 'ACCEPTED' && sub.status !== 'DECLINED' && sub.status !== 'CLOSED' && !sub.acquisitionStage && (
            <section className="rounded-2xl border border-border bg-card p-5">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-3">Decision</p>
              <div className="flex gap-2 flex-wrap">
                <form action={acceptAction}>
                  <input type="hidden" name="id" value={sub.id} />
                  <Button type="submit" className="rounded-full font-semibold bg-emerald-600 hover:bg-emerald-700 text-white">
                    <Check className="h-4 w-4" /> Accept submission (skip negotiation)
                  </Button>
                </form>
                <form action={declineAction}>
                  <input type="hidden" name="id" value={sub.id} />
                  <Button type="submit" variant="outline" className="rounded-full font-semibold border-red-300 text-red-700 hover:bg-red-50">
                    <X className="h-4 w-4" /> Decline
                  </Button>
                </form>
                <form action={closeAction}>
                  <input type="hidden" name="id" value={sub.id} />
                  <Button type="submit" variant="ghost" className="rounded-full font-medium text-muted-foreground">
                    Close without deal
                  </Button>
                </form>
              </div>
              <p className="text-[11px] text-muted-foreground mt-3">
                Decline notifies the seller; close archives without notification. Use these only when there's no path to a deal — for normal flow, send a price offer above.
              </p>
            </section>
          )}

          {/* Closed-state explainer (DECLINED or CLOSED before lifecycle started) */}
          {(sub.status === 'DECLINED' || sub.status === 'CLOSED') && !sub.acquisitionStage && (
            <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 flex items-start gap-3">
              <X className="h-4 w-4 mt-0.5" />
              <p>
                {sub.status === 'DECLINED'
                  ? 'Declined. Seller was notified.'
                  : 'Closed without a deal.'}
              </p>
            </section>
          )}
        </div>

        {/* SIDEBAR: seller intel + meta + raw IDs */}
        <aside className="space-y-3 xl:sticky xl:top-20 xl:self-start">
          <SidebarCard title="Seller" icon={<Building2 className="h-3.5 w-3.5 text-primary" />}>
            <div className="space-y-2 text-sm">
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Contact</p>
                <p className="font-semibold">{sub.contactName}</p>
              </div>
              <div className="space-y-1 text-xs">
                <p className="inline-flex items-center gap-1.5"><Mail className="h-3 w-3 text-muted-foreground" /> {sub.email}</p>
                {sub.phone && <p className="inline-flex items-center gap-1.5"><Phone className="h-3 w-3 text-muted-foreground" /> {sub.phone}</p>}
                {sub.companyName && <p className="inline-flex items-center gap-1.5"><Building2 className="h-3 w-3 text-muted-foreground" /> {sub.companyName}</p>}
                {sub.country && <p className="inline-flex items-center gap-1.5"><MapPin className="h-3 w-3 text-muted-foreground" /> {sub.country}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 border-t text-xs">
                <div>
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Type</p>
                  <p className="font-semibold">{sub.sellerType.toLowerCase()}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">History</p>
                  <p className="font-semibold">{sellerHistory > 0 ? `${sellerHistory + 1} subs` : 'first time'}</p>
                </div>
              </div>
            </div>
          </SidebarCard>

          <SidebarCard title="Timeline" icon={<Hourglass className="h-3.5 w-3.5 text-primary" />}>
            <ul className="text-xs space-y-1.5">
              <li><strong>Submitted</strong> · {smartDate(sub.createdAt)}</li>
              {sub.messages.length > 0 && (
                <li><strong>Last activity</strong> · {smartDate(sub.updatedAt)}</li>
              )}
              <li><strong>Messages</strong> · {sub.messages.length}</li>
            </ul>
          </SidebarCard>

          {/* BANK DETAILS — visible once seller submits them */}
          {(() => {
            const b = sub.sellerBankDetails as Record<string, string> | null;
            if (!b || !b.iban) return null;
            return (
              <SidebarCard title="Seller payout bank" icon={<Banknote className="h-3.5 w-3.5 text-primary" />}>
                <ul className="text-xs space-y-1.5 break-all">
                  <li><span className="text-muted-foreground">Holder · </span><strong>{b.holder}</strong></li>
                  {b.bankName && <li><span className="text-muted-foreground">Bank · </span>{b.bankName}</li>}
                  <li><span className="text-muted-foreground">IBAN · </span><strong className="font-mono">{b.iban}</strong></li>
                  {b.swift && <li><span className="text-muted-foreground">SWIFT · </span><span className="font-mono">{b.swift}</span></li>}
                  {b.country && <li><span className="text-muted-foreground">Country · </span>{b.country}</li>}
                  {b.notes && <li className="pt-1.5 border-t mt-1.5 text-muted-foreground italic">{b.notes}</li>}
                </ul>
              </SidebarCard>
            );
          })()}

          {/* SHIPPING TRACKING */}
          {sub.sellerShippingTracking && (
            <SidebarCard title="Seller shipment" icon={<Truck className="h-3.5 w-3.5 text-primary" />}>
              <ul className="text-xs space-y-1.5">
                <li><span className="text-muted-foreground">Carrier · </span><strong>{sub.sellerShippingCarrier}</strong></li>
                <li><span className="text-muted-foreground">Tracking · </span><span className="font-mono break-all">{sub.sellerShippingTracking}</span></li>
                {sub.sellerShippedAt && <li><span className="text-muted-foreground">Shipped · </span>{smartDate(sub.sellerShippedAt)}</li>}
                {sub.receivedAt && <li><span className="text-muted-foreground">Received · </span><strong>{smartDate(sub.receivedAt)}</strong></li>}
              </ul>
            </SidebarCard>
          )}

          <SidebarCard title="Item snapshot" icon={<Package className="h-3.5 w-3.5 text-primary" />}>
            <ul className="text-xs space-y-1.5">
              {sub.brand && <li><span className="text-muted-foreground">Brand · </span><strong>{sub.brand}</strong></li>}
              {sub.model && <li><span className="text-muted-foreground">Model · </span><strong>{sub.model}</strong></li>}
              <li><span className="text-muted-foreground">Condition · </span><strong>{sub.condition.toLowerCase()}</strong></li>
              <li><span className="text-muted-foreground">Qty · </span><strong>×{sub.quantity}</strong></li>
              {sub.askingPrice && <li><span className="text-muted-foreground">Asking · </span><strong>{sub.askingPrice}</strong></li>}
              {sub.location && <li><span className="text-muted-foreground">Where · </span><strong>{sub.location}</strong></li>}
            </ul>
          </SidebarCard>

          <p className="text-[10px] font-mono text-muted-foreground px-3">id: {sub.id}</p>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
      <p className="font-semibold mt-0.5 break-words">{value}</p>
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
