import Link from 'next/link';
import { MapPin, Beaker } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { prisma } from '@/lib/db';
import { InstrumentIllustration, type IllustrationName } from '@/components/illustrations/instruments';
import { formatPrice } from '@/lib/utils';

export const metadata = { title: 'Lab Rental Facilities' };
export const dynamic = 'force-dynamic';

export default async function LabRentalIndexPage() {
  const facilities = await prisma.labFacility.findMany({
    where: { isPublished: true },
    orderBy: { name: 'asc' },
    include: { ownerCompany: { select: { name: true, slug: true } } },
  });

  return (
    <div className="container-px py-14 max-w-6xl mx-auto">
      <header className="mb-12">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">Lab rental</p>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight" style={{ letterSpacing: '-0.04em' }}>
          Rent the instrument.<br />
          <span className="text-primary">Not the whole lab.</span>
        </h1>
        <p className="mt-4 text-muted-foreground text-lg max-w-2xl">
          Partner facilities offering hourly and daily access to specific instruments — useful for one-off
          experiments or method development before committing to purchase.
        </p>
      </header>

      {facilities.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <p className="text-lg font-semibold">No facilities listed yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {facilities.map((f) => (
            <Link key={f.slug} href={`/lab-rental/${f.slug}`} className="rounded-2xl border border-border bg-card overflow-hidden hover:border-primary/40 hover:shadow-xl transition-all group">
              <div className="aspect-[5/3] bg-gradient-to-br from-[hsl(82_55%_92%)] to-[hsl(168_30%_92%)] p-8 relative">
                {f.illustration ? (
                  <InstrumentIllustration name={f.illustration as IllustrationName} />
                ) : (
                  <Beaker className="h-full w-full text-primary/40" />
                )}
              </div>
              <div className="p-6 space-y-3">
                <h2 className="text-lg font-bold group-hover:text-primary leading-tight" style={{ letterSpacing: '-0.02em' }}>{f.name}</h2>
                <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                  <MapPin className="h-3 w-3" /> {f.city}, {f.country}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {f.capabilities.slice(0, 3).map((c) => <Badge key={c} variant="secondary">{c}</Badge>)}
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">{f.description}</p>
                <div className="text-sm font-semibold tabular-nums pt-3 border-t">
                  {f.hourlyRateCents != null && f.hourlyRateCents > 0
                    ? `${formatPrice(f.hourlyRateCents, 'EUR')}/h`
                    : f.dailyRateCents
                    ? `${formatPrice(f.dailyRateCents, 'EUR')}/day`
                    : 'On request'}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
