import Link from 'next/link';
import { Compass, ArrowRight, LifeBuoy, PackageSearch } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const metadata = { title: 'Page not found' };

/**
 * Without this file Next serves its own bare "404 / This page could not be
 * found." inside our header and footer - no way onward, nothing that looks
 * like us. It is the page a mistyped or stale link lands on, which is exactly
 * where a first-time visitor should still find the catalogue.
 */
export default function NotFound() {
  return (
    <div className="container-px py-20 max-w-xl mx-auto text-center">
      <div className="mx-auto h-16 w-16 rounded-full bg-accent/15 flex items-center justify-center mb-6">
        <Compass className="h-8 w-8 text-primary" />
      </div>
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">Error 404</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }}>
        This page has moved on.
      </h1>
      <p className="mt-4 text-muted-foreground text-lg">
        The link is broken or the listing is no longer online. Every instrument is still
        here &mdash; start from the catalogue, or tell us what you are looking for.
      </p>

      <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
        <Button asChild size="lg" className="rounded-2xl font-semibold">
          <Link href="/marketplace">
            Browse the catalogue <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="rounded-2xl font-semibold">
          <Link href="/">Back to home</Link>
        </Button>
      </div>

      <div className="mt-10 text-left rounded-2xl border border-border bg-card p-6 space-y-4">
        <p className="text-sm font-bold">Looking for something specific?</p>
        <Onward
          icon={PackageSearch}
          href="/let-us-find-it"
          title="Let us source it"
          text="Tell us the instrument and we come back with a written quote."
        />
        <Onward
          icon={LifeBuoy}
          href="/support"
          title="Ask support"
          text="Open a ticket and our team replies within 1 business day."
        />
      </div>
    </div>
  );
}

function Onward({
  icon: Icon,
  href,
  title,
  text,
}: {
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  title: string;
  text: string;
}) {
  return (
    <Link href={href} className="flex gap-3 items-start group">
      <div className="flex-shrink-0 h-8 w-8 rounded-lg bg-accent/15 text-primary flex items-center justify-center">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-sm font-semibold group-hover:text-primary transition-colors">{title}</p>
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
    </Link>
  );
}
