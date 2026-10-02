import Link from 'next/link';
import { CheckCircle2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getMarketing } from '@/lib/marketing';

export const metadata = { title: 'Request received' };
export const dynamic = 'force-dynamic';

export default async function ThanksPage(props: { searchParams: Promise<{ id?: string }> }) {
  const searchParams = await props.searchParams;
  const turnaround = (await getMarketing()).quoteTurnaround;
  // Same reference the confirmation email and dashboard use (RFQ-XXXXXX).
  const ref = searchParams.id ? `RFQ-${searchParams.id.slice(-6).toUpperCase()}` : null;
  return (
    <div className="container-px py-20 max-w-xl mx-auto text-center">
      <div className="mx-auto h-16 w-16 rounded-full bg-accent/15 flex items-center justify-center mb-6">
        <CheckCircle2 className="h-8 w-8 text-primary" />
      </div>
      <h1 className="text-4xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }}>
        We&apos;ve got your request.
      </h1>
      <p className="mt-4 text-muted-foreground text-lg">
        Check your inbox — we sent a confirmation.{' '}
        {turnaround ? `We aim to reply within ${turnaround}.` : 'We\'ll reply as soon as we have something solid.'}
      </p>
      {ref && (
        <p className="mt-3 text-xs text-muted-foreground font-mono">Ref: {ref}</p>
      )}
      <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
        <Button asChild size="lg" className="rounded-2xl font-semibold">
          <Link href="/app/quotes">View my quotes <ArrowRight className="h-4 w-4" /></Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="rounded-2xl font-semibold">
          <Link href="/marketplace">Keep browsing</Link>
        </Button>
      </div>
    </div>
  );
}
