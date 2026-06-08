import { PackageCheck, Globe2, BadgeCheck } from 'lucide-react';
import { prisma } from '@/lib/db';
import { WaveCanvas } from '@/components/home/WaveCanvas';

export async function FeaturedSuppliers() {
  // Aggregate, non-identifying trust signals only — we never expose the
  // underlying source suppliers (customers must transact through lab2date).
  const [listings, brands] = await Promise.all([
    prisma.product.count({ where: { status: 'PUBLISHED' } }),
    prisma.brand.count({ where: { products: { some: { status: 'PUBLISHED' } } } }),
  ]);

  return (
    <section className="relative overflow-hidden border-y border-foreground/5 bg-foreground/[0.02]">
      <WaveCanvas className="absolute inset-0 h-full w-full" light centered />
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 60% 52% at 50% 38%, hsl(var(--background) / 0.6) 0%, transparent 72%)',
        }}
        aria-hidden
      />
      <div className="relative z-10 container-px py-24">
        <div className="text-center mb-14 max-w-2xl mx-auto">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-3">
            Verified supply
          </p>
          <h2
            className="text-3xl md:text-5xl font-bold text-foreground"
            style={{ letterSpacing: '-0.035em' }}
          >
            One supply network.<br />
            <span className="text-muted-foreground">One accountable counterparty.</span>
          </h2>
          <p className="mt-5 text-muted-foreground leading-relaxed">
            Every listing is handled through lab2date end to end — quote, proforma, payment and
            shipping. You buy from one accountable counterparty.
          </p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl mx-auto">
          <Stat icon={PackageCheck} value={listings.toLocaleString()} label="Listings" />
          <Stat icon={BadgeCheck} value={`${brands}`} label="Instrument brands" />
          <Stat icon={Globe2} value="Worldwide" label="Crated &amp; insured shipping" />
        </div>
      </div>
    </section>
  );
}

function Stat({
  icon: Icon,
  value,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  label: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-center">
      <Icon className="h-6 w-6 mx-auto text-primary" />
      <p className="text-2xl font-bold mt-3" style={{ letterSpacing: '-0.03em' }}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground mt-1 font-medium">{label}</p>
    </div>
  );
}
