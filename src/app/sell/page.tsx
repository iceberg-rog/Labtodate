import { Tag, Banknote, Truck, ShieldCheck, Clock, Search, FileCheck2, Handshake } from 'lucide-react';
import { SellForm } from './SellForm';
import { getMarketing } from '@/lib/marketing';

export const metadata = {
  title: 'Sell your lab equipment',
  description:
    'Sell surplus, refurbished or decommissioned laboratory and analytical equipment. We come back with a valuation; we handle shipping and payment.',
};
export const dynamic = 'force-dynamic';

export default async function SellPage() {
  const mk = await getMarketing();
  return (
    <div>
      {/* Hero */}
      <section className="border-b border-foreground/5 bg-foreground/[0.02]">
        <div className="container-px py-14 md:py-20 max-w-6xl mx-auto">
          <div className="inline-flex items-center gap-2 rounded-full bg-accent/15 border border-accent/30 px-3 py-1 text-xs font-bold text-primary mb-5">
            <Tag className="h-3.5 w-3.5" />
            Sell to lab2date
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
            submit your equipment and our acquisitions team comes back with a valuation. No listing
            fees, no guesswork.
          </p>

          <div className="mt-10 grid grid-cols-2 lg:grid-cols-3 gap-px rounded-2xl overflow-hidden border border-border bg-border">
            <Stat value="0%" label="Listing fees" />
            <Stat value="Global" label="Logistics handled for you" />
            <Stat value="One" label="Accountable counterparty" />
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
                <Bullet icon={Banknote} title="Valuation, no listing fees" body="We come back with a number based on what the unit can realistically sell for." />
                <Bullet icon={Truck} title="We handle logistics" body="Crating, freight, insurance and customs — coordinated for you." />
                <Bullet icon={ShieldCheck} title="Payment after receipt" body="You get paid once the buyer confirms the unit as described." />
              </ul>
            </div>

            <div>
              <h2 className="text-2xl font-bold tracking-tight" style={{ letterSpacing: '-0.03em' }}>
                How it works
              </h2>
              <ol className="mt-6 space-y-5">
                <Step n={1} icon={FileCheck2} title="Submit your equipment" body="Tell us what you have — the form on the right takes a few minutes." />
                <Step n={2} icon={Search} title="Free valuation" body="Our acquisitions team replies within 2 business days with a market-based valuation." />
                <Step n={3} icon={Handshake} title="We match a buyer" body="We route your item and negotiate on agreed terms." />
                <Step n={4} icon={Clock} title="Ship & get paid" body="We coordinate logistics; you get paid once the buyer confirms receipt." />
              </ol>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
              <p className="font-semibold text-foreground mb-1">No account needed</p>
              You can submit without signing in. We&apos;ll email you a reference and reply to the
              address you provide.
            </div>
          </div>

          <div>
            <SellForm />
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
