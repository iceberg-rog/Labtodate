import Link from 'next/link';
import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { PriceTag } from '@/components/pricing/PriceTag';
import type { PriceDisplaySettings } from '@/lib/pricing/display';
import { ownMediaPath } from '@/lib/media/public-src';
import { getCatalogPolicy, getConditionGrades } from '@/lib/catalog/policy';
import { NoPhoto } from '@/components/marketplace/NoPhoto';
import { isPlaceholderBrand } from '@/lib/catalog/jsonld';
import type { ProductCondition, ProductMode } from '@prisma/client';

export interface ProductCardData {
  slug: string;
  title: string;
  brand: string;
  /** Unused: the card names the seller of record (Settings → Company). */
  supplier?: string;
  /** A generic drawing that fits the category, or null (→ placeholder). */
  illustration?: string | null;
  imageUrl?: string | null;
  condition: ProductCondition;
  mode: ProductMode;
  /** The public SELL price (lib/pricing/resolve) — never Product.priceCents. */
  priceCents: number | null;
  currency: string;
  yearMade?: number | null;
  badge?: string | null;
  vatScheme?: 'STANDARD' | 'MARGIN' | null;
}

/** Server component: shows only our own photo of the unit (never a hotlinked
 *  supplier image or a stock photo); without one, the configured placeholder. */
export async function ProductCard({ p, display }: { p: ProductCardData; display?: PriceDisplaySettings }) {
  const [policy, grades] = await Promise.all([getCatalogPolicy(), getConditionGrades()]);
  const img = ownMediaPath(p.imageUrl);
  const conditionLabel = grades[p.condition]?.label ?? p.condition;
  const brand = isPlaceholderBrand({ name: p.brand }, policy.placeholderBrands) ? null : p.brand;
  return (
    <Link
      href={`/marketplace/${p.slug}`}
      className="group rounded-2xl border border-border bg-card overflow-hidden hover:border-primary/30 transition-all hover:shadow-[0_20px_50px_-20px_rgba(15,79,64,0.35)] flex flex-col"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-muted">
        {img ? (
          <Image
            src={img}
            alt={p.title}
            fill
            sizes="(min-width:1024px) 25vw, (min-width:640px) 50vw, 100vw"
            className="object-cover transition-transform duration-700 group-hover:scale-110"
          />
        ) : (
          <NoPhoto mode={policy.missingPhotoMode} illustration={p.illustration} labels={{ noPhoto: policy.noPhotoLabel, illustration: policy.illustrationLabel }} compact />
        )}
        {/* Gradient scrim for legibility */}
        {img && <div className="absolute inset-0 bg-gradient-to-t from-foreground/45 via-transparent to-foreground/10" />}
        {p.badge && (
          <div className="absolute top-3 left-3">
            <Badge variant={p.badge === 'New' ? 'success' : 'accent'}>{p.badge}</Badge>
          </div>
        )}
        <div className="absolute top-3 right-3">
          <Badge variant="secondary">{conditionLabel}</Badge>
        </div>
        <div className="absolute bottom-3 right-3 h-9 w-9 rounded-full bg-card/90 backdrop-blur flex items-center justify-center text-foreground translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
          <ArrowUpRight className="h-4 w-4" />
        </div>
      </div>

      <div className="p-4 space-y-2 flex flex-col flex-1">
        {brand ? (
          <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-bold data">{brand}</p>
        ) : null}
        <h3 className="text-sm font-semibold leading-snug line-clamp-2 group-hover:text-primary transition-colors min-h-[2.5rem]">
          {p.title}
        </h3>
        <p className="text-xs text-muted-foreground">
          {policy.sellerLegalName}
          {p.yearMade && ` · ${p.yearMade}`}
        </p>
        <div className="flex items-center justify-between pt-3 border-t mt-auto">
          {p.priceCents ? (
            <PriceTag netCents={p.priceCents} currency={p.currency} size="md" scheme={p.vatScheme} settings={display} stacked />
          ) : (
            <span className="text-xs font-bold text-primary uppercase tracking-[0.12em] data">Request quote</span>
          )}
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            {conditionLabel}
          </span>
        </div>
      </div>
    </Link>
  );
}
