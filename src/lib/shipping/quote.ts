/**
 * Shipping cost (A11 / B12 groundwork). `quoteShipping` is pure: settings +
 * zones/rates in, a quote out. `quoteShippingFor()` loads both from the
 * registry and the ShippingZone/ShippingRate tables (Admin → Settings →
 * Shipping). Unit tests: src/lib/shipping/quote.test.ts.
 *
 * Outcomes are explicit — never a silent €0:
 *   QUOTED           an amount from the table (or the flat amount)
 *   TO_BE_CONFIRMED  no rate covers it (freight, unknown weight, no zone):
 *                    staff set the freight before a payment request is issued
 *   NOT_SHIPPABLE    the settings refuse unmatched destinations
 */

export type ShippingClassCode = 'PARCEL' | 'PALLET' | 'FREIGHT_QUOTE';
export type RateBasis = 'FLAT' | 'PER_ITEM' | 'PER_KG';

export interface ShippingSettings {
  mode: 'FLAT' | 'ZONE_TABLE';
  flatCents: number;
  unmatched: 'TO_BE_CONFIRMED' | 'NOT_SHIPPABLE';
  defaultClass: ShippingClassCode;
  handlingCents: number;
  freeAboveCents: number | null;
}

export interface RateRow {
  id: string;
  name: string;
  shippingClass: ShippingClassCode;
  basis: RateBasis;
  amountCents: number;
  currency: string;
  freeAboveCents: number | null;
  handlingCents: number;
  minKg: number | null;
  maxKg: number | null;
  leadTimeText: string | null;
  active: boolean;
}

export interface ZoneRow {
  id: string;
  name: string;
  countries: string[];
  active: boolean;
  sortOrder: number;
  rates: RateRow[];
}

export interface ShippingLine {
  qty: number;
  /** Product.shippingClass (null → SHIPPING_DEFAULT_CLASS). */
  shippingClass?: ShippingClassCode | null;
  /** Weight of ONE unit, kg. */
  weightKg?: number | null;
  /** Goods value of the line (qty × unit), cents. */
  valueCents: number;
}

export type ShippingQuote =
  | {
      status: 'QUOTED';
      amountCents: number;
      currency: string;
      zone: { id: string; name: string } | null;
      parts: Array<{ shippingClass: ShippingClassCode; rateId: string | null; rateName: string; amountCents: number }>;
      leadTimeText: string | null;
      reasons: string[];
    }
  | { status: 'TO_BE_CONFIRMED'; reasons: string[] }
  | { status: 'NOT_SHIPPABLE'; reasons: string[] };

/** The zone serving a country: first active zone listing it, else a '*' zone. */
export function zoneFor(country: string, zones: ZoneRow[]): ZoneRow | null {
  const c = country.toUpperCase();
  const active = zones.filter((z) => z.active).sort((a, b) => a.sortOrder - b.sortOrder);
  return active.find((z) => z.countries.includes(c)) ?? active.find((z) => z.countries.includes('*')) ?? null;
}

export function quoteShipping(
  input: { country: string | null; lines: ShippingLine[]; currency: string },
  s: ShippingSettings,
  zones: ZoneRow[],
): ShippingQuote {
  const goodsValue = input.lines.reduce((a, l) => a + l.valueCents, 0);
  const unmatched = (reason: string): ShippingQuote =>
    s.unmatched === 'NOT_SHIPPABLE'
      ? { status: 'NOT_SHIPPABLE', reasons: [reason, 'Unmatched destinations are refused (Settings → Shipping).'] }
      : { status: 'TO_BE_CONFIRMED', reasons: [reason, 'Shipping will be confirmed by our team before payment.'] };

  if (!input.lines.length) return { status: 'QUOTED', amountCents: 0, currency: input.currency, zone: null, parts: [], leadTimeText: null, reasons: ['Nothing to ship.'] };
  if (s.freeAboveCents != null && goodsValue >= s.freeAboveCents) {
    return { status: 'QUOTED', amountCents: 0, currency: input.currency, zone: null, parts: [], leadTimeText: null, reasons: [`Free shipping above ${(s.freeAboveCents / 100).toFixed(2)}.`] };
  }
  if (s.mode === 'FLAT') {
    return {
      status: 'QUOTED', amountCents: s.flatCents + (s.flatCents > 0 ? s.handlingCents : 0), currency: input.currency, zone: null,
      parts: [{ shippingClass: s.defaultClass, rateId: null, rateName: 'Flat rate', amountCents: s.flatCents }], leadTimeText: null, reasons: ['Flat shipping rate.'],
    };
  }
  if (!input.country) return unmatched('No delivery country yet.');
  const zone = zoneFor(input.country, zones);
  if (!zone) return unmatched(`No shipping zone covers ${input.country}.`);

  // Group the lines per shipping class.
  const groups = new Map<ShippingClassCode, { qty: number; kg: number | null; value: number }>();
  for (const l of input.lines) {
    const cls = l.shippingClass ?? s.defaultClass;
    const g = groups.get(cls) ?? { qty: 0, kg: 0, value: 0 };
    g.qty += l.qty;
    g.value += l.valueCents;
    g.kg = g.kg == null || l.weightKg == null ? null : g.kg + l.weightKg * l.qty;
    groups.set(cls, g);
  }

  const parts: Extract<ShippingQuote, { status: 'QUOTED' }>['parts'] = [];
  const leadTimes: string[] = [];
  let handling = 0;
  for (const [cls, g] of groups) {
    const candidates = zone.rates.filter((r) => r.active && r.shippingClass === cls).filter((r) => {
      if (r.minKg == null && r.maxKg == null && r.basis !== 'PER_KG') return true;
      if (g.kg == null) return false; // weight-bound rate but weight unknown
      return (r.minKg == null || g.kg >= r.minKg) && (r.maxKg == null || g.kg <= r.maxKg);
    });
    if (!candidates.length) {
      return unmatched(cls === 'FREIGHT_QUOTE'
        ? `Freight items to ${input.country} are quoted per order.`
        : `No ${cls.toLowerCase()} rate in zone “${zone.name}”${g.kg == null ? ' for items without a weight' : ''}.`);
    }
    if (candidates.some((r) => r.currency !== input.currency)) {
      const same = candidates.filter((r) => r.currency === input.currency);
      if (!same.length) return unmatched(`Zone “${zone.name}” has no ${input.currency} rate for ${cls.toLowerCase()} items.`);
    }
    const priced = candidates
      .filter((r) => r.currency === input.currency)
      .map((r) => {
        let amount = r.basis === 'FLAT' ? r.amountCents : r.basis === 'PER_ITEM' ? r.amountCents * g.qty : r.amountCents * Math.ceil(g.kg ?? 0);
        if (r.freeAboveCents != null && g.value >= r.freeAboveCents) amount = 0;
        return { r, amount };
      })
      .sort((a, b) => a.amount + a.r.handlingCents - (b.amount + b.r.handlingCents));
    const best = priced[0];
    parts.push({ shippingClass: cls, rateId: best.r.id, rateName: best.r.name, amountCents: best.amount });
    handling += best.amount > 0 ? best.r.handlingCents : 0;
    if (best.r.leadTimeText) leadTimes.push(best.r.leadTimeText);
  }
  const total = parts.reduce((a, p) => a + p.amountCents, 0) + handling + (s.handlingCents > 0 ? s.handlingCents : 0);
  return {
    status: 'QUOTED', amountCents: total, currency: input.currency, zone: { id: zone.id, name: zone.name }, parts,
    leadTimeText: leadTimes.join(' / ') || null,
    reasons: [`Zone “${zone.name}”: ${parts.map((p) => `${p.rateName} ${(p.amountCents / 100).toFixed(2)}`).join(', ')}${handling + s.handlingCents ? ` + handling ${((handling + s.handlingCents) / 100).toFixed(2)}` : ''}.`],
  };
}
