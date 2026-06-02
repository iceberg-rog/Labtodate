/**
 * Buyer label normalisation for admin views.
 *
 * The GDPR-anonymise flow stamps deleted accounts with email pattern
 * `deleted+<base64>@lab2date.invalid` and name "Deleted user". Rendering
 * the random base64 in the operator UI is noise; this helper collapses it
 * to a clean "Deleted user" pill. Also dedupes when name == email.
 */

const DELETED_HOST = '@lab2date.invalid';

export interface BuyerLike {
  name?: string | null;
  email?: string | null;
}

export type BuyerDisplay = {
  /** Primary label to show large (e.g. real name, or "Deleted user"). */
  primary: string;
  /** Secondary label to show in parens (e.g. email). Empty when not useful. */
  secondary: string;
  /** True for accounts that have been GDPR-anonymised. */
  anonymised: boolean;
};

export function humaniseBuyer(buyer: BuyerLike | null | undefined): BuyerDisplay {
  if (!buyer) return { primary: 'Unknown buyer', secondary: '', anonymised: false };

  const name = (buyer.name ?? '').trim();
  const email = (buyer.email ?? '').trim();

  const isAnonymised =
    email.endsWith(DELETED_HOST) ||
    name.toLowerCase() === 'deleted user' ||
    email.startsWith('deleted+');

  if (isAnonymised) {
    return { primary: 'Deleted user', secondary: '', anonymised: true };
  }

  if (!name && !email) return { primary: 'Unknown buyer', secondary: '', anonymised: false };
  if (!name) return { primary: email, secondary: '', anonymised: false };
  if (!email) return { primary: name, secondary: '', anonymised: false };
  if (name.toLowerCase() === email.toLowerCase()) {
    return { primary: email, secondary: '', anonymised: false };
  }
  return { primary: name, secondary: email, anonymised: false };
}

/** "1 item" / "3 items" — proper pluralisation for OrderItem totals. */
export function itemCountLabel(rows: { quantity: number }[]): string {
  const n = rows.reduce((s, r) => s + r.quantity, 0);
  return `${n} item${n === 1 ? '' : 's'}`;
}

/** Today 14:32 · Yesterday 09:10 · May 18, 2026 14:32 — accuracy + brevity. */
export function smartDate(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d);
  const now = new Date();
  const sameDay = dt.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 864e5);
  const isYesterday = dt.toDateString() === yesterday.toDateString();
  const time = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay) return `Today ${time}`;
  if (isYesterday) return `Yesterday ${time}`;
  return `${dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${time}`;
}

/**
 * True only when shippingAddress has every field the warehouse needs
 * to dispatch a parcel: name + line1 + city + postal + 2-letter country.
 *
 * BUG-009 (RB) — same predicate as server-side `shippingAddressIsComplete`
 * in admin/actions.ts. Keep these in sync so the UI gate matches the
 * server gate exactly.
 */
export function shippingAddressIsComplete(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  const ad = (o.address as Record<string, unknown> | undefined) ?? o;
  const name = String(o.name ?? '').trim();
  const line1 = String((ad as Record<string, unknown>).line1 ?? '').trim();
  const city = String((ad as Record<string, unknown>).city ?? '').trim();
  const postal = String(
    (ad as Record<string, unknown>).postal_code ??
      (ad as Record<string, unknown>).postal ??
      '',
  ).trim();
  const country = String((ad as Record<string, unknown>).country ?? '').trim();
  return Boolean(name && line1 && city && postal && country.length === 2);
}

/** Compact "name · city, country" string for list rows, so an operator
 *  can read the shipping target without opening the detail page. */
export function shipAddressOneLiner(raw: unknown): { name: string | null; line: string | null; country: string | null; phone: string | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ad = (o.address as Record<string, unknown>) || o;
  const name = typeof o.name === 'string' ? o.name : null;
  const city = typeof ad.city === 'string' ? ad.city : '';
  const country = typeof ad.country === 'string' ? ad.country : null;
  const zip = typeof ad.postal_code === 'string' ? ad.postal_code : '';
  const line = [zip, city, country].filter(Boolean).join(' · ');
  return {
    name,
    line: line || null,
    country,
    phone: typeof o.phone === 'string' ? o.phone : null,
  };
}

/** Quick operational priority for an order — informs the dot/tag on the row.
 *  Highest-impact first; first match wins.
 *
 *  - URGENT   : pending payment > 24h, or paid order with no ship address
 *  - HIGH_VALUE: order total > €5,000
 *  - VIP      : buyer LTV > €10,000 (paid orders only)
 *  - REPEAT   : buyer has ≥1 prior paid order
 *  - NEW_BUYER: first-ever order
 *  - NORMAL   : nothing notable
 */
export type Priority = 'URGENT' | 'HIGH_VALUE' | 'VIP' | 'REPEAT' | 'NEW_BUYER' | 'NORMAL';

export function computeOrderPriority(input: {
  status: string;
  totalCents: number;
  createdAt: Date;
  hasShippingAddress: boolean;
  buyerPaidOrderCount: number;
  buyerLifetimeCents: number;
}): Priority {
  const ageH = (Date.now() - input.createdAt.getTime()) / 3600e3;
  if (input.status === 'PENDING_PAYMENT' && ageH > 24) return 'URGENT';
  if ((input.status === 'PAID' || input.status === 'PROCESSING') && !input.hasShippingAddress) return 'URGENT';
  if (input.totalCents >= 500_000) return 'HIGH_VALUE';
  if (input.buyerLifetimeCents >= 1_000_000) return 'VIP';
  if (input.buyerPaidOrderCount >= 1) return 'REPEAT';
  if (input.buyerPaidOrderCount === 0) return 'NEW_BUYER';
  return 'NORMAL';
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  URGENT: 'urgent',
  HIGH_VALUE: 'high value',
  VIP: 'VIP buyer',
  REPEAT: 'repeat buyer',
  NEW_BUYER: 'first order',
  NORMAL: '',
};

export const PRIORITY_CLASS: Record<Priority, string> = {
  URGENT: 'bg-red-100 text-red-800 border-red-300',
  HIGH_VALUE: 'bg-violet-100 text-violet-800 border-violet-300',
  VIP: 'bg-amber-100 text-amber-800 border-amber-300',
  REPEAT: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  NEW_BUYER: 'bg-sky-50 text-sky-700 border-sky-200',
  NORMAL: 'bg-foreground/5 text-muted-foreground border-border',
};

/** Carrier tracking URL builder. Returns `null` if both carrier and number
 *  are missing; falls back to a Google search for unknown carriers so the
 *  operator still has *something* to click. */
export function trackingUrl(carrier: string | null | undefined, number: string | null | undefined): string | null {
  const n = (number ?? '').trim();
  if (!n) return null;
  const c = (carrier ?? '').trim().toUpperCase();
  switch (c) {
    case 'DHL':
      return `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(n)}`;
    case 'UPS':
      return `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`;
    case 'FEDEX':
      return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`;
    case 'POSTNL':
      return `https://jouw.postnl.nl/track-and-trace/${encodeURIComponent(n)}`;
    case 'DPD':
      return `https://tracking.dpd.de/status/en_GB/parcel/${encodeURIComponent(n)}`;
    case 'GLS':
      return `https://gls-group.com/track/${encodeURIComponent(n)}`;
    case 'TNT':
      return `https://www.tnt.com/express/en_gc/site/shipping-tools/tracking.html?searchType=con&cons=${encodeURIComponent(n)}`;
    case 'USPS':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`;
    case 'ROYAL MAIL':
    case 'ROYALMAIL':
      return `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(n)}`;
    case 'POSTE ITALIANE':
    case 'POSTEITALIANE':
      return `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${encodeURIComponent(n)}`;
    default:
      // For unknown / "Other" carriers we don't know a real tracking URL.
      // Send the tracking number to Google as-is — no carrier word in the
      // query, otherwise "Other" leaks into the search ("Other ABC123").
      return `https://www.google.com/search?q=${encodeURIComponent(`tracking ${n}`)}`;
  }
}

/** Pretty status text + colour family. */
export type Tone = 'amber' | 'emerald' | 'sky' | 'violet' | 'slate' | 'red';

export const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'pending payment',
  PAID: 'paid',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELED: 'canceled',
  REFUNDED: 'refunded',
};

export const STATUS_TONE: Record<string, Tone> = {
  PENDING_PAYMENT: 'amber',
  PAID: 'emerald',
  PROCESSING: 'sky',
  SHIPPED: 'violet',
  DELIVERED: 'emerald',
  CANCELED: 'slate',
  REFUNDED: 'red',
};
