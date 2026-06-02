import Link from 'next/link';
import { CheckCircle2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const metadata = { title: 'Request received' };

export default function ThanksPage({ searchParams }: { searchParams: { id?: string } }) {
  return (
    <div className="container-px py-20 max-w-xl mx-auto text-center">
      <div className="mx-auto h-16 w-16 rounded-full bg-accent/15 flex items-center justify-center mb-6">
        <CheckCircle2 className="h-8 w-8 text-primary" />
      </div>
      <h1 className="text-4xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }}>
        We&apos;ve got your request.
      </h1>
      <p className="mt-4 text-muted-foreground text-lg">
        Check your inbox — we sent a confirmation. The supplier will reply within 24 business hours.
      </p>
      {searchParams.id && (
        <p className="mt-3 text-xs text-muted-foreground font-mono">Ref: {searchParams.id}</p>
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
