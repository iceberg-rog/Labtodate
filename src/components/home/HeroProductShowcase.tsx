import Link from 'next/link';
import { firstPublicImage } from '@/lib/media/public-src';
import { isPlaceholderBrand } from '@/lib/catalog/jsonld';
import { BadgeCheck, ArrowUpRight } from 'lucide-react';
import { prisma } from '@/lib/db';
import { loadPriceDisplay } from '@/lib/pricing/server';
import { PriceTag } from '@/components/pricing/PriceTag';
import { NoPhoto } from '@/components/marketplace/NoPhoto';
import { getCatalogPolicy, getConditionGrades } from '@/lib/catalog/policy';
import { LIVE_PRODUCT_WHERE } from '@/lib/marketplace/queries';

/**
 * Live hero showcase. Pulls 3 real published products from the DB and
 * renders them as stacked cards next to the headline. No fake placeholders —
 * if fewer than 3 are live the component renders only what exists.
 *
 * Same rules as every other buyer surface: the PUBLIC sell price
 * (displayPriceCents = the price resolver; null for hidden / quote-only /
 * price under review) with its VAT basis, the condition label the owner set,
 * and without our own photo the configured no-photo tile (never an unlabelled
 * drawing presented as the item).
 */
export async function HeroProductShowcase() {
  const [display, policy, grades] = await Promise.all([loadPriceDisplay(), getCatalogPolicy(), getConditionGrades()]);
  const products = await prisma.product.findMany({
    // Only units a buyer can actually get (never sold / unavailable ones).
    where: LIVE_PRODUCT_WHERE,
    orderBy: [
      // priced first (NULLs would sort FIRST on DESC), then most-recent.
      { displayPriceCents: { sort: 'desc', nulls: 'last' } },
      { updatedAt: 'desc' },
    ],
    take: 8,
    select: {
      id: true,
      slug: true,
      title: true,
      images: true,
      illustration: true,
      displayPriceCents: true,
      currency: true,
      condition: true,
      vatScheme: true,
      brand: { select: { name: true } },
      category: { select: { name: true } },
    },
  });

  // Pick three: prefer ones that have a real photo so the showcase feels real.
  const withPhoto = products.filter((p) => firstPublicImage(p.images));
  const withoutPhoto = products.filter((p) => !firstPublicImage(p.images));
  const pick = [...withPhoto, ...withoutPhoto].slice(0, 3);

  if (pick.length === 0) {
    // No live listings yet — render nothing so the left column gets full width.
    return null;
  }

  return (
    <div className="relative hidden lg:block" data-testid="hero-showcase">
      <p className="text-[10px] uppercase tracking-[0.22em] font-bold text-muted-foreground mb-3 inline-flex items-center gap-1.5">
        <BadgeCheck className="h-3 w-3 text-primary" />
        Live on the marketplace
      </p>
      <ul className="space-y-3">
        {pick.map((p, i) => {
          const photo = firstPublicImage(p.images);
          const brand = p.brand && !isPlaceholderBrand(p.brand, policy.placeholderBrands) ? p.brand.name : p.category.name;
          return (
            <li key={p.id}>
              <Link
                href={`/marketplace/${p.slug}`}
                className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-3.5 hover:border-primary/40 hover:shadow-[0_18px_40px_-22px_rgba(15,79,64,0.4)] transition-all"
                style={{
                  transform: `translateX(${i % 2 === 0 ? '0' : '24px'})`,
                }}
              >
                <div className="h-20 w-20 rounded-xl overflow-hidden bg-muted border border-border flex items-center justify-center flex-shrink-0">
                  {photo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photo} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <NoPhoto
                      mode={policy.missingPhotoMode}
                      illustration={p.illustration}
                      labels={{ noPhoto: policy.noPhotoLabel, illustration: policy.illustrationLabel }}
                      compact
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                    {brand} · {grades[p.condition]?.label ?? p.condition}
                  </p>
                  <p className="font-semibold text-sm leading-tight truncate group-hover:text-primary transition-colors">
                    {p.title}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{p.category.name}</p>
                </div>
                <div className="text-right flex flex-col items-end gap-1 flex-shrink-0">
                  {p.displayPriceCents !== null ? (
                    <PriceTag netCents={p.displayPriceCents} currency={p.currency} size="md" scheme={p.vatScheme} settings={display} stacked className="items-end text-right" />
                  ) : (
                    <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                      Quote
                    </span>
                  )}
                  <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary group-hover:rotate-12 transition-all" />
                </div>
              </Link>
            </li>
          );
        })}
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
