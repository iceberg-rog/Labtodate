import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MapPin, ChevronLeft, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { prisma } from '@/lib/db';
import { InstrumentIllustration, type IllustrationName } from '@/components/illustrations/instruments';
import { formatPrice } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const f = await prisma.labFacility.findUnique({ where: { slug: params.slug } });
  return { title: f?.name ?? 'Not found' };
}

export default async function FacilityPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const facility = await prisma.labFacility.findUnique({
    where: { slug: params.slug },
    include: { ownerCompany: true },
  });
  if (!facility || !facility.isPublished) notFound();

  return (
    <div className="container-px py-12 max-w-5xl mx-auto">
      <Link href="/lab-rental" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6">
        <ChevronLeft className="h-4 w-4" /> All facilities
      </Link>

      <div className="grid lg:grid-cols-[1.2fr_1fr] gap-10">
        <div>
          <div className="aspect-[5/3] rounded-2xl bg-gradient-to-br from-[hsl(82_55%_92%)] to-[hsl(168_30%_92%)] p-16">
            {facility.illustration && <InstrumentIllustration name={facility.illustration as IllustrationName} />}
          </div>
          <div className="mt-8 prose-article">
            <h2>About this facility</h2>
            <p>{facility.description}</p>
            <h2>Capabilities</h2>
            <ul>
              {facility.capabilities.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </div>
        </div>

        <aside>
          <div className="sticky top-24 space-y-6">
            <div>
              <h1 className="text-3xl font-bold tracking-tight" style={{ letterSpacing: '-0.03em' }}>
                {facility.name}
              </h1>
              <p className="mt-2 text-muted-foreground inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" /> {facility.city}, {facility.country}
              </p>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {facility.capabilities.map((c) => <Badge key={c} variant="secondary">{c}</Badge>)}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card p-6">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Rate</p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-2xl font-bold tabular-nums" style={{ letterSpacing: '-0.03em' }}>
                    {facility.hourlyRateCents != null && facility.hourlyRateCents > 0
                      ? formatPrice(facility.hourlyRateCents, 'EUR')
                      : '—'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">per hour</p>
                </div>
                <div>
                  <p className="text-2xl font-bold tabular-nums" style={{ letterSpacing: '-0.03em' }}>
                    {facility.dailyRateCents != null && facility.dailyRateCents > 0
                      ? formatPrice(facility.dailyRateCents, 'EUR')
                      : '—'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">per day</p>
                </div>
              </div>
              <Button asChild className="rounded-2xl font-semibold w-full mt-5">
                <Link href={`/let-us-find-it?product=${facility.slug}`}>
                  Request access <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>

            {facility.ownerCompany && (
              <div className="rounded-2xl border border-border bg-card p-5">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground mb-2">Operated by</p>
                <p className="font-semibold">{facility.ownerCompany.name}</p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
