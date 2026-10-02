/**
 * Ship-to countries offered at checkout (single + cart). One list so the two
 * address forms and the server-side validation can't drift apart.
 */
export const OTHER_COUNTRY = '__OTHER';

export const CHECKOUT_COUNTRIES: { code: string; name: string }[] = [
  { code: 'NL', name: 'Netherlands' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'BE', name: 'Belgium' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'IE', name: 'Ireland' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'PT', name: 'Portugal' },
  { code: 'AT', name: 'Austria' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'PL', name: 'Poland' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'IR', name: 'Iran' },
  { code: 'TR', name: 'Türkiye' },
  { code: OTHER_COUNTRY, name: 'Other — request a shipping quote' },
];

const SHIPPABLE = new Set(CHECKOUT_COUNTRIES.map((c) => c.code).filter((c) => c !== OTHER_COUNTRY));

/**
 * Classify the raw `country` form value. The "Other" option must be detected on
 * the RAW value: slicing '__OTHER' to 2 chars first produced '__', which then
 * passed a length-2 check and created a real order shipping to country '__'.
 */
export function parseCheckoutCountry(raw: string): { kind: 'other' } | { kind: 'ok'; code: string } | { kind: 'invalid' } {
  const v = raw.trim().toUpperCase();
  if (v === OTHER_COUNTRY || v === 'OT') return { kind: 'other' };
  if (SHIPPABLE.has(v)) return { kind: 'ok', code: v };
  return { kind: 'invalid' };
}
