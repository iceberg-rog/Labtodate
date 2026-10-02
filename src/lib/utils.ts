import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Whole amounts stay compact (€1,235); anything with cents shows them
 *  (€1,234.56) — a payable/proforma amount must never be rounded. */
export function formatPrice(cents: number, currency: string = 'EUR'): string {
  const digits = Math.round(cents) % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cents / 100);
}
