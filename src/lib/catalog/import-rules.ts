/**
 * Owner-configurable rules for what an imported supplier listing may say and
 * how it is mapped into lab2date's catalogue (Settings → Import & suppliers).
 * Pure (no DB, no env): the defaults below are also the registry defaults, the
 * parsers turn the admin's text into matchers, and the matchers are unit-tested.
 *
 *  - CLAIMS: supplier promises lab2date has not made (its warranty, "tested by
 *    our engineers", "like new", services it offers) — removed from imported
 *    texts or held for review, so a listing states ONE warranty: lab2date's.
 *  - PRICES: other prices inside the text ("€ 4,500.00", "Prices from: 17.500
 *    euro") — removed, so only lab2date's price (after markup / force-quote /
 *    hidden price) is ever shown or indexed.
 *  - TAIL SECTIONS: supplier cross-sell tails ("Also available: …") — the
 *    heading and everything after it.
 *  - BRANDS / CATEGORIES: whole-word name and keyword rules (no substring guess:
 *    "ThermoMixer" is not "Thermo"); nothing matched → review, never a silent
 *    first-category fallback.
 *  - CONDITION WORDS: words in a title or text that state a condition, used to
 *    flag a listing whose grade contradicts its own text.
 */

// ─── Defaults (also the settings registry defaults) ──────────────────────────

/** Phrases that make a sentence a supplier claim. `*` = any word ending. */
export const DEFAULT_CLAIM_PHRASES = [
  'warrant*', 'garantie*', 'guarantee*',
  'tested', 'getest', 'test report*', 'tune report*', 'testrapport*',
  'our own engineers', 'our engineers', 'service engineers', 'onze eigen engineers', 'onze technici',
  'like new', 'look like new', 'works like new', 'als nieuw',
  'we can also repair', 'we also repair', 'we do have', 'we also offer', 'we can deliver', 'we can also deliver',
  'contact us', 'please contact', 'neem contact',
  'ask for more info', 'ask for price', 'please ask', 'official quote',
].join(', ');

/** Headings that start a cross-sell tail: the heading and everything after it go. */
// Stored the way the settings form normalises a list (no space after commas),
// so saving an untouched tab never records a change.
export const DEFAULT_TAIL_SECTIONS = ['Also available', 'Ook beschikbaar', 'Ook leverbaar', 'Other products'].join(',');

export const DEFAULT_BRAND_NAMES = [
  'Agilent', 'Waters', 'Thermo', 'Shimadzu', 'PerkinElmer', 'Hitachi', 'Bruker', 'Sciex', 'Beckman Coulter',
  'Dionex', 'Varian', 'Sartorius', 'Eppendorf', 'Bio-Rad', 'Mettler Toledo', 'Tecan', 'Roche', 'Leica', 'Zeiss',
  'Olympus', 'Nikon', 'Hewlett-Packard', 'CTC Analytics', 'Gilson', 'Jasco', 'Knauer', 'VICI', 'Edwards', 'Pfeiffer',
  'Hamilton', 'Gerstel',
].join(', ');

/** "alias => Brand" per line: other spellings that mean a configured brand. */
export const DEFAULT_BRAND_ALIASES = [
  'HP => Hewlett-Packard',
  'Hewlett Packard => Hewlett-Packard',
  'Thermo Scientific => Thermo',
  'Thermo Fisher => Thermo',
  'ThermoFisher => Thermo',
  'Thermo Finnigan => Thermo',
  'Finnigan => Thermo',
  'Micromass => Waters',
  'Beckman => Beckman Coulter',
  'Mettler => Mettler Toledo',
  'Mettler-Toledo => Mettler Toledo',
  'AB Sciex => Sciex',
  'Perkin Elmer => PerkinElmer',
  'CTC => CTC Analytics',
].join('\n');

/**
 * "category-slug: keyword, keyword*" per line, checked top to bottom against
 * the title and the source's category names. First matching line wins.
 */
export const DEFAULT_CATEGORY_RULES = [
  'mass-spec: mass spec*, lc/ms, lc-ms, lcms, gc/ms, gc-ms, gcms, orbitrap, tof, q-tof, triple quad, qqq, xevo, micromass, finnigan, msd, icp-ms, spectromet*',
  'detectors: detector*, dad, pda, fld, elsd, cad, rid, diode array, refractive index',
  'gc: gc, gas chromatograph*, 6890*, 6850*, 5890*, 7890*, 7820*, trace gc, headspace',
  'autosamplers: autosampler*, auto sampler*, auto-sampler*, autoinjector*, sampler, carousel, triplus',
  'hplc-lc: hplc, uplc, alliance, acquity, nexera, vanquish, ultimate 3000, 1100 series, 1200 series, 1260, 1290, 2695, empower',
  'spectroscopy: aas, ftir, ft-ir, uv/vis, uv-vis, fluorescen*, raman, nmr, icp-oes, spectrophotomet*',
  'pumps-fluidics: pump, pumps, degasser*, solvent manager, fluidic*, syringe pump*',
  'vacuum-gas: vacuum, turbo pump*, gas generator*, nitrogen generator*',
  'microscopy: microscop*, confocal, imaging system*',
  'centrifuges: centrifug*, rotor*, sorvall, allegra, avanti',
  'parts-modules: part, parts, board*, module*, lamp*, seal*, filter*, valve*, kit, kits, cable*, cover*, consumab*',
].join('\n');

/** "CONDITION: word, word*" per line — what text that states a condition says. */
export const DEFAULT_CONDITION_WORDS = [
  'NEW: brand new, new in box, nieuw in doos, unused, ongebruikt, sealed, never used, for sale: new',
  'REFURBISHED: refurbished, gereviseerd, reconditioned, overhauled, remanufactured',
  'USED: for sale: used, used condition, gebruikt, second hand, pre-owned, as is, for parts',
].join('\n');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CleanRules {
  claims: RegExp | null;
  tails: RegExp | null;
  stripPrices: boolean;
}

export interface BrandRules {
  /** canonical name → matcher list (the name itself + its aliases). */
  entries: Array<{ canonical: string; re: RegExp }>;
  /** lower-case alias / name → canonical (for the source's own brand field). */
  lookup: Map<string, string>;
}

export interface CategoryRule {
  slug: string;
  re: RegExp;
}

export type ConditionCode = 'NEW' | 'REFURBISHED' | 'USED';

export interface ConditionWords {
  rules: Array<{ code: ConditionCode; re: RegExp }>;
}

// ─── Phrase → regex ──────────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One admin phrase as a whole-word, case-insensitive pattern: spaces match any
 * run of spaces / slashes / hyphens; a trailing `*` matches the rest of the
 * word ("warrant*" → warranty, warranties); "/" and "-" inside are literal-ish.
 */
export function phrasePattern(raw: string): string | null {
  let p = raw.trim();
  if (!p) return null;
  const wildcard = p.endsWith('*');
  if (wildcard) p = p.slice(0, -1).trim();
  if (!p) return null;
  const body = p
    .split(/\s+/)
    .map((w) => escapeRe(w).replace(/[/-]/g, '[\\s/-]?'))
    .join('[\\s/-]+');
  const start = /^[A-Za-z0-9]/.test(p) ? '(?<![A-Za-z0-9])' : '';
  const end = wildcard ? '[A-Za-z0-9]*' : /[A-Za-z0-9]$/.test(p) ? '(?![A-Za-z0-9])' : '';
  return `${start}${body}${end}`;
}

/** Comma / newline separated phrases → one regex (null when empty). */
export function phrasesRegex(list: string): RegExp | null {
  const parts = list
    .split(/[,\n]/)
    .map(phrasePattern)
    .filter((x): x is string => !!x);
  return parts.length ? new RegExp(parts.join('|'), 'i') : null;
}

// ─── Prices inside texts ─────────────────────────────────────────────────────

const AMOUNT = String.raw`\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?(?:,-|\.-)?|\d+(?:[.,]\d{1,2})?(?:,-|\.-)?`;
/**
 * A money amount with a currency next to it (€ 4,500.00 · EUR 9500,- ·
 * 17.500 euro · $1,200 · 4.500,- EUR), or a "Price(s) from / Pricing / Prijs"
 * label. Part numbers (G1311-66530) and model numbers never carry a currency.
 */
export const PRICE_TEXT_RE = new RegExp(
  [
    String.raw`(?:€|eur\b|euro\b|usd\b|\$|£|gbp\b|chf\b)\s*(?:${AMOUNT})`,
    String.raw`(?:${AMOUNT})\s*(?:€|eur\b|euro'?s?\b|usd\b|\$|£|gbp\b|chf\b)`,
    String.raw`\b(?:prices?\s+from|pricing\s*:|price\s*:|prijs\s*:|prijzen\s+vanaf|vanaf\s+€)`,
  ].join('|'),
  'i',
);

/** True when a plain text contains a price or a price label. */
export function hasPriceText(text: string): boolean {
  return PRICE_TEXT_RE.test(text);
}

// ─── Parsers (admin text → matchers) ─────────────────────────────────────────

export function cleanRulesFrom(opts: { claimPhrases: string; tailSections: string; stripPrices: boolean; removeClaims: boolean }): CleanRules {
  return {
    claims: opts.removeClaims ? phrasesRegex(opts.claimPhrases) : null,
    tails: phrasesRegex(opts.tailSections),
    stripPrices: opts.stripPrices,
  };
}

export const DEFAULT_CLEAN_RULES: CleanRules = cleanRulesFrom({
  claimPhrases: DEFAULT_CLAIM_PHRASES,
  tailSections: DEFAULT_TAIL_SECTIONS,
  stripPrices: true,
  removeClaims: true,
});

/** Parse "alias => Brand" lines (also "alias = Brand"). Bad lines are reported. */
export function parseAliasLines(text: string): { pairs: Array<[string, string]>; errors: string[] } {
  const pairs: Array<[string, string]> = [];
  const errors: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(.+?)\s*=>?\s*(.+)$/);
    if (!m || !m[1].trim() || !m[2].trim()) {
      errors.push(`line ${i + 1} (“${t.slice(0, 40)}”) is not “alias => Brand”`);
      continue;
    }
    pairs.push([m[1].trim(), m[2].trim()]);
  }
  return { pairs, errors };
}

export function brandRulesFrom(names: string, aliases: string): BrandRules {
  const canon = names.split(',').map((s) => s.trim()).filter(Boolean);
  const lookup = new Map<string, string>();
  const byCanonical = new Map<string, string[]>();
  for (const n of canon) {
    lookup.set(n.toLowerCase(), n);
    byCanonical.set(n, [n]);
  }
  for (const [alias, target] of parseAliasLines(aliases).pairs) {
    const c = canon.find((n) => n.toLowerCase() === target.toLowerCase()) ?? target;
    lookup.set(alias.toLowerCase(), c);
    lookup.set(c.toLowerCase(), c);
    byCanonical.set(c, [...(byCanonical.get(c) ?? [c]), alias]);
  }
  const entries: BrandRules['entries'] = [];
  for (const [c, spellings] of byCanonical) {
    const parts = spellings.map(phrasePattern).filter((x): x is string => !!x);
    if (parts.length) entries.push({ canonical: c, re: new RegExp(parts.join('|'), 'gi') });
  }
  return { entries, lookup };
}

export interface BrandMatch {
  brand: string | null;
  /** Every distinct brand named in the text (more than one = check by hand). */
  candidates: string[];
  source: 'SOURCE_FIELD' | 'TEXT' | 'NONE';
}

/**
 * The brand of an imported item: the source's own brand field (mapped through
 * the aliases), else the brand named EARLIEST in the title as a whole word.
 */
export function matchBrand(sourceBrand: string | null | undefined, title: string, rules: BrandRules): BrandMatch {
  const fromField = (sourceBrand ?? '').trim();
  const found: Array<{ c: string; at: number; len: number }> = [];
  for (const e of rules.entries) {
    e.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = e.re.exec(title))) {
      found.push({ c: e.canonical, at: m.index, len: m[0].length });
      if (m[0].length === 0) e.re.lastIndex++;
    }
  }
  found.sort((a, b) => a.at - b.at || b.len - a.len);
  const candidates = Array.from(new Set(found.map((f) => f.c)));
  if (fromField && !/^(other|others|generic|unknown|misc|various|n\/?a|-|—)$/i.test(fromField)) {
    return { brand: rules.lookup.get(fromField.toLowerCase()) ?? fromField, candidates, source: 'SOURCE_FIELD' };
  }
  if (!found.length) return { brand: null, candidates, source: 'NONE' };
  return { brand: found[0].c, candidates, source: 'TEXT' };
}

export function parseCategoryRules(text: string): { rules: CategoryRule[]; errors: string[] } {
  const rules: CategoryRule[] = [];
  const errors: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([a-z0-9][a-z0-9-]*)\s*:\s*(.+)$/i);
    if (!m) {
      errors.push(`line ${i + 1} (“${t.slice(0, 40)}”) is not “category-slug: keyword, keyword”`);
      continue;
    }
    const re = phrasesRegex(m[2]);
    if (!re) {
      errors.push(`line ${i + 1} has no keywords`);
      continue;
    }
    rules.push({ slug: m[1].toLowerCase(), re });
  }
  return { rules, errors };
}

/** First rule whose keywords appear (whole words) in the title or the source's category names. */
export function matchCategory(title: string, sourceCategories: string, rules: CategoryRule[], known?: (slug: string) => boolean): string | null {
  const hay = `${title} ${sourceCategories}`;
  for (const r of rules) {
    if (known && !known(r.slug)) continue;
    if (r.re.test(hay)) return r.slug;
  }
  return null;
}

export function parseConditionWords(text: string): ConditionWords {
  const rules: ConditionWords['rules'] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(NEW|REFURBISHED|USED)\s*:\s*(.+)$/i);
    if (!m) continue;
    const re = phrasesRegex(m[2]);
    if (re) rules.push({ code: m[1].toUpperCase() as ConditionCode, re });
  }
  return { rules };
}

/**
 * The conditions a text states ("Brand New", "For sale: Refurbished …").
 * NEW and REFURBISHED win over USED (a refurbished unit is also "used").
 */
export function conditionsStated(text: string, words: ConditionWords): ConditionCode[] {
  const out: ConditionCode[] = [];
  for (const r of words.rules) if (r.re.test(text) && !out.includes(r.code)) out.push(r.code);
  if (out.length > 1 && out.includes('USED')) return out.filter((c) => c !== 'USED');
  return out;
}

/** A grade that its own title / text contradicts: the condition the text states instead, or null. */
export function conditionConflict(grade: ConditionCode, title: string, text: string, words: ConditionWords): ConditionCode | null {
  // The title is the strongest statement; the text is read only when the title says nothing.
  const fromTitle = conditionsStated(title, words);
  const stated = fromTitle.length ? fromTitle : conditionsStated(text, words);
  if (!stated.length || stated.includes(grade)) return null;
  return stated.length === 1 ? stated[0] : null;
}
