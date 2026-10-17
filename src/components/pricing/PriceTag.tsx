import { formatPrice, cn } from '@/lib/utils';
import { priceParts, type PriceDisplaySettings } from '@/lib/pricing/display';
import { loadPriceDisplay } from '@/lib/pricing/server';

const SIZES = {
  sm: { main: 'text-sm font-bold', label: 'text-[10px]', second: 'text-[10px]' },
  md: { main: 'text-base font-bold', label: 'text-[11px]', second: 'text-[11px]' },
  lg: { main: 'text-2xl font-bold', label: 'text-xs', second: 'text-xs' },
  xl: { main: 'text-4xl font-bold', label: 'text-sm', second: 'text-sm' },
} as const;

/**
 * A sell price with its VAT basis — the one way a price is printed to buyers
 * (Settings → Tax & VAT → Show prices). Server component.
 */
export async function PriceTag({
  netCents,
  currency,
  size = 'md',
  scheme,
  settings,
  className,
  stacked = false,
}: {
  netCents: number;
  currency: string;
  size?: keyof typeof SIZES;
  scheme?: 'STANDARD' | 'MARGIN' | null;
  settings?: PriceDisplaySettings;
  className?: string;
  /** Put the label under the amount (narrow cards). */
  stacked?: boolean;
}) {
  const s = settings ?? (await loadPriceDisplay());
  const p = priceParts(netCents, s, { scheme });
  const z = SIZES[size];
  return (
    <span className={cn('inline-flex flex-col', className)} data-price-net={netCents} data-price-basis={s.mode}>
      <span className={cn('inline-flex flex-wrap items-baseline gap-x-1.5', stacked && 'flex-col gap-0')}>
        <span className={cn('data text-foreground', z.main)}>{formatPrice(p.primaryCents, currency)}</span>
        <span className={cn('text-muted-foreground font-medium', z.label)}>{p.primaryLabel}</span>
      </span>
      {p.secondaryCents != null && (
        <span className={cn('text-muted-foreground data', z.second)}>
          {formatPrice(p.secondaryCents, currency)} {p.secondaryLabel}
        </span>
      )}
    </span>
  );
}
