import Link from 'next/link';
import Image from 'next/image';
import { BadgeCheck, ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatPrice } from '@/lib/utils';
import { productImage } from '@/lib/images';
import type { ProductCondition, ProductMode } from '@prisma/client';

export interface ProductCardData {
  slug: string;
  title: string;
  brand: string;
  supplier: string;
  illustration: string;
  imageUrl?: string | null;
  condition: ProductCondition;
  mode: ProductMode;
  priceCents: number | null;
  currency: string;
  yearMade?: number | null;
  badge?: string | null;
}

const CONDITION_LABEL: Record<ProductCondition, string> = {
  NEW: 'New',
  REFURBISHED: 'Refurbished',
  USED: 'Used',
};

export function ProductCard({ p }: { p: ProductCardData }) {
  const img = p.imageUrl || productImage(p.illustration, p.slug, 600);
  return (
    <Link
      href={`/marketplace/${p.slug}`}
      className="group rounded-2xl border border-border bg-card overflow-hidden hover:border-primary/30 transition-all hover:shadow-[0_20px_50px_-20px_rgba(15,79,64,0.35)] flex flex-col"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-muted">
        <Image
          src={img}
          alt={p.title}
          fill
          sizes="(min-width:1024px) 25vw, (min-width:640px) 50vw, 100vw"
          className="object-cover transition-transform duration-700 group-hover:scale-110"
        />
        {/* Gradient scrim for legibility */}
        <div className="absolute inset-0 bg-gradient-to-t from-foreground/45 via-transparent to-foreground/10" />
        {p.badge && (
          <div className="absolute top-3 left-3">
            <Badge variant={p.badge === 'New' ? 'success' : 'accent'}>{p.badge}</Badge>
          </div>
        )}
        <div className="absolute top-3 right-3">
          <Badge variant="secondary">{CONDITION_LABEL[p.condition]}</Badge>
        </div>
        <div className="absolute bottom-3 left-3 flex items-center gap-1.5 text-white text-xs font-semibold">
          <BadgeCheck className="h-4 w-4 drop-shadow" />
          14-pt inspected
        </div>
        <div className="absolute bottom-3 right-3 h-9 w-9 rounded-full bg-white/90 backdrop-blur flex items-center justify-center text-foreground translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
          <ArrowUpRight className="h-4 w-4" />
        </div>
      </div>

      <div className="p-4 space-y-2 flex flex-col flex-1">
        <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-bold data">{p.brand}</p>
        <h3 className="text-sm font-semibold leading-snug line-clamp-2 group-hover:text-primary transition-colors min-h-[2.5rem]">
          {p.title}
        </h3>
        <p className="text-xs text-muted-foreground">
          lab2date Verified Supplier
          {p.yearMade && ` · ${p.yearMade}`}
        </p>
        <div className="flex items-center justify-between pt-3 border-t mt-auto">
          {p.priceCents ? (
            <span className="text-base font-bold text-foreground data">
              {formatPrice(p.priceCents, p.currency)}
            </span>
          ) : (
            <span className="text-xs font-bold text-primary uppercase tracking-[0.12em] data">Request quote</span>
          )}
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            {p.condition === 'NEW' ? 'New' : p.condition === 'REFURBISHED' ? 'Refurbished' : 'Used'}
          </span>
        </div>
      </div>
    </Link>
  );
}
