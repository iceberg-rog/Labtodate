/**
 * Accent folding for slugs.
 *
 * Every slugify here lowercases and then collapses anything outside [a-z0-9]
 * into a dash, which does not transliterate an accented letter - it deletes
 * it. The Cytiva AKTA Pure 25, whose name starts with an A-umlaut, slugged to
 * "ge-healthcare-kta-pure-25": the brand lost its first letter, in the URL and
 * in every search that reads one. On a catalogue of European instrument names
 * that is not an edge case.
 *
 * NFKD splits a letter from its accent so the combining marks can be dropped;
 * the few letters that carry the mark inside the glyph are mapped by hand.
 * Written as code points so the table survives any re-encoding of this file.
 */
const PAIRS: [number, string][] = [
  [0x00df, 'ss'],
  [0x00f8, 'o'], [0x00d8, 'O'],
  [0x00e6, 'ae'], [0x00c6, 'AE'],
  [0x0153, 'oe'], [0x0152, 'OE'],
  [0x0142, 'l'], [0x0141, 'L'],
  [0x0111, 'd'], [0x0110, 'D'],
];

const SPECIALS: Record<string, string> = Object.fromEntries(
  PAIRS.map(([code, out]) => [String.fromCharCode(code), out]),
);

export function foldAccents(s: string): string {
  return s
    .replace(/./gu, (c) => SPECIALS[c] ?? c)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}
