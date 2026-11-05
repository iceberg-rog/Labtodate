import { randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';

/**
 * Document numbers (Admin → Documents → Numbering).
 *
 * Pattern tokens: {YYYY} {YY} {MM} {SEQ:n} {RAND:n}; anything else must be
 * letters, digits, "-", "_", "/" or ".".
 *
 * Quote, invoice and receipt numbers come from a gap-free counter per series
 * (and per year when "restart every year" is on), taken only inside the
 * transaction that stores the issued document: a rollback gives the number
 * back, two issuers queue on the row lock, and a number is never used twice.
 * Order numbers are references, not tax documents: date tokens + random part.
 */

export type Series = 'QUOTE' | 'INVOICE' | 'RECEIPT';

export interface SeriesDef {
  pattern: string;
  start: number;
  yearlyReset: boolean;
}

export interface NumberingSettings {
  QUOTE: SeriesDef;
  INVOICE: SeriesDef;
  RECEIPT: SeriesDef & { useInvoiceNumber: boolean };
  ORDER: { pattern: string };
}

export const DEFAULT_NUMBERING: NumberingSettings = {
  QUOTE: { pattern: 'PRO-{YYYY}-{SEQ:4}', start: 1, yearlyReset: true },
  INVOICE: { pattern: 'INV-{YYYY}-{SEQ:5}', start: 1, yearlyReset: true },
  RECEIPT: { pattern: 'RCT-{YYYY}-{SEQ:5}', start: 1, yearlyReset: true, useInvoiceNumber: false },
  ORDER: { pattern: 'L2D-{YYYY}-{RAND:6}' },
};

const TOKEN = /\{(YYYY|YY|MM|SEQ:(\d{1,2})|RAND:(\d{1,2}))\}/g;
const TZ = 'Europe/Amsterdam';

function parts(date: Date): { yyyy: string; mm: string } {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return { yyyy: f.find((p) => p.type === 'year')!.value, mm: f.find((p) => p.type === 'month')!.value };
}

const RAND_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function formatNumber(pattern: string, seq: number | null, date = new Date()): string {
  const { yyyy, mm } = parts(date);
  return pattern.replace(TOKEN, (tok, name: string, seqWidth?: string, randWidth?: string) => {
    if (name === 'YYYY') return yyyy;
    if (name === 'YY') return yyyy.slice(2);
    if (name === 'MM') return mm;
    if (seqWidth) return String(seq ?? 0).padStart(Number(seqWidth), '0');
    if (randWidth) {
      let s = '';
      for (let i = 0; i < Number(randWidth); i++) s += RAND_ALPHABET[randInt(RAND_ALPHABET.length)];
      return s;
    }
    return tok;
  });
}

function randInt(n: number): number {
  return randomInt(n);
}

/** Problems with a pattern for a series (empty = fine). */
export function checkPattern(series: Series | 'ORDER', def: { pattern: string; yearlyReset?: boolean }): string[] {
  const label = series === 'ORDER' ? 'Order' : series === 'QUOTE' ? 'Quote' : series === 'INVOICE' ? 'Invoice' : 'Receipt';
  const p = (def.pattern || '').trim();
  const out: string[] = [];
  if (!p) return [`${label} number: the pattern cannot be empty.`];
  if (p.length > 40) out.push(`${label} number: at most 40 characters.`);
  const literal = p.replace(TOKEN, '');
  if (/[{}]/.test(literal)) out.push(`${label} number: unknown token. Use {YYYY}, {YY}, {MM}, {SEQ:5} or {RAND:6}.`);
  else if (!/^[A-Za-z0-9\-_/.]*$/.test(literal)) out.push(`${label} number: only letters, digits and - _ / . are allowed around the tokens.`);
  const hasSeq = /\{SEQ:\d{1,2}\}/.test(p);
  const hasRand = /\{RAND:(\d{1,2})\}/.exec(p);
  if (series === 'ORDER') {
    if (!hasRand || Number(hasRand[1]) < 4) out.push('Order number: needs a random part of at least 4 characters, e.g. {RAND:6}.');
    if (hasSeq) out.push('Order number: {SEQ} is not available for orders; use {RAND:6}.');
  } else {
    if (!hasSeq) out.push(`${label} number: needs a running number, e.g. {SEQ:5}${series === 'INVOICE' ? ' (invoice numbers must be consecutive by law)' : ''}.`);
    if (hasRand) out.push(`${label} number: {RAND} is not allowed here; numbers must be consecutive.`);
    if (def.yearlyReset && !/\{YYYY\}|\{YY\}/.test(p)) out.push(`${label} number: "restart every year" needs {YYYY} or {YY} in the pattern, or numbers would repeat.`);
  }
  return out;
}

function periodFor(def: SeriesDef, date: Date): string {
  return def.yearlyReset ? parts(date).yyyy : 'ALL';
}

/**
 * Take the next number of a series INSIDE the caller's transaction.
 * `isUsed` guards against a pattern/start change that would produce a number
 * that already exists: the issue is refused instead of silently skipping.
 */
export async function allocateNumber(
  tx: Prisma.TransactionClient,
  series: Series,
  def: SeriesDef,
  date: Date,
  isUsed: (n: string) => Promise<boolean>,
): Promise<string> {
  const period = periodFor(def, date);
  const start = Math.max(1, Math.floor(def.start || 1));
  await tx.$executeRaw`INSERT INTO "DocNumberSeries" ("series", "period", "nextValue", "updatedAt") VALUES (${series}, ${period}, ${start}, now()) ON CONFLICT DO NOTHING`;
  const rows = await tx.$queryRaw<{ v: number }[]>`UPDATE "DocNumberSeries" SET "nextValue" = GREATEST("nextValue", ${start}) + 1, "updatedAt" = now() WHERE "series" = ${series} AND "period" = ${period} RETURNING "nextValue" - 1 AS v`;
  const seq = Number(rows[0]?.v);
  if (!Number.isFinite(seq)) throw new Error(`Could not take a ${series.toLowerCase()} number.`);
  const number = formatNumber(def.pattern, seq, date);
  if (await isUsed(number)) {
    throw new Error(`The next ${series.toLowerCase()} number would be ${number}, which is already used. Raise the start number in Admin → Documents → Numbering.`);
  }
  return number;
}

/** What the next number of a series will be (no counter change). */
export async function peekNumber(
  db: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  series: Series,
  def: SeriesDef,
  date = new Date(),
): Promise<string> {
  const period = periodFor(def, date);
  let next = Math.max(1, Math.floor(def.start || 1));
  try {
    const rows = await db.$queryRaw<{ v: number }[]>`SELECT "nextValue" AS v FROM "DocNumberSeries" WHERE "series" = ${series} AND "period" = ${period}`;
    if (rows[0]) next = Math.max(next, Number(rows[0].v));
  } catch {
    /* table missing: start value */
  }
  return formatNumber(def.pattern, next, date);
}
