/**
 * Settings → Import & suppliers as one typed object for the sync engine, the
 * catalog audit and the cleanup scripts. Pure builder (`importSettingsFrom`)
 * + a server loader (`getImportSettings`) that reads the registry (DB > .env >
 * default).
 */
import { ensureSettingsLoaded } from '@/lib/settings';
import {
  brandRulesFrom,
  cleanRulesFrom,
  DEFAULT_BRAND_ALIASES,
  DEFAULT_BRAND_NAMES,
  DEFAULT_CATEGORY_RULES,
  DEFAULT_CLAIM_PHRASES,
  DEFAULT_CONDITION_WORDS,
  DEFAULT_TAIL_SECTIONS,
  parseCategoryRules,
  parseConditionWords,
  type BrandRules,
  type CategoryRule,
  type CleanRules,
  type ConditionWords,
} from './import-rules';

export interface ImportSettings {
  clean: CleanRules;
  /** The same rules with claims always on — what the audit detects in REVIEW mode. */
  detect: CleanRules;
  claimMode: 'REMOVE' | 'REVIEW';
  brands: BrandRules;
  categories: CategoryRule[];
  unmappedAction: 'REVIEW' | 'ALLOW';
  fallbackCategorySlug: string | null;
  conditionWords: ConditionWords;
  conditionTextAction: 'REVIEW' | 'USE_TEXT' | 'IGNORE';
  /** Basis points: 3000 = 30 %. */
  priceDropReviewBp: number;
  priceRiseReviewBp: number;
  priceReviewHold: boolean;
  archiveStopBp: number;
  archiveStopAllow: number;
  backorderSellable: boolean;
  sourceTimeoutMs: number;
  runLockMinutes: number;
  reportsKeep: number;
  photoMaxBytes: number;
}

function pctBp(raw: string, d: number, min: number, max: number): number {
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) && raw.trim() !== '' && n >= min && n <= max ? Math.round(n * 100) : Math.round(d * 100);
}

export function importSettingsFrom(get: (key: string) => string): ImportSettings {
  const read = (k: string) => (get(k) ?? '').replace(/\r\n/g, '\n').trim();
  const int = (k: string, d: number, min: number, max: number) => {
    const n = parseInt(read(k), 10);
    return Number.isInteger(n) && n >= min && n <= max ? n : d;
  };
  const enumOf = <T extends string>(k: string, allowed: readonly T[], d: T): T =>
    (allowed as readonly string[]).includes(read(k)) ? (read(k) as T) : d;
  const claimMode = enumOf('IMPORT_CLAIM_MODE', ['REMOVE', 'REVIEW'] as const, 'REMOVE');
  const claimPhrases = read('IMPORT_CLAIM_PHRASES') || DEFAULT_CLAIM_PHRASES;
  const tails = read('IMPORT_TAIL_SECTIONS') || DEFAULT_TAIL_SECTIONS;
  const stripPrices = read('IMPORT_STRIP_PRICES') !== 'false';
  const categories = parseCategoryRules(read('IMPORT_CATEGORY_RULES') || DEFAULT_CATEGORY_RULES).rules;
  const fallback = read('IMPORT_FALLBACK_CATEGORY');
  return {
    clean: cleanRulesFrom({ claimPhrases, tailSections: tails, stripPrices, removeClaims: claimMode === 'REMOVE' }),
    detect: cleanRulesFrom({ claimPhrases, tailSections: tails, stripPrices: true, removeClaims: true }),
    claimMode,
    brands: brandRulesFrom(read('IMPORT_BRAND_NAMES') || DEFAULT_BRAND_NAMES, read('IMPORT_BRAND_ALIASES') || DEFAULT_BRAND_ALIASES),
    categories,
    unmappedAction: enumOf('IMPORT_UNMAPPED_ACTION', ['REVIEW', 'ALLOW'] as const, 'REVIEW'),
    fallbackCategorySlug: /^[a-z0-9][a-z0-9-]*$/.test(fallback) ? fallback : null,
    conditionWords: parseConditionWords(read('CONDITION_TEXT_WORDS') || DEFAULT_CONDITION_WORDS),
    conditionTextAction: enumOf('IMPORT_CONDITION_TEXT_ACTION', ['REVIEW', 'USE_TEXT', 'IGNORE'] as const, 'REVIEW'),
    priceDropReviewBp: pctBp(read('SYNC_PRICE_DROP_REVIEW_PCT'), 30, 1, 100),
    priceRiseReviewBp: pctBp(read('SYNC_PRICE_RISE_REVIEW_PCT'), 50, 1, 900),
    priceReviewHold: read('SYNC_PRICE_REVIEW_HOLD') !== 'KEEP',
    archiveStopBp: pctBp(read('SYNC_ARCHIVE_STOP_PCT'), 10, 1, 100),
    archiveStopAllow: int('SYNC_ARCHIVE_STOP_ALLOW', 3, 0, 1000),
    backorderSellable: read('SYNC_BACKORDER_MODE') === 'SELLABLE',
    sourceTimeoutMs: int('SYNC_SOURCE_TIMEOUT_SECONDS', 45, 5, 300) * 1000,
    runLockMinutes: int('SYNC_RUN_LOCK_MINUTES', 30, 5, 720),
    reportsKeep: int('SYNC_REPORTS_KEEP', 100, 10, 2000),
    photoMaxBytes: int('IMPORT_PHOTO_MAX_MB', 20, 1, 100) * 1024 * 1024,
  };
}

/** The defaults (no settings stored) — for unit tests and offline scripts. */
export const DEFAULT_IMPORT_SETTINGS: ImportSettings = importSettingsFrom(() => '');

export async function getImportSettings(): Promise<ImportSettings> {
  await ensureSettingsLoaded();
  return importSettingsFrom((k) => process.env[k] ?? '');
}
