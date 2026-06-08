import Link from 'next/link';
import { CheckCircle2, ArrowRight, Mail, Search, Handshake } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const metadata = { title: 'Submission received' };

export default function SellThanksPage({ searchParams }: { searchParams: { id?: string } }) {
  return (
    <div className="container-px py-20 max-w-xl mx-auto text-center">
      <div className="mx-auto h-16 w-16 rounded-full bg-accent/15 flex items-center justify-center mb-6">
        <CheckCircle2 className="h-8 w-8 text-primary" />
      </div>
      <h1 className="text-4xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }}>
        Submission received.
      </h1>
      <p className="mt-4 text-muted-foreground text-lg">
        We&apos;ve emailed you a confirmation. Our acquisitions team will review your equipment and
        reply with a free valuation within <strong className="text-foreground">2 business days</strong>.
      </p>
      {searchParams.id && (
        <p className="mt-3 text-xs text-muted-foreground font-mono">Ref: {searchParams.id}</p>
      )}

      <div className="mt-10 text-left rounded-2xl border border-border bg-card p-6 space-y-4">
        <p className="text-sm font-bold">What happens next</p>
        <NextStep icon={Mail} text="You receive a confirmation email with your reference number." />
        <NextStep icon={Search} text="We benchmark your item against the refurbished market and prepare a valuation." />
        <NextStep icon={Handshake} text="We come back with a valuation and the next step." />
      </div>

      <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
        <Button asChild size="lg" className="rounded-2xl font-semibold">
          <Link href={searchParams.id ? `/app/sell-submissions/${searchParams.id}` : '/app/sell-submissions'}>
            Open your offer <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="rounded-2xl font-semibold">
          <Link href="/app/sell-submissions">All my offers</Link>
        </Button>
      </div>
    </div>
  );
}

function NextStep({
  icon: Icon,
  text,
}: {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
}) {
  return (
    <div className="flex gap-3 items-start">
      <div className="flex-shrink-0 h-8 w-8 rounded-lg bg-accent/15 text-primary flex items-center justify-center">
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-sm text-muted-foreground pt-1.5">{text}</p>
    </div>
  );
}
