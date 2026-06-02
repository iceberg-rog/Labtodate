import Link from 'next/link';
import { ImageIcon, BadgeCheck, ArrowUpRight } from 'lucide-react';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { InstrumentIllustration, ILLUSTRATIONS, type IllustrationName } from '@/components/illustrations/instruments';

/**
 * Live hero showcase. Pulls 3 real published products from the DB and
 * renders them as stacked cards next to the headline. No fake placeholders —
 * if fewer than 3 are live the component renders only what exists.
 */
export async function HeroProductShowcase() {
  const products = await prisma.product.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: [
      // priced + buyable first, then most-recent.
      { priceCents: 'desc' },
      { updatedAt: 'desc' },
    ],
    take: 8,
    select: {
      id: true,
      slug: true,
      title: true,
      images: true,
      illustration: true,
      priceCents: true,
      currency: true,
      condition: true,
      brand: { select: { name: true } },
      category: { select: { name: true } },
    },
  });

  // Pick three: prefer ones that have a real photo so the showcase feels real.
  const withPhoto = products.filter((p) => p.images?.length > 0);
  const withoutPhoto = products.filter((p) => !p.images || p.images.length === 0);
  const pick = [...withPhoto, ...withoutPhoto].slice(0, 3);

  if (pick.length === 0) {
    // No live listings yet — render nothing so the left column gets full width.
    return null;
  }

  return (
    <div className="relative hidden lg:block">
      <p className="text-[10px] uppercase tracking-[0.22em] font-bold text-muted-foreground mb-3 inline-flex items-center gap-1.5">
        <BadgeCheck className="h-3 w-3 text-primary" />
        Live on the marketplace
      </p>
      <ul className="space-y-3">
        {pick.map((p, i) => (
          <li key={p.id}>
            <Link
              href={`/marketplace/${p.slug}`}
              className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-3.5 hover:border-primary/40 hover:shadow-[0_18px_40px_-22px_rgba(15,79,64,0.4)] transition-all"
              style={{
                transform: `translateX(${i % 2 === 0 ? '0' : '24px'})`,
              }}
            >
              <div className="h-20 w-20 rounded-xl overflow-hidden bg-gradient-to-br from-[hsl(82_55%_95%)] to-[hsl(168_30%_94%)] border border-border flex items-center justify-center flex-shrink-0">
                {p.images?.[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.images[0]} alt="" className="w-full h-full object-cover" />
                ) : (
                  <InstrumentIllustration name={resolveIllustration(p.illustration)} className="h-14 w-14" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                  {p.brand?.name ?? p.category.name} · {p.condition.toLowerCase()}
                </p>
                <p className="font-semibold text-sm leading-tight truncate group-hover:text-primary transition-colors">
                  {p.title}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{p.category.name}</p>
              </div>
              <div className="text-right flex flex-col items-end gap-1 flex-shrink-0">
                {p.priceCents !== null ? (
                  <span className="text-base font-bold tabular-nums">
                    {formatPrice(p.priceCents, p.currency)}
                  </span>
                ) : (
                  <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                    Quote
                  </span>
                )}
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary group-hover:rotate-12 transition-all" />
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <Link
        href="/marketplace"
        className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:gap-2 transition-all"
      >
        See all live listings →
      </Link>
    </div>
  );
}

function resolveIllustration(name: string | null): IllustrationName {
  if (name && name in ILLUSTRATIONS) return name as IllustrationName;
  return 'balance';
}
