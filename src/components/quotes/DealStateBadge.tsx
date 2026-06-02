import type { DealStateBadge as DSB } from '@/lib/quotes/deal-state';
import { toneClasses } from '@/lib/quotes/deal-state';

export function DealStateBadge({ badge, size = 'md' }: { badge: DSB; size?: 'sm' | 'md' }) {
  const t = toneClasses(badge.tone);
  const cls = size === 'sm'
    ? 'text-[10px] px-1.5 py-0.5'
    : 'text-[11px] px-2 py-1';
  return (
    <span className={`inline-flex items-center gap-1.5 font-bold uppercase tracking-wider rounded-full border ${t.pill} ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden />
      {badge.label}
    </span>
  );
}
