/**
 * Category slugs (the ?category=… in every category link). Latin names keep
 * their letters and digits; names in Persian / Arabic, Cyrillic or Greek are
 * transliterated, so “دستگاه کروماتوگرافی” gets a readable Latin slug instead
 * of the old “category”. A name with nothing to transliterate (e.g. Chinese)
 * gives '' — the form then asks for the slug. Pure.
 */
const PERSIAN: Record<string, string> = {
  'ا': 'a', 'آ': 'a', 'أ': 'a', 'إ': 'e', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 's', 'ج': 'j', 'چ': 'ch', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'ژ': 'zh', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z', 'ع': '',
  'غ': 'gh', 'ف': 'f', 'ق': 'gh', 'ک': 'k', 'ك': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm', 'ن': 'n', 'و': 'v', 'ؤ': 'o', 'ه': 'h',
  'ة': 'h', 'ی': 'i', 'ي': 'i', 'ى': 'a', 'ئ': 'y', 'ء': '',
};
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e',
  ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};
const GREEK: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p',
  ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};
// Persian (۰–۹) and Arabic-Indic (٠–٩) digits
const DIGITS = '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩';

/** The name as a slug: lowercase Latin letters, digits and single hyphens (max 70), or '' when nothing is left. */
export function categorySlug(name: string): string {
  let out = '';
  for (const ch of name.normalize('NFKD').toLowerCase()) {
    const d = DIGITS.indexOf(ch);
    if (d >= 0) out += String(d % 10);
    else if (ch in PERSIAN) out += PERSIAN[ch];
    else if (ch in CYRILLIC) out += CYRILLIC[ch];
    else if (ch in GREEK) out += GREEK[ch];
    else if (ch === 'ß') out += 'ss';
    else if (ch === 'æ') out += 'ae';
    else if (ch === 'ø') out += 'o';
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else if (/[\p{M}\p{Cf}]/u.test(ch)) continue;   // accents left by NFKD (é → e), Arabic short vowels, the zero-width non-joiner
    else out += '-';
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 70).replace(/-$/, '');
}

/** A slug typed by hand: the same alphabet, or null when it has none of it. */
export function cleanSlugInput(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
  return s ? s : null;
}
