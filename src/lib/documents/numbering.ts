import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { settingBool, settingInt, settingString } from '@/lib/settings';

/**
 * Gap-free document numbering (A02 / B02).
 *
 * One counter row per (series, fiscal year) in "InvoiceSequence". A number is
 * allocated ONLY inside the transaction that inserts the FiscalDocument:
 *
 *   INSERT … ON CONFLICT DO NOTHING        (first document of the year)
 *   UPDATE … SET nextValue = nextValue + 1 RETURNING nextValue - 1
 *
 * The UPDATE takes the row lock, so concurrent issuers queue on it; if the
 * issuing transaction rolls back, the increment rolls back with it — no gaps,
 * no duplicates. Proformas have their own series and never consume an invoice
 * number. A DB trigger forbids moving a counter backwards.
 */

export type DocSeries = 'INVOICE' | 'CREDIT_NOTE' | 'PROFORMA';

/** Default business time zone (Settings → Invoicing & numbering → Business time zone). */
export const BUSINESS_TZ = 'Europe/Amsterdam';

/** The configured business time zone (falls back to Europe/Amsterdam when unset or invalid). */
export function businessTimeZone(): string {
  const v = (process.env.BUSINESS_TIMEZONE || '').trim();
  if (v) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return v;
    } catch {
      /* invalid: default */
    }
  }
  return BUSINESS_TZ;
}

export interface NumberingSettings {
  format: string;
  prefix: Record<DocSeries, string>;
  start: Record<DocSeries, number>;
  resetYearly: boolean;
  fiscalYearStartMonth: number;
  /** Calendar of document dates and fiscal years. */
  timeZone: string;
}

/** Sync — call after ensureSettingsLoaded(). */
export function loadNumberingSettings(): NumberingSettings {
  return {
    format: settingString('INVOICE_NUMBER_FORMAT') || '{PREFIX}-{YYYY}-{SEQ:5}',
    prefix: {
      INVOICE: settingString('INVOICE_PREFIX') || 'INV',
      CREDIT_NOTE: settingString('CREDIT_NOTE_PREFIX') || 'CN',
      PROFORMA: settingString('PROFORMA_PREFIX') || 'PF',
    },
    start: {
      INVOICE: settingInt('INVOICE_START_NUMBER', 1),
      CREDIT_NOTE: settingInt('CREDIT_NOTE_START_NUMBER', 1),
      PROFORMA: settingInt('PROFORMA_START_NUMBER', 1),
    },
    resetYearly: settingBool('NUMBERING_RESET_YEARLY'),
    fiscalYearStartMonth: settingInt('FISCAL_YEAR_START_MONTH', 1),
    timeZone: businessTimeZone(),
  };
}

/** Calendar parts of a date in the business time zone. */
export function businessDateParts(d: Date, tz = businessTimeZone()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Fiscal year a date falls in, named after the calendar year it starts in. */
export function fiscalYearOf(d: Date, startMonth = 1, tz = businessTimeZone()): number {
  const { year, month } = businessDateParts(d, tz);
  const m = Math.min(Math.max(Math.trunc(startMonth) || 1, 1), 12);
  return month >= m ? year : year - 1;
}

export function currentFiscalYear(now = new Date()): number {
  let start = 1;
  try {
    start = settingInt('FISCAL_YEAR_START_MONTH', 1);
  } catch {
    /* settings not loaded: calendar year */
  }
  return fiscalYearOf(now, start);
}

/** Render a number: {PREFIX}-{YYYY}-{SEQ:5} → INV-2026-00001. */
export function formatDocNumber(format: string, p: { prefix: string; fiscalYear: number; seq: number }): string {
  return format.replace(/\{(PREFIX|YYYY|YY|SEQ(?::(\d))?)\}/g, (_m, tok: string, pad?: string) => {
    if (tok === 'PREFIX') return p.prefix;
    if (tok === 'YYYY') return String(p.fiscalYear);
    if (tok === 'YY') return String(p.fiscalYear).slice(-2);
    return pad ? String(p.seq).padStart(Number(pad), '0') : String(p.seq);
  });
}

export interface AllocatedNumber {
  series: DocSeries;
  fiscalYear: number;
  /** Counter year: the fiscal year, or 0 for one continuous sequence. */
  counterYear: number;
  seq: number;
  number: string;
}

/** Allocate the next number of a series. MUST run inside the issuing transaction. */
export async function allocateNumber(
  tx: Prisma.TransactionClient,
  series: DocSeries,
  issueDate: Date,
  settings: NumberingSettings,
): Promise<AllocatedNumber> {
  const fiscalYear = fiscalYearOf(issueDate, settings.fiscalYearStartMonth, settings.timeZone);
  const counterYear = settings.resetYearly ? fiscalYear : 0;
  const start = Math.max(1, Math.trunc(settings.start[series]) || 1);
  await tx.$executeRaw`
    INSERT INTO "InvoiceSequence" ("id", "series", "fiscalYear", "nextValue", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${series}, ${counterYear}, ${start}, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
    ON CONFLICT ("series", "fiscalYear") DO NOTHING`;
  const rows = await tx.$queryRaw<Array<{ seq: number }>>`
    UPDATE "InvoiceSequence" SET "nextValue" = "nextValue" + 1, "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE "series" = ${series} AND "fiscalYear" = ${counterYear}
    RETURNING ("nextValue" - 1)::int AS seq`;
  const seq = Number(rows[0]?.seq);
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`Could not allocate a ${series} number.`);
  return { series, fiscalYear, counterYear, seq, number: formatDocNumber(settings.format, { prefix: settings.prefix[series], fiscalYear, seq }) };
}

// ── numbering configuration rules (pure; enforced when settings are saved) ──

export const NUMBERING_KEYS = [
  'INVOICE_NUMBER_FORMAT', 'INVOICE_PREFIX', 'CREDIT_NOTE_PREFIX', 'PROFORMA_PREFIX',
  'NUMBERING_RESET_YEARLY', 'FISCAL_YEAR_START_MONTH', 'BUSINESS_TIMEZONE',
] as const;

/** Numbering settings from plain key → value strings (proposed or current). */
export function numberingFromValues(v: Record<string, string>): Omit<NumberingSettings, 'start'> {
  return {
    format: (v.INVOICE_NUMBER_FORMAT || '{PREFIX}-{YYYY}-{SEQ:5}').trim(),
    prefix: {
      INVOICE: (v.INVOICE_PREFIX || 'INV').trim(),
      CREDIT_NOTE: (v.CREDIT_NOTE_PREFIX || 'CN').trim(),
      PROFORMA: (v.PROFORMA_PREFIX || 'PF').trim(),
    },
    resetYearly: (v.NUMBERING_RESET_YEARLY || 'true') === 'true',
    fiscalYearStartMonth: Number(v.FISCAL_YEAR_START_MONTH || '1') || 1,
    timeZone: (v.BUSINESS_TIMEZONE || BUSINESS_TZ).trim(),
  };
}

/**
 * Problems with a numbering configuration that would break or reuse a series.
 *  - the three prefixes must differ (an invoice and a credit note could
 *    otherwise get the same number);
 *  - the format must contain {PREFIX} (series share one format) and {SEQ};
 *  - restarting every fiscal year needs the year ({YYYY} or {YY}) in the
 *    number, or next year's first invoice repeats this year's.
 */
export function numberingConfigProblems(n: Omit<NumberingSettings, 'start'>): string[] {
  const out: string[] = [];
  const p = n.prefix;
  const bySeries: Array<[string, string]> = [['invoice', p.INVOICE], ['credit note', p.CREDIT_NOTE], ['proforma', p.PROFORMA]];
  const groups = new Map<string, string[]>();
  for (const [series, prefix] of bySeries) groups.set(prefix.toUpperCase(), [...(groups.get(prefix.toUpperCase()) ?? []), series]);
  for (const [prefix, series] of groups) {
    if (series.length > 1) {
      out.push(`the ${series.join(' and ')} prefixes would both be “${prefix}” — every document type needs its own prefix, or two documents could get the same number.`);
    }
  }
  if (!/\{PREFIX\}/.test(n.format)) out.push('the number format must contain {PREFIX} — invoices, credit notes and proformas share the format and are told apart by it.');
  if (!/\{SEQ(?::\d)?\}/.test(n.format)) out.push('the number format must contain {SEQ}.');
  if (n.resetYearly && !/\{(YYYY|YY)\}/.test(n.format)) {
    out.push('numbering restarts every fiscal year, so the format needs the year ({YYYY} or {YY}) — otherwise next year’s numbers repeat this year’s. Add the year, or choose one continuous sequence.');
  }
  return out;
}

/**
 * Changes that are refused once a number series has started: the fiscal-year
 * start month and the yearly restart decide which counter a document uses —
 * changing them later would restart or reuse numbers that were already issued.
 */
export function numberingLockProblems(
  before: Omit<NumberingSettings, 'start'>,
  after: Omit<NumberingSettings, 'start'>,
  started: { series: string; fiscalYear: number; nextValue: number }[],
): string[] {
  if (!started.length) return [];
  const out: string[] = [];
  const first = started[0];
  const where = `the ${first.series.toLowerCase().replace('_', ' ')} series ${first.fiscalYear === 0 ? '(continuous)' : first.fiscalYear} has already issued numbers (next ${first.nextValue})`;
  if (before.fiscalYearStartMonth !== after.fiscalYearStartMonth) {
    out.push(`the fiscal-year start month is locked — ${where}. Changing it would move documents into another numbering year. Agree a change of financial year with your accountant first; it can only be set before the first document is numbered.`);
  }
  if (before.resetYearly !== after.resetYearly) {
    out.push(`“Restart numbering every fiscal year” is locked — ${where}. Switching it would start a new counter and reuse numbers that were already issued.`);
  }
  if (before.timeZone !== after.timeZone) {
    out.push(`the business time zone is locked — ${where}. It decides the date and the fiscal year of every document.`);
  }
  return out;
}

/**
 * The number the next document of `series` gets right now (what allocateNumber
 * would return), from the counter rows and the active settings.
 */
export function nextNumberNow(
  series: DocSeries,
  settings: NumberingSettings,
  counters: { series: string; fiscalYear: number; nextValue: number }[],
  now = new Date(),
): string {
  const fiscalYear = fiscalYearOf(now, settings.fiscalYearStartMonth, settings.timeZone);
  const counterYear = settings.resetYearly ? fiscalYear : 0;
  const row = counters.find((c) => c.series === series && c.fiscalYear === counterYear);
  const seq = row ? row.nextValue : Math.max(1, Math.trunc(settings.start[series]) || 1);
  return formatDocNumber(settings.format, { prefix: settings.prefix[series], fiscalYear, seq });
}
