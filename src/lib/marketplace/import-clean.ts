/**
 * Clean-up for listings imported from a supplier's WooCommerce shop.
 *
 * Imported products are sold as "lab2date Verified Supplier" (supplier
 * micro-sites are intentionally hidden), so the source shop's own name, its
 * links and its "see our website" sales copy must not reach the product page.
 * Used by the runtime importer and by prisma/clean-imported-branding.ts for
 * rows imported before this existed.
 */

export interface SupplierRef {
  /** Company name, e.g. "Lab2Parts". */
  name: string;
  /** Any of the shop's URLs (website, import source). */
  urls?: (string | null | undefined)[];
}

/** Placeholder title the importers give a product whose source name is empty. */
export const PLACEHOLDER_TITLE_RE = /^Product \d+$/;

// Named character references: every HTML 4 entity (what WordPress and rich
// text editors emit) plus the common HTML5 additions. Latin-1 is U+00A0…U+00FF
// in order.
const LATIN1_NAMES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 ' +
  'acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde ' +
  'Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc ' +
  'Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring ' +
  'aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml ' +
  'divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
const OTHER_ENTITIES =
  'quot:34 amp:38 apos:39 lt:60 gt:62 QUOT:34 AMP:38 LT:60 GT:62 COPY:169 REG:174 half:189 ' +
  'OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 fnof:402 circ:710 tilde:732 ' +
  'Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 Kappa:922 ' +
  'Lambda:923 Mu:924 Nu:925 Xi:926 Omicron:927 Pi:928 Rho:929 Sigma:931 Tau:932 Upsilon:933 Phi:934 ' +
  'Chi:935 Psi:936 Omega:937 alpha:945 beta:946 gamma:947 delta:948 epsilon:949 zeta:950 eta:951 ' +
  'theta:952 iota:953 kappa:954 lambda:955 mu:956 nu:957 xi:958 omicron:959 pi:960 rho:961 sigmaf:962 ' +
  'sigma:963 tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 thetasym:977 upsih:978 piv:982 ' +
  'ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 hyphen:8208 dash:8208 ndash:8211 ' +
  'mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 Dagger:8225 ' +
  'bull:8226 hellip:8230 permil:8240 prime:8242 Prime:8243 lsaquo:8249 rsaquo:8250 oline:8254 frasl:8260 ' +
  'euro:8364 image:8465 weierp:8472 real:8476 trade:8482 TRADE:8482 ohm:937 alefsym:8501 larr:8592 ' +
  'uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 uArr:8657 rArr:8658 dArr:8659 hArr:8660 ' +
  'forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 ' +
  'minus:8722 lowast:8727 radic:8730 prop:8733 infin:8734 ang:8736 and:8743 or:8744 cap:8745 cup:8746 ' +
  'int:8747 there4:8756 sim:8764 cong:8773 asymp:8776 ne:8800 equiv:8801 le:8804 ge:8805 sub:8834 ' +
  'sup:8835 nsub:8836 sube:8838 supe:8839 oplus:8853 otimes:8855 perp:8869 sdot:8901 lceil:8968 ' +
  'rceil:8969 lfloor:8970 rfloor:8971 lang:10216 rang:10217 loz:9674 spades:9824 clubs:9827 hearts:9829 ' +
  'diams:9830 check:10003 cross:10007';

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ...LATIN1_NAMES.split(' ').map((name, i): [string, string] => [name, String.fromCharCode(0xa0 + i)]),
  ...OTHER_ENTITIES.split(' ').map((pair): [string, string] => {
    const [name, code] = pair.split(':');
    return [name, String.fromCodePoint(Number(code))];
  }),
]);

// &#128;–&#159; mean what Windows-1252 puts there (browsers decode them so):
// WordPress copy pasted from Word is full of &#150; and &#146;.
const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const ENTITY_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/**
 * Decode HTML character references to plain text, once, the way a browser
 * would: numeric ("&#8211;", "&#x2013;", "&#038;") and named ("&amp;",
 * "&deg;", "&micro;"). Invalid code points become U+FFFD. Names not in the
 * table are left as written, or replaced with `unknown` when given.
 *
 * The result is plain text — it can contain "<" or "&" again, so it must be
 * escaped wherever it is put into HTML (React does; emails use escapeHtml).
 */
export function decodeEntities(text: string, unknown?: string): string {
  return text.replace(ENTITY_RE, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES.get(name) ?? unknown ?? whole;
    let code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex as string, 16);
    code = CP1252[code] ?? code;
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  });
}

/** Plain text from a snippet of shop HTML: tags dropped, entities decoded, whitespace collapsed. */
export function stripHtml(h: string): string {
  // Decode after removing tags, so an encoded "&lt;b&gt;" stays as text.
  return decodeEntities(h.replace(/<[^>]+>/g, ' '), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "https://www.lab2.nl/shop" → "lab2" (the label before the TLD). */
function domainLabel(url: string): string | null {
  try {
    const parts = new URL(url).hostname.toLowerCase().split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : null;
  } catch {
    return null;
  }
}

/**
 * Matches text that identifies the supplier: its name or domain as a whole
 * word ("LAB2parts has…", "www.lab2.nl"), or "our website" copy pointing the
 * buyer to the supplier's own shop (also the Dutch "onze website").
 */
export function supplierPattern(s: SupplierRef): RegExp {
  const tokens = new Set<string>();
  const compact = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (compact.length >= 4) tokens.add(compact);
  for (const u of s.urls ?? []) {
    const label = u ? domainLabel(u) : null;
    if (label && label.length >= 4) tokens.add(label);
  }
  const alts = [String.raw`\b(?:our|onze)\s+(?:web\s?shop|webs?ite|webiste)\b`];
  if (tokens.size) {
    alts.push(`(?<![a-z0-9])(?:${[...tokens].map(escapeRegExp).join('|')})(?![a-z0-9])`);
  }
  return new RegExp(alts.join('|'), 'i');
}

function blockText(html: string): string {
  const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
  return `${text} ${hrefs.join(' ')}`;
}

// An <img> loading from another host ("https://…", "http://…", "//…"): in
// imported shop copy that is the supplier's own server — a hotlink (often plain
// http, i.e. mixed content on our https pages). Listing photos live in
// Product.images; site-relative images are kept.
const EXTERNAL_IMG_RE = /<img\b[^>]*?\ssrc\s*=\s*["']?\s*(?:https?:)?\/\/[^>]*>/gi;

/** True when the HTML embeds an image hotlinked from another host. */
export function hasExternalImage(html: string): boolean {
  return new RegExp(EXTERNAL_IMG_RE.source, 'i').test(html);
}

// A text block: paragraph, heading, list item, or a <div> holding no other
// block (WooCommerce short descriptions are often one <div> per line, nested
// in a wrapper <div>; only such leaf <div>s are a single line of copy — a
// wrapper is never dropped whole for one line inside it).
const BLOCK_RE =
  /<(p|h[1-6]|li)\b[^>]*>[\s\S]*?<\/\1\s*>|<div\b[^>]*>(?:(?!<(?:div|p|h[1-6]|li|ul|ol|table)\b)[\s\S])*?<\/div\s*>/gi;
const EMPTY_INNER = String.raw`(?:\s|&nbsp;|&#160;|<br\s*\/?>)*`;
const EMPTY_P_RE = new RegExp(String.raw`<p\b[^>]*>${EMPTY_INNER}<\/p\s*>`, 'gi');
const EMPTY_DIV_RE = new RegExp(String.raw`<div\b[^>]*>${EMPTY_INNER}<\/div\s*>`, 'gi');

function cleanSupplierPass(html: string, re: RegExp): string {
  return html
    .replace(EXTERNAL_IMG_RE, '')
    .replace(BLOCK_RE, (block) => (re.test(blockText(block)) ? '' : block))
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, '$1')
    .replace(EMPTY_P_RE, '')
    .replace(EMPTY_DIV_RE, '')
    .replace(/<(ul|ol)\b[^>]*>\s*<\/\1\s*>/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Drop paragraphs, headings, list items and single-line <div>s that identify
 * the supplier, remove images hotlinked from another host, unwrap any
 * remaining links (no outbound links on listings), and tidy up the empty
 * paragraphs / divs / lists left behind. Returns null when nothing is left.
 *
 * Runs to a fixed point (removing a block can empty its wrapper), so cleaning
 * already-cleaned HTML returns it unchanged — the cleanup script relies on
 * that to converge.
 */
export function cleanSupplierHtml(html: string | null | undefined, s: SupplierRef): string | null {
  if (!html) return null;
  const re = supplierPattern(s);
  let out = html;
  for (let i = 0; i < 10; i++) {
    const next = cleanSupplierPass(out, re);
    if (next === out) break;
    out = next;
  }
  return out || null;
}

/**
 * WooCommerce Store API prices are integer strings in the currency's minor
 * unit (`currency_minor_unit` decimals). Product.priceCents always has two,
 * so a 0-decimal shop's "50" is €50 (5000), not €0.50.
 */
export function wooPriceToCents(prices: { price?: string; currency_minor_unit?: number } | null | undefined): number | null {
  const raw = parseFloat(prices?.price ?? '0');
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const unit = prices?.currency_minor_unit;
  const minor = typeof unit === 'number' && Number.isInteger(unit) ? unit : 2;
  return Math.round(raw * 10 ** (2 - minor));
}
