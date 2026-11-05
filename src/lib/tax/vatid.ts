/**
 * VAT identification numbers — pure helpers (no I/O).
 *
 * A VAT ID is "<prefix><number>". The prefix is the ISO country code, except
 * Greece which uses "EL" (ISO "GR"). Northern Ireland "XI" is accepted for
 * goods (post-Brexit protocol) and maps to GB-NI; we treat it as its own code.
 */

export interface ParsedVatId {
  /** Normalised full ID, e.g. "DE123456789", "EL123456789". */
  vatId: string;
  /** VIES member-state prefix ("EL" for Greece). */
  prefix: string;
  /** ISO 3166 country of the ID ("GR" for an "EL" prefix). */
  country: string;
  /** The part after the prefix. */
  number: string;
}

/** Loose per-country shapes (VIES does the real check). */
const SHAPES: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^\d{7}[A-W][A-I]?$|^\d[A-Z+*]\d{5}[A-W]$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

export function normaliseVatId(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[\s.\-_/]+/g, '');
}

/** Parse a VAT ID. Returns null when there is no 2-letter prefix at all. */
export function parseVatId(raw: string | null | undefined): ParsedVatId | null {
  const vatId = normaliseVatId(raw);
  const m = /^([A-Z]{2})([0-9A-Z+*]{2,13})$/.exec(vatId);
  if (!m) return null;
  const prefix = m[1];
  return { vatId, prefix, country: prefix === 'EL' ? 'GR' : prefix, number: m[2] };
}

/** VIES prefix for an ISO country code (GR → EL). */
export function viesPrefixFor(country: string): string {
  const c = country.toUpperCase();
  return c === 'GR' ? 'EL' : c;
}

/** True when the ID has the documented shape of its member state (false = surely wrong). */
export function vatIdLooksValid(raw: string | null | undefined): boolean {
  const p = parseVatId(raw);
  if (!p) return false;
  const shape = SHAPES[p.prefix];
  return shape ? shape.test(p.number) : false;
}

/** Member states VIES knows (prefixes). */
export const VIES_PREFIXES = Object.keys(SHAPES);
