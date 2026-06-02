import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronRight, ShieldCheck, FileText, MessageCircle, Banknote, Truck,
  Package, CheckCheck, Send, Inbox, MapPin, Clock, XCircle, Sparkles,
  Building2, Hash, Image as ImageIcon, ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import {
  replyToSellSubmission,
  acceptAcquisitionPrice,
  saveAcquisitionBankDetails,
  saveAcquisitionShipping,
} from '@/lib/sell/actions';
import { ensureSettingsLoaded } from '@/lib/settings';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { ReplyForm } from '@/components/util/ReplyForm';
import { MessageAttachments } from '@/components/util/MessageAttachments';

export const dynamic = 'force-dynamic';

function fmtMoney(cents: number | null, ccy = 'EUR'): string {
  if (cents == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(cents / 100);
}
function smartDate(d: Date | null | undefined): string {
  if (!d) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400e3);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

/**
 * The full lifecycle for the buyer-facing timeline. We render every stage
 * regardless of where we are so the seller sees the WHOLE journey, with the
 * current step highlighted and past steps checked. Mirrors the order-fulfillment
 * stepper pattern used by /app/orders.
 */
const LIFECYCLE = [
  { key: 'submitted',  label: 'Submitted',          Icon: FileText,    description: 'You sent us this equipment offer.' },
  { key: 'review',     label: 'Under review',       Icon: MessageCircle, description: 'Our acquisitions team is evaluating and asking questions.' },
  { key: 'price',      label: 'Price agreed',       Icon: Sparkles,    description: 'We agreed on a payout price.' },
  { key: 'bank',       label: 'Bank details',       Icon: Banknote,    description: 'You provide where we should wire the payment.' },
  { key: 'shipping',   label: 'Ship to us',         Icon: Truck,       description: 'Ship the device using the carrier of your choice.' },
  { key: 'transit',    label: 'In transit',         Icon: Package,     description: 'Tracking is live; we wait for the package.' },
  { key: 'received',   label: 'Received · inspecting', Icon: ShieldCheck, description: 'We received it and are doing QC.' },
  { key: 'completed',  label: 'Completed · paid',   Icon: CheckCheck,  description: 'Payment wired; transfer receipt attached.' },
] as const;
type LifecycleKey = (typeof LIFECYCLE)[number]['key'];

function lifecycleIndex(sub: {
  status: string;
  acquisitionStage: string | null;
  agreedPriceCents: number | null;
}): { current: number; lost: boolean } {
  if (sub.status === 'DECLINED' || sub.status === 'CLOSED') {
    return { current: 1, lost: true };
  }
  if (sub.status === 'ACCEPTED' || sub.acquisitionStage) {
    if (sub.acquisitionStage === 'COMPLETED')        return { current: 7, lost: false };
    if (sub.acquisitionStage === 'RECEIVED')         return { current: 6, lost: false };
    if (sub.acquisitionStage === 'IN_TRANSIT')       return { current: 5, lost: false };
    if (sub.acquisitionStage === 'AWAITING_SHIPPING') return { current: 4, lost: false };
    if (sub.acquisitionStage === 'AWAITING_BANK')    return { current: 3, lost: false };
    // ACCEPTED but no stage yet → treat as just-agreed
    return { current: 2, lost: false };
  }
  if (sub.status === 'RESPONDED' && sub.agreedPriceCents != null) {
    // counter-offer agreed but seller hasn't clicked Accept yet
    return { current: 2, lost: false };
  }
  if (sub.status === 'RESPONDED') return { current: 1, lost: false };
  return { current: 0, lost: false };
}

export default async function SellSubmissionDetailPage({ params }: { params: { id: string } }) {
  const session = await requireSession({ redirectTo: `/app/sell-submissions/${params.id}` });
  await ensureSettingsLoaded();

  const sub = await prisma.sellSubmission.findUnique({
    where: { id: params.id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!sub) notFound();
  const role = (session.user as { role?: string }).role;
  const owns =
    sub.submittedById === session.user.id ||
    sub.email.toLowerCase() === session.user.email.toLowerCase();
  if (!owns && role !== 'ADMIN') notFound();

  // Saved bank details on profile — auto-fill on the bank form
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { sellerBankDetails: true },
  });
  const savedBank = (me?.sellerBankDetails as Record<string, string> | null) ?? null;

  // Latest open price proposal (admin → seller, with no acceptance yet)
  const latestProposal = sub.messages
    .filter((m) => m.kind === 'PRICE_PROPOSAL')
    .slice(-1)[0];

  const { current, lost } = lifecycleIndex(sub);
  const ref = `SS-${sub.id.slice(-6).toUpperCase()}`;

  // Company receiving address from settings (shown to seller during AWAITING_SHIPPING)
  const receivingAddress = (process.env.COMPANY_RECEIVING_ADDRESS || '').trim();

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
        <Link href="/app/sell-submissions" className="hover:text-foreground">My equipment offers</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground font-mono">{ref}</span>
      </nav>

      {/* ── HERO ────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border-2 border-primary/30 bg-gradient-to-br from-primary/[0.04] to-accent/[0.05] p-6">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{ref}</p>
            <h1 className="text-2xl font-bold tracking-tight mt-1">{sub.itemTitle}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Submitted {smartDate(sub.createdAt)}
              {[sub.brand, sub.model].filter(Boolean).length > 0 && (
                <> · <strong className="text-foreground">{[sub.brand, sub.model].filter(Boolean).join(' ')}</strong></>
              )}
              {sub.condition && <> · {sub.condition.toLowerCase()}</>}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              {sub.agreedPriceCents ? 'Agreed payout' : 'Your asking price'}
            </p>
            <p className="text-3xl font-bold tabular-nums tracking-tight inline-flex items-center gap-2">
              {sub.agreedPriceCents != null ? (
                <><Banknote className="h-6 w-6 text-emerald-600" />{fmtMoney(sub.agreedPriceCents, sub.agreedCurrency ?? 'EUR')}</>
              ) : sub.askingPrice ? (
                <>{sub.askingPrice}</>
              ) : (
                <span className="text-xl text-muted-foreground italic">— awaiting</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* ── TIMELINE ─────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-card p-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground mb-5">Lifecycle</p>
        {lost ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-3">
            <XCircle className="h-5 w-5 text-red-700 mt-0.5" />
            <div>
              <p className="font-bold text-red-900">{sub.status === 'DECLINED' ? 'Declined' : 'Closed'}</p>
              <p className="text-sm text-red-800 mt-1">
                {sub.status === 'DECLINED'
                  ? 'We weren\'t able to acquire this equipment. Thanks for the offer.'
                  : 'This offer was closed without a deal.'}
              </p>
            </div>
          </div>
        ) : (
          <ol className="space-y-3">
            {LIFECYCLE.map((step, i) => {
              const done = i < current;
              const isCurrent = i === current;
              const Icon = step.Icon;
              return (
                <li key={step.key} className={`flex items-start gap-4 ${isCurrent ? '' : done ? '' : 'opacity-60'}`}>
                  <div
                    className={`flex-shrink-0 h-9 w-9 rounded-full inline-flex items-center justify-center border-2 ${
                      done
                        ? 'bg-emerald-500 border-emerald-500 text-white'
                        : isCurrent
                        ? 'bg-primary border-primary text-primary-foreground shadow-md'
                        : 'bg-card border-border text-muted-foreground'
                    }`}
                  >
                    {done ? <CheckCheck className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 min-w-0 pt-1">
                    <p className={`text-sm font-bold ${isCurrent ? 'text-primary' : done ? 'text-emerald-700' : 'text-foreground'}`}>
                      {step.label}
                      {isCurrent && <span className="ml-2 text-[10px] uppercase tracking-wider font-bold bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full">current</span>}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ── STAGE-SPECIFIC ACTION CARD ──────────────────────────────── */}
      <StageCard
        sub={sub}
        savedBank={savedBank}
        receivingAddress={receivingAddress}
        latestProposalCents={latestProposal?.priceCents ?? null}
        latestProposalCurrency={latestProposal?.currency ?? null}
      />

      {/* ── EQUIPMENT DETAILS ──────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-card p-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground mb-3 inline-flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" /> Equipment details
        </p>
        <dl className="grid sm:grid-cols-2 gap-x-10 gap-y-2 text-sm">
          {[
            ['Brand / model', [sub.brand, sub.model].filter(Boolean).join(' ') || null],
            ['Category', sub.category],
            ['Condition', sub.condition.toLowerCase()],
            ['Quantity', `×${sub.quantity}`],
            ['Year made', sub.yearMade ? String(sub.yearMade) : null],
            ['Location', sub.location],
            ['Availability', sub.availability],
          ].filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-border/60 py-1.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-medium text-right">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Description</p>
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{sub.description}</p>
        </div>
        {sub.images.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 inline-flex items-center gap-1">
              <ImageIcon className="h-3 w-3" /> Photos · {sub.images.length}
            </p>
            <div className="flex gap-2 flex-wrap">
              {sub.images.map((src) => (
                // eslint-disable-next-line @next/next/no-img-element
                <a key={src} href={src} target="_blank" rel="noreferrer">
                  <img src={src} alt="" className="h-24 w-24 rounded-lg object-cover border border-border hover:opacity-80 transition" />
                </a>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── CONVERSATION ────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
          <MessageCircle className="h-3.5 w-3.5 text-primary" />
          <h2 className="text-xs font-bold uppercase tracking-wider">Conversation with acquisitions</h2>
          <span className="text-xs text-muted-foreground">
            {sub.messages.length === 0 ? 'no replies yet' : `${sub.messages.length} message${sub.messages.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <div className="p-5 space-y-4 bg-foreground/[0.02] max-h-[600px] overflow-y-auto">
          {sub.messages.length === 0 ? (
            <div className="text-center py-8">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-3">
                <MessageCircle className="h-6 w-6" />
              </div>
              <p className="text-sm font-bold">Conversation will start here</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
                Our acquisitions team typically replies within 2 business days with questions and a valuation.
              </p>
            </div>
          ) : (
            sub.messages.map((m) => <Bubble key={m.id} m={m} sellerName={sub.contactName} />)
          )}
        </div>

        {/* Reply box — hidden when terminal. */}
        {sub.status !== 'DECLINED' && sub.status !== 'CLOSED' && sub.acquisitionStage !== 'COMPLETED' && (
          <div className="px-5 py-4 border-t border-border">
            <ReplyForm
              action={replyToSellSubmission}
              hidden={{ submissionId: sub.id }}
              placeholder="Answer a question or add details…"
            />
          </div>
        )}
      </section>
    </div>
  );
}

/* ─────────────────────────── HELPER COMPONENTS ─────────────────────── */

function Bubble({ m, sellerName }: { m: { id: string; body: string; createdAt: Date; fromStaff: boolean; attachments: string[]; kind: string; priceCents: number | null; currency: string | null }; sellerName: string }) {
  // SYSTEM messages render as a centered slate divider — they're audit
  // events, not chat content (e.g. "Seller accepted 28,000 EUR. Next: bank details.").
  if (m.kind === 'SYSTEM') {
    return (
      <div className="flex items-center gap-3 my-2">
        <div className="flex-1 h-px bg-border" />
        <p className="text-[11px] text-muted-foreground font-medium">{m.body}</p>
        <div className="flex-1 h-px bg-border" />
      </div>
    );
  }
  // PRICE_PROPOSAL renders as a callout card with the amount big.
  if (m.kind === 'PRICE_PROPOSAL') {
    return (
      <div className="rounded-2xl border-2 border-accent/40 bg-accent/[0.08] p-4 mx-auto max-w-[88%] shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="h-4 w-4 text-accent" />
          <p className="text-[10px] font-bold uppercase tracking-wider text-accent">
            Price offer from acquisitions · {new Date(m.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
        <p className="text-2xl font-bold tabular-nums mb-2 inline-flex items-center gap-2">
          <Banknote className="h-5 w-5 text-emerald-600" />
          {m.priceCents != null ? new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency ?? 'EUR', maximumFractionDigits: 0 }).format(m.priceCents / 100) : '—'}
        </p>
        {m.body && <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.body}</p>}
      </div>
    );
  }
  // Default text message — bubbles like the quote thread.
  const palette = m.fromStaff
    ? 'bg-emerald-50 border border-emerald-200 text-emerald-950 rounded-tl-sm'
    : 'bg-primary text-primary-foreground rounded-tr-sm';
  return (
    <div className={`flex gap-2.5 ${m.fromStaff ? '' : 'flex-row-reverse'}`}>
      <div className={`h-8 w-8 rounded-full inline-flex items-center justify-center text-[11px] font-bold flex-shrink-0 shadow-sm ${
        m.fromStaff
          ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
          : 'bg-primary text-primary-foreground'
      }`}>
        {m.fromStaff ? <ShieldCheck className="h-3.5 w-3.5" /> : initials(sellerName)}
      </div>
      <div className={`flex flex-col gap-1 max-w-[80%] ${m.fromStaff ? 'items-start' : 'items-end'}`}>
        <div className={`text-[11px] font-semibold inline-flex items-center gap-2 ${m.fromStaff ? '' : 'flex-row-reverse'}`}>
          <span>{m.fromStaff ? 'lab2date Acquisitions' : 'You'}</span>
          <span className="text-muted-foreground font-normal">
            {new Date(m.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${palette}`}>
          {m.body}
          <MessageAttachments urls={m.attachments} />
        </div>
      </div>
    </div>
  );
}

/**
 * Stage-specific action card. Renders ONE prominent panel depending on the
 * acquisitionStage so the seller always knows "what's next for me to do".
 */
function StageCard({
  sub,
  savedBank,
  receivingAddress,
  latestProposalCents,
  latestProposalCurrency,
}: {
  sub: any;
  savedBank: Record<string, string> | null;
  receivingAddress: string;
  latestProposalCents: number | null;
  latestProposalCurrency: string | null;
}) {
  // OPEN PRICE PROPOSAL — seller can click Accept (creates submission stage)
  if (sub.status === 'RESPONDED' && latestProposalCents && !sub.acquisitionStage) {
    return (
      <section className="rounded-2xl border-2 border-accent/40 bg-accent/[0.06] p-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-accent mb-3">Decide on this price</p>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-3xl font-bold tabular-nums inline-flex items-center gap-2">
              <Banknote className="h-6 w-6 text-emerald-600" />
              {new Intl.NumberFormat('en-US', { style: 'currency', currency: latestProposalCurrency ?? 'EUR', maximumFractionDigits: 0 }).format(latestProposalCents / 100)}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Accept to move forward, or counter via the reply box below.
            </p>
          </div>
          <form action={acceptAcquisitionPrice}>
            <input type="hidden" name="submissionId" value={sub.id} />
            <Button type="submit" size="lg" className="rounded-full font-semibold bg-emerald-600 hover:bg-emerald-700 text-white">
              <CheckCheck className="h-4 w-4" /> Accept this price
            </Button>
          </form>
        </div>
      </section>
    );
  }

  // AWAITING BANK DETAILS — seller fills payout details
  if (sub.acquisitionStage === 'AWAITING_BANK') {
    return (
      <section className="rounded-2xl border-2 border-primary/40 bg-card p-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-3 inline-flex items-center gap-1.5">
          <Banknote className="h-3.5 w-3.5" /> Bank details for your payout
        </p>
        <p className="text-sm text-muted-foreground mb-4">
          Where should we wire the <strong className="text-foreground">{new Intl.NumberFormat('en-US', { style: 'currency', currency: sub.agreedCurrency ?? 'EUR', maximumFractionDigits: 0 }).format((sub.agreedPriceCents ?? 0) / 100)}</strong>? We don't store this on file unless you let us — but if it's saved, future offers auto-fill.
        </p>
        <form action={saveAcquisitionBankDetails} className="space-y-3">
          <input type="hidden" name="submissionId" value={sub.id} />
          <div className="grid sm:grid-cols-2 gap-3">
            <BankField name="holder" label="Account holder (legal name)" defaultValue={savedBank?.holder} required />
            <BankField name="bankName" label="Bank name" defaultValue={savedBank?.bankName} />
          </div>
          <BankField name="iban" label="IBAN / account number" defaultValue={savedBank?.iban} required mono />
          <div className="grid sm:grid-cols-2 gap-3">
            <BankField name="swift" label="SWIFT / BIC (international)" defaultValue={savedBank?.swift} mono />
            <BankField name="country" label="Bank country" defaultValue={savedBank?.country} />
          </div>
          <label className="block">
            <span className="block text-xs font-semibold mb-1">Notes (optional)</span>
            <textarea name="notes" rows={2} defaultValue={savedBank?.notes ?? ''} className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm" />
          </label>
          <Button type="submit" size="lg" className="rounded-full font-semibold">
            Save & continue to shipping <Truck className="h-4 w-4" />
          </Button>
        </form>
      </section>
    );
  }

  // AWAITING SHIPPING — seller sees our address + enters tracking
  if (sub.acquisitionStage === 'AWAITING_SHIPPING') {
    return (
      <section className="rounded-2xl border-2 border-primary/40 bg-card p-6 space-y-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-3 inline-flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" /> Ship to this address
          </p>
          {receivingAddress ? (
            <div className="rounded-xl border border-border bg-foreground/[0.03] p-4">
              <pre className="text-sm font-mono whitespace-pre-wrap leading-relaxed">{receivingAddress}</pre>
            </div>
          ) : (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              Our receiving address isn't configured yet — please email{' '}
              <a href="mailto:acquisitions@lab2date.com" className="font-semibold underline">acquisitions@lab2date.com</a> for ship-to details.
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-2">
            Use any reputable carrier (DHL, UPS, FedEx, GLS…). Include the reference{' '}
            <strong className="text-foreground font-mono">SS-{sub.id.slice(-6).toUpperCase()}</strong>{' '}
            on the outside of the package so it reaches the right team.
          </p>
        </div>

        <form action={saveAcquisitionShipping} className="space-y-3">
          <input type="hidden" name="submissionId" value={sub.id} />
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground inline-flex items-center gap-1.5">
            <Truck className="h-3.5 w-3.5" /> Once shipped, enter tracking
          </p>
          <div className="grid sm:grid-cols-[1fr_2fr] gap-3">
            <label className="block">
              <span className="block text-xs font-semibold mb-1">Carrier</span>
              <select name="carrier" required className="h-10 w-full px-3 rounded-lg border border-input bg-background text-sm">
                <option value="">—</option>
                {['DHL','UPS','FedEx','TNT','GLS','DPD','USPS','Other'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-semibold mb-1">Tracking number</span>
              <input name="tracking" required placeholder="1Z…" className="h-10 w-full px-3 rounded-lg border border-input bg-background text-sm font-mono" />
            </label>
          </div>
          <Button type="submit" size="lg" className="rounded-full font-semibold">
            Save tracking <CheckCheck className="h-4 w-4" />
          </Button>
        </form>
      </section>
    );
  }

  // IN TRANSIT — show tracking back, no form, just waiting
  if (sub.acquisitionStage === 'IN_TRANSIT') {
    return (
      <section className="rounded-2xl border-2 border-sky-300 bg-sky-50/60 p-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-800 mb-2 inline-flex items-center gap-1.5">
          <Truck className="h-3.5 w-3.5" /> Package in transit
        </p>
        <p className="text-2xl font-bold inline-flex items-center gap-2 tabular-nums">
          {sub.sellerShippingCarrier} · <span className="font-mono">{sub.sellerShippingTracking}</span>
        </p>
        <p className="text-sm text-sky-900 mt-2">
          We'll stamp <strong>Received · inspecting</strong> the moment the package lands at our warehouse and email you a heads-up.
        </p>
      </section>
    );
  }

  // RECEIVED — under inspection
  if (sub.acquisitionStage === 'RECEIVED') {
    return (
      <section className="rounded-2xl border-2 border-amber-300 bg-amber-50/60 p-6 flex items-start gap-3">
        <ShieldCheck className="h-6 w-6 text-amber-700 mt-1" />
        <div>
          <p className="font-bold text-amber-900">We received your equipment</p>
          <p className="text-sm text-amber-900 mt-1">
            QC is in progress. As soon as it clears we wire payment to your bank details and attach the transfer receipt here.
          </p>
          <p className="text-xs text-amber-900 mt-2">Received {smartDate(sub.receivedAt)}.</p>
        </div>
      </section>
    );
  }

  // COMPLETED — payment receipt download
  if (sub.acquisitionStage === 'COMPLETED') {
    return (
      <section className="rounded-2xl border-2 border-emerald-300 bg-emerald-50/60 p-6">
        <div className="flex items-start gap-3 mb-3">
          <CheckCheck className="h-6 w-6 text-emerald-700 mt-1" />
          <div className="flex-1">
            <p className="font-bold text-emerald-900">Payment wired · acquisition complete</p>
            <p className="text-sm text-emerald-900 mt-1">
              <strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: sub.agreedCurrency ?? 'EUR', maximumFractionDigits: 0 }).format((sub.agreedPriceCents ?? 0) / 100)}</strong>{' '}
              transferred to your bank {smartDate(sub.completedAt)}. Receipt below.
            </p>
          </div>
        </div>
        {sub.paymentReceiptUrl && (() => {
          // Route through the auth-gated proxy — S3 bucket is private, so a
          // direct fetch of the raw URL would 403 the seller.
          const m = sub.paymentReceiptUrl.match(/order-proofs\/[^?#]+/);
          const proxyUrl = m ? `/api/order-proof/${m[0]}` : null;
          return proxyUrl ? (
            <a
              href={proxyUrl}
              target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-700 text-white px-4 py-2 text-sm font-semibold hover:bg-emerald-800"
            >
              <FileText className="h-4 w-4" /> Download payment receipt
              <ExternalLink className="h-3.5 w-3.5 opacity-70" />
            </a>
          ) : null;
        })()}
      </section>
    );
  }

  // PENDING — no special action yet, just waiting
  if (sub.status === 'PENDING') {
    return (
      <section className="rounded-2xl border border-border bg-card p-6 flex items-start gap-3">
        <Clock className="h-6 w-6 text-muted-foreground mt-1" />
        <div>
          <p className="font-bold">Awaiting acquisitions team review</p>
          <p className="text-sm text-muted-foreground mt-1">
            We typically reply within <strong>2 business days</strong> with questions and a valuation. You'll get an email + notification the moment we do.
          </p>
        </div>
      </section>
    );
  }

  // RESPONDED with no proposal yet — just chatting
  if (sub.status === 'RESPONDED' && !latestProposalCents) {
    return (
      <section className="rounded-2xl border border-sky-200 bg-sky-50/60 p-6 flex items-start gap-3">
        <MessageCircle className="h-6 w-6 text-sky-700 mt-1" />
        <div>
          <p className="font-bold text-sky-900">We're in conversation</p>
          <p className="text-sm text-sky-900 mt-1">
            Once our team has enough info, you'll see a price offer here and can accept or counter.
          </p>
        </div>
      </section>
    );
  }

  return null;
}

function BankField({
  name, label, defaultValue, required, mono,
}: { name: string; label: string; defaultValue?: string; required?: boolean; mono?: boolean }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold mb-1">{label}{required && <span className="text-red-600"> *</span>}</span>
      <input
        name={name}
        defaultValue={defaultValue ?? ''}
        required={required}
        className={`w-full h-10 px-3 rounded-lg border border-input bg-background text-sm ${mono ? 'font-mono tracking-wide' : ''}`}
      />
    </label>
  );
}
