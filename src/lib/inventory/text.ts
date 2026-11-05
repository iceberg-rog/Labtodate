/**
 * Input normalisation shared by the sheet, bulk edit and imports.
 *
 * No escaped code points are written in this file on purpose: the ranges are
 * built from numbers so the source stays plain ASCII.
 */

const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;
const ARABIC_DECIMAL_SEPARATOR = 0x066b;
const ARABIC_THOUSANDS_SEPARATOR = 0x066c;
const ARABIC_COMMA = 0x060c;

/** Persian / Arabic-Indic digits and separators -> ASCII. Everything else unchanged. */
export function normalizeDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp >= PERSIAN_ZERO && cp <= PERSIAN_ZERO + 9) out += String.fromCharCode(48 + cp - PERSIAN_ZERO);
    else if (cp >= ARABIC_ZERO && cp <= ARABIC_ZERO + 9) out += String.fromCharCode(48 + cp - ARABIC_ZERO);
    else if (cp === ARABIC_DECIMAL_SEPARATOR) out += '.';
    else if (cp === ARABIC_THOUSANDS_SEPARATOR || cp === ARABIC_COMMA) out += ',';
    else out += ch;
  }
  return out;
}

const ARABIC_SCRIPT = /\p{Script=Arabic}/u;

/** True when the text contains Persian/Arabic letters (after digits were normalised). */
export function hasArabicScript(input: string): boolean {
  return ARABIC_SCRIPT.test(input);
}

/** Trim, collapse inner whitespace runs, normalise digits. */
export function cleanText(input: unknown): string {
  if (input === null || input === undefined) return '';
  return normalizeDigits(String(input)).replace(/[\t\r\n ]+/g, ' ').trim();
}

/** Same, but keeps line breaks (notes). */
export function cleanMultiline(input: unknown): string {
  if (input === null || input === undefined) return '';
  return normalizeDigits(String(input))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .trim();
}

/**
 * Parse a money amount typed by a person into cents.
 * Accepts "1234", "1234.5", "1,234.50", "1.234,50", "1234,50", "€ 99", "99 EUR".
 * A lone separator followed by exactly 3 digits is read as a thousands
 * separator ("1,234" = 1234), otherwise as the decimal point.
 * Returns null for empty input and NaN for something that is not a number.
 */
export function parseMoneyToCents(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : NaN;
  let s = cleanText(input).replace(/eur|euro|€/gi, '').replace(/\s+/g, '');
  if (s === '' || s === '-') return null;
  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s)) return NaN;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart: string;
  let fracPart = '';
  if (lastDot >= 0 && lastComma >= 0) {
    // Both separators: the last one is the decimal point, the other groups thousands ("1.250,50", "1,250.50").
    const dec = Math.max(lastDot, lastComma);
    const decChar = s[dec];
    const intRaw = s.slice(0, dec);
    if (intRaw.includes(decChar)) return NaN;
    const groups = intRaw.split(decChar === '.' ? ',' : '.');
    if (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return NaN;
    intPart = groups.join('');
    fracPart = s.slice(dec + 1);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const tail = parts[parts.length - 1];
    if (parts.length > 2 || tail.length === 3) {
      // "1.234.567" or "1,234": thousands separators only.
      if (parts.slice(1).some((p) => p.length !== 3)) return NaN;
      intPart = parts.join('');
    } else {
      intPart = parts[0];
      fracPart = tail;
    }
  } else {
    intPart = s;
  }
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart) || (intPart === '' && fracPart === '')) return NaN;
  if (fracPart.length > 2) return NaN;
  const cents = Number(intPart || '0') * 100 + Number((fracPart + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return NaN;
  return negative ? -cents : cents;
}

/** Parse a whole number typed by a person. null for empty, NaN for invalid. */
export function parseWholeNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isInteger(input) ? input : NaN;
  const s = cleanText(input).replace(/\s+/g, '');
  if (s === '') return null;
  if (!/^-?\d+$/.test(s)) {
    // "4.0" from a spreadsheet is still 4.
    if (/^-?\d+[.,]0+$/.test(s)) return Number(s.replace(/[.,]0+$/, ''));
    return NaN;
  }
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : NaN;
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** Header text -> lookup key: lower case, letters and digits only. */
export function headerKey(input: unknown): string {
  return cleanText(input).toLowerCase().replace(/[^a-z0-9]/g, '');
}
