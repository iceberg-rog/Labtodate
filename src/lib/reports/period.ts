/**
 * Report periods (Sold register, Documents, exports). Accounting periods are
 * calendar days in the business time zone (Settings → Invoicing & numbering →
 * Business time zone), so an invoice issued at 00:30 on 1 April in Amsterdam
 * belongs to Q2 even though it is still 31 March in UTC. Rolling windows
 * ("last 30 days") are instants, the same as the Overview tiles.
 * Pure: no settings or DB access (the caller passes the time zone).
 */

export type PeriodKey =
  | 'all'
  | '30d'
  | '90d'
  | 'this-month'
  | 'last-month'
  | 'this-quarter'
  | 'last-quarter'
  | 'this-year'
  | 'last-year'
  | 'custom';

export interface Period {
  key: PeriodKey;
  /** First day (YYYY-MM-DD, business time zone), inclusive; null = open. */
  from: string | null;
  /** Last day (YYYY-MM-DD), inclusive; null = open. */
  to: string | null;
  /** Rolling windows: everything at or after this instant. */
  since: Date | null;
  label: string;
}

export const PERIOD_OPTIONS: ReadonlyArray<{ key: Exclude<PeriodKey, 'custom'>; label: string }> = [
  { key: 'all', label: 'All time' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'this-quarter', label: 'This quarter' },
  { key: 'last-quarter', label: 'Last quarter' },
  { key: 'this-year', label: 'This year' },
  { key: 'last-year', label: 'Last year' },
];

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The calendar day (YYYY-MM-DD) of an instant in `tz`. */
export function localDay(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** A real calendar day typed as YYYY-MM-DD (2026-02-30 is refused). */
export function isDay(v: string | null | undefined): v is string {
  const m = DAY_RE.exec(v ?? '');
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

function ymd(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

/** Last day of a month (m = 1..12; month 13 rolls into the next year). */
function monthEnd(y: number, m: number): string {
  return ymd(y, m + 1, 0);
}

/** "2026-Q4" for a day. */
export function quarterOf(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}

/** "2026-10" for a day. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** "Q4 2026" / "October 2026" for a quarter or month key. */
export function periodKeyLabel(key: string): string {
  const q = /^(\d{4})-Q([1-4])$/.exec(key);
  if (q) return `Q${q[2]} ${q[1]}`;
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return key;
}

/**
 * The period a report shows: ?period= (one of PERIOD_OPTIONS) or a custom
 * ?from= / ?to= (YYYY-MM-DD; either may be left open). Anything else is "all".
 */
export function resolvePeriod(input: { period?: string | null; from?: string | null; to?: string | null }, now: Date, tz: string): Period {
  const today = localDay(now, tz);
  const [y, m] = today.split('-').map(Number);
  const q = Math.ceil(m / 3);
  const from = isDay(input.from) ? input.from : null;
  const to = isDay(input.to) ? input.to : null;
  if (from || to) {
    const [a, b] = from && to && from > to ? [to, from] : [from, to];
    return { key: 'custom', from: a, to: b, since: null, label: `${a ?? '…'} – ${b ?? '…'}` };
  }
  switch (input.period) {
    case '30d':
    case '90d': {
      const days = input.period === '30d' ? 30 : 90;
      return { key: input.period, from: null, to: null, since: new Date(now.getTime() - days * 864e5), label: `Last ${days} days` };
    }
    case 'this-month':
      return { key: 'this-month', from: ymd(y, m, 1), to: monthEnd(y, m), since: null, label: `${MONTHS[m - 1]} ${y}` };
    case 'last-month': {
      const [ly, lm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return { key: 'last-month', from: ymd(ly, lm, 1), to: monthEnd(ly, lm), since: null, label: `${MONTHS[lm - 1]} ${ly}` };
    }
    case 'this-quarter':
      return { key: 'this-quarter', from: ymd(y, q * 3 - 2, 1), to: monthEnd(y, q * 3), since: null, label: `Q${q} ${y}` };
    case 'last-quarter': {
      const [ly, lq] = q === 1 ? [y - 1, 4] : [y, q - 1];
      return { key: 'last-quarter', from: ymd(ly, lq * 3 - 2, 1), to: monthEnd(ly, lq * 3), since: null, label: `Q${lq} ${ly}` };
    }
    case 'this-year':
      return { key: 'this-year', from: ymd(y, 1, 1), to: ymd(y, 12, 31), since: null, label: String(y) };
    case 'last-year':
      return { key: 'last-year', from: ymd(y - 1, 1, 1), to: ymd(y - 1, 12, 31), since: null, label: String(y - 1) };
    default:
      return { key: 'all', from: null, to: null, since: null, label: 'All time' };
  }
}

/** Does an instant fall in the period (days compared in `tz`)? */
export function inPeriod(at: Date | null, p: Period, tz: string): boolean {
  if (!at) return p.key === 'all';
  if (p.since) return at.getTime() >= p.since.getTime();
  if (!p.from && !p.to) return true;
  const day = localDay(at, tz);
  return (!p.from || day >= p.from) && (!p.to || day <= p.to);
}

/**
 * UTC bounds for a database pre-filter: a little wider than the period (no
 * time zone is more than 14 h from UTC), the exact cut is inPeriod().
 */
export function prefilterBounds(p: Period): { gte?: Date; lt?: Date } {
  if (p.since) return { gte: p.since };
  const out: { gte?: Date; lt?: Date } = {};
  if (p.from) out.gte = new Date(Date.parse(`${p.from}T00:00:00Z`) - 864e5);
  if (p.to) out.lt = new Date(Date.parse(`${p.to}T00:00:00Z`) + 2 * 864e5);
  return out;
}

/** URL parameters that reproduce a period (for links and the export button). */
export function periodParams(p: Period): Record<string, string> {
  if (p.key === 'custom') return { ...(p.from ? { from: p.from } : {}), ...(p.to ? { to: p.to } : {}) };
  return p.key === 'all' ? {} : { period: p.key };
}
