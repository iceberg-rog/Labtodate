import { Tag, Banknote, Truck, ShieldCheck, Clock, Search, FileCheck2, Handshake } from 'lucide-react';
import { SellForm } from './SellForm';
import { getCatalogPolicy, getConditionGrades, type CatalogPolicy } from '@/lib/catalog/policy';

export const metadata = {
  title: 'Sell your lab equipment',
  description:
    'Sell surplus, refurbished or decommissioned laboratory and analytical equipment. Submit it and our acquisitions team comes back with a valuation.',
};
export const dynamic = 'force-dynamic';

/**
 * Every promise on this page follows the acquisition process the site really
 * runs (Settings → Acquisitions): who ships the unit, and when the seller is
 * paid. The defaults match the seller dashboard flow: we buy outright, the
 * seller ships to our warehouse, we pay after it arrives and passes our check.
 */
function sellCopy(p: CatalogPolicy) {
  const outright = p.sellAcquisitionModel === 'OUTRIGHT_PURCHASE';
  const weCollect = p.sellLogisticsMode === 'WE_ARRANGE_PICKUP';
  const turnaround = p.sellValuationTurnaround;
  return {
    stats: [
      { value: outright ? 'Offer' : '0%', label: outright ? 'A firm price for your unit' : 'Listing fees' },
      weCollect
        ? { value: 'Collected', label: 'We arrange the pickup' }
        : { value: 'You ship', label: 'To our warehouse, address on acceptance' },
      { value: 'One', label: 'Accountable counterparty' },
    ],
    bullets: [
      {
        icon: Banknote,
        title: outright ? 'A firm offer, no fees' : 'Valuation, no listing fees',
        body: outright
          ? 'We make you an offer for the unit based on what it can realistically sell for. No fees are deducted.'
          : 'We come back with a number based on what the unit can realistically sell for.',
      },
      weCollect
        ? { icon: Truck, title: 'We arrange collection', body: 'Crating, freight and insurance are arranged by us; the costs are agreed in the offer.' }
        : {
            icon: Truck,
            title: 'You ship it to us',
            body: 'Once you accept our offer, we send you our warehouse address. You ship the unit with a carrier of your choice and share the tracking number.',
          },
      outright
        ? { icon: ShieldCheck, title: 'Paid after our check', body: 'We pay by bank transfer once the unit has arrived and passed our check against your description.' }
        : { icon: ShieldCheck, title: 'Paid after the sale', body: 'You get paid once the buyer confirms the unit as described.' },
    ],
    steps: [
      { icon: FileCheck2, title: 'Submit your equipment', body: 'Tell us what you have — the form on the right takes a few minutes.' },
      {
        icon: Search,
        title: outright ? 'Our offer' : 'Free valuation',
        body: `Our acquisitions team replies${turnaround ? ` within ${turnaround}` : ''} with ${outright ? 'an offer' : 'a market-based valuation'}.`,
      },
      outright
        ? { icon: Handshake, title: 'Accept and share bank details', body: 'Accept the offer in your dashboard and tell us where to send the payment.' }
        : { icon: Handshake, title: 'We match a buyer', body: 'We route your item and negotiate on agreed terms.' },
      {
        icon: Clock,
        title: weCollect ? 'Collection & payment' : 'Ship & get paid',
        body: outright
          ? `${weCollect ? 'We collect the unit' : 'You ship the unit to our warehouse'}; we pay after it arrives and passes our check.`
          : `${weCollect ? 'We collect the unit' : 'You ship the unit'}; you get paid once the buyer confirms receipt.`,
      },
    ],
  };
}

export default async function SellPage() {
  const [policy, grades] = await Promise.all([getCatalogPolicy(), getConditionGrades()]);
  const copy = sellCopy(policy);
  return (
    <div>
      {/* Hero */}
      <section className="border-b border-foreground/5 bg-foreground/[0.02]">
        <div className="container-px py-14 md:py-20 max-w-6xl mx-auto">
          <div className="inline-flex items-center gap-2 rounded-full bg-accent/15 border border-accent/30 px-3 py-1 text-xs font-bold text-primary mb-5">
            <Tag className="h-3.5 w-3.5" />
            Sell to {policy.siteName}
          </div>
          <h1
            className="text-4xl md:text-5xl lg:text-6xl font-bold text-foreground leading-[1.05] max-w-3xl"
            style={{ letterSpacing: '-0.04em' }}
          >
            Turn idle instruments into{' '}
            <span className="text-primary">working capital.</span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground leading-relaxed max-w-2xl">
            Whether you&apos;re an individual, a lab, a dealer, or an institution clearing a facility —
            submit your equipment and our acquisitions team comes back with{' '}
            {policy.sellAcquisitionModel === 'OUTRIGHT_PURCHASE' ? 'an offer' : 'a valuation'}.
          </p>

          <div className="mt-10 grid grid-cols-2 lg:grid-cols-3 gap-px rounded-2xl overflow-hidden border border-border bg-border">
            {copy.stats.map((st) => (
              <Stat key={st.label} value={st.value} label={st.label} />
            ))}
          </div>
        </div>
      </section>

      {/* Value + Form */}
      <section className="container-px py-14 md:py-20">
        <div className="grid lg:grid-cols-[1fr_1.25fr] gap-12 items-start max-w-6xl mx-auto">
          <div className="space-y-10">
            <div>
              <h2 className="text-2xl font-bold tracking-tight" style={{ letterSpacing: '-0.03em' }}>
                Why sell through us
              </h2>
              <ul className="mt-6 space-y-5">
                {copy.bullets.map((b) => (
                  <Bullet key={b.title} icon={b.icon} title={b.title} body={b.body} />
                ))}
              </ul>
            </div>

            <div>
              <h2 className="text-2xl font-bold tracking-tight" style={{ letterSpacing: '-0.03em' }}>
                How it works
              </h2>
              <ol className="mt-6 space-y-5">
                {copy.steps.map((st, i) => (
                  <Step key={st.title} n={i + 1} icon={st.icon} title={st.title} body={st.body} />
                ))}
              </ol>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
              <p className="font-semibold text-foreground mb-1">No account needed</p>
              You can submit without signing in. We&apos;ll email you a reference and reply to the
              address you provide.
            </div>
          </div>

          <div>
            <SellForm
              turnaround={policy.sellValuationTurnaround}
              offerWord={policy.sellAcquisitionModel === 'OUTRIGHT_PURCHASE' ? 'offer' : 'valuation'}
              conditions={(['USED', 'REFURBISHED', 'NEW'] as const).map((c) => [c, grades[c].label])}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-card px-5 py-6">
      <p className="text-2xl md:text-3xl font-bold text-primary" style={{ letterSpacing: '-0.03em' }}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground mt-1 font-medium">{label}</p>
    </div>
  );
}

function Bullet({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-4">
      <div className="flex-shrink-0 h-10 w-10 rounded-xl bg-accent/15 text-primary flex items-center justify-center">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="font-bold">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </li>
  );
}

function Step({
  n,
  icon: Icon,
  title,
  body,
}: {
  n: number;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-4">
      <div className="flex-shrink-0 relative h-10 w-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold">
        {n}
        <Icon className="h-3.5 w-3.5 absolute -bottom-1 -right-1 bg-accent text-accent-foreground rounded-full p-0.5 box-content border-2 border-background" />
      </div>
      <div>
        <p className="font-bold">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </li>
  );
}
