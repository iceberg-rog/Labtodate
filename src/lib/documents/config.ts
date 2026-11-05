import { readEntry, saveEntry, type Actor } from '@/lib/cms/store';
import { checkText } from '@/lib/cms/text';
import { DEFAULT_VAT_SETTINGS, type VatSettings } from '@/lib/tax/vat';
import { DEFAULT_GENERAL, DEFAULT_LABELS, DEFAULT_TEXTS, defaultOptions, LABEL_FIELDS } from './defaults';
import { checkPattern, DEFAULT_NUMBERING, type NumberingSettings } from './numbering';
import { fieldsFor, LABEL_EXTRA_FIELDS } from './vars';
import { DOC_KINDS, LANGS, type CommonLabels, type DocKind, type DocOptions, type DocTexts, type GeneralDocSettings, type Lang } from './types';

/**
 * Admin-editable document configuration, stored in the versioned content
 * store (lib/cms/store). Every reader merges the stored JSON over the
 * built-in defaults, so a field added in a later release has a value even on
 * an install that saved its templates before.
 */

export const KEY = {
  texts: (kind: DocKind, lang: Lang) => `doc:texts:${kind}:${lang}`,
  labels: (lang: Lang) => `doc:labels:${lang}`,
  options: (kind: DocKind) => `doc:options:${kind}`,
  general: 'doc:general',
  vat: 'settings:vat',
  numbering: 'settings:numbering',
} as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Stored values of the default's keys, type-checked against the default. */
function merge<T extends object>(defaults: T, stored: unknown): T {
  if (!isObj(stored)) return { ...defaults };
  const out = { ...defaults } as Record<string, unknown>;
  for (const [k, def] of Object.entries(defaults)) {
    const v = stored[k];
    if (v === undefined || v === null) continue;
    if (isObj(def)) out[k] = merge(def as object, v);
    else if (typeof v === typeof def) out[k] = v;
  }
  return out as T;
}

export async function getTexts(kind: DocKind, lang: Lang): Promise<DocTexts> {
  return merge(DEFAULT_TEXTS[kind][lang], await readEntry(KEY.texts(kind, lang)));
}
export async function getLabels(lang: Lang): Promise<CommonLabels> {
  return merge(DEFAULT_LABELS[lang], await readEntry(KEY.labels(lang)));
}
export async function getOptions(kind: DocKind): Promise<DocOptions> {
  return merge(defaultOptions(kind), await readEntry(KEY.options(kind)));
}
export async function getGeneral(): Promise<GeneralDocSettings> {
  return merge(DEFAULT_GENERAL, await readEntry(KEY.general));
}
export async function getVatSettings(): Promise<VatSettings> {
  return merge(DEFAULT_VAT_SETTINGS, await readEntry(KEY.vat));
}
export async function getNumbering(): Promise<NumberingSettings> {
  const n = merge(DEFAULT_NUMBERING, await readEntry(KEY.numbering));
  // Keep the order pattern available to the synchronous order-number helper.
  (globalThis as unknown as { __orderPattern?: string }).__orderPattern = n.ORDER.pattern;
  return n;
}

// ─── Validation + save ─────────────────────────────────────────────────

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(problems.join(' · '));
  }
}

const TEXT_FIELDS: { key: keyof DocTexts; label: string; rich: boolean; max: number; kinds?: DocKind[] }[] = [
  { key: 'title', label: 'Title', rich: false, max: 60 },
  { key: 'titleUnpaid', label: 'Title while not paid', rich: false, max: 60, kinds: ['INVOICE'] },
  { key: 'numberLabel', label: 'Number label', rich: false, max: 40 },
  { key: 'stamp', label: 'Stamp', rich: false, max: 30 },
  { key: 'stampUnpaid', label: 'Stamp while not paid', rich: false, max: 30, kinds: ['INVOICE'] },
  { key: 'greeting', label: 'Greeting', rich: false, max: 120 },
  { key: 'greetingFallback', label: 'Greeting when no name is known', rich: false, max: 120 },
  { key: 'intro', label: 'Intro text', rich: true, max: 2000 },
  { key: 'paymentTerms', label: 'Payment terms', rich: true, max: 2000 },
  { key: 'closing', label: 'Closing text', rich: true, max: 2000 },
  { key: 'footer', label: 'Footer / legal lines', rich: true, max: 1500 },
];

export function textFieldsFor(kind: DocKind) {
  return TEXT_FIELDS.filter((f) => !f.kinds || f.kinds.includes(kind));
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : '';
}

export function cleanTexts(kind: DocKind, input: Record<string, unknown>): DocTexts {
  const allowed = fieldsFor(kind).map((f) => f.name);
  const out = { ...DEFAULT_TEXTS[kind].en } as Record<string, string>;
  const problems: string[] = [];
  for (const f of textFieldsFor(kind)) {
    const v = str(input[f.key], f.max + 1);
    out[f.key] = v;
    problems.push(...checkText(f.label, v, allowed, { required: f.key === 'title' || f.key === 'numberLabel', max: f.max }));
  }
  if (problems.length) throw new ConfigError(problems);
  return out as unknown as DocTexts;
}

export function cleanLabels(input: Record<string, unknown>): CommonLabels {
  const allowed = [...fieldsFor().map((f) => f.name), ...LABEL_EXTRA_FIELDS];
  const out = { ...DEFAULT_LABELS.en } as Record<string, string>;
  const problems: string[] = [];
  for (const f of LABEL_FIELDS) {
    const max = f.rich ? 800 : 120;
    const v = str(input[f.key], max + 1);
    out[f.key] = v;
    problems.push(...checkText(f.label, v, allowed, { required: !f.rich && f.key !== 'voidStamp', max }));
  }
  if (out.page && !out.page.includes('{PAGE}')) problems.push('Page numbers: keep {PAGE} (and optionally {PAGES}) in the text.');
  if (problems.length) throw new ConfigError(problems);
  return out as unknown as CommonLabels;
}

function bool(v: unknown): boolean {
  return v === true || v === 'on' || v === 'true' || v === '1';
}

function int(v: unknown, label: string, min: number, max: number, problems: string[]): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${label}: a whole number from ${min} to ${max}.`);
    return min;
  }
  return n;
}

export function cleanOptions(kind: DocKind, input: Record<string, unknown>): DocOptions {
  const problems: string[] = [];
  const days =
    kind === 'RECEIPT'
      ? 0
      : int(input.days, kind === 'QUOTE' ? 'Validity (days)' : 'Payment term (days)', kind === 'QUOTE' ? 1 : 0, 365, problems);
  if (problems.length) throw new ConfigError(problems);
  return {
    showLogo: bool(input.showLogo),
    showSignature: bool(input.showSignature),
    showCustomerNo: bool(input.showCustomerNo),
    showBankDetails: bool(input.showBankDetails),
    showGreeting: bool(input.showGreeting),
    days,
  };
}

export function cleanGeneral(input: Record<string, unknown>): GeneralDocSettings {
  const problems: string[] = [];
  const accent = String(input.accent ?? '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) problems.push('Accent colour: use a hex colour like #0E4F40.');
  const lang = input.defaultLang === 'nl' ? 'nl' : input.defaultLang === 'en' ? 'en' : null;
  if (!lang) problems.push('Default language: English or Dutch.');
  const ship = Number(String(input.cartShippingEur ?? '0').replace(',', '.'));
  if (!Number.isFinite(ship) || ship < 0 || ship > 100_000) problems.push('Cart shipping: an amount in euro from 0 to 100,000.');
  if (problems.length) throw new ConfigError(problems);
  return {
    defaultLang: lang as Lang,
    accent: accent.toUpperCase(),
    readiness: input.readiness === 'BLOCK' ? 'BLOCK' : 'WARN',
    receiptEnabled: bool(input.receiptEnabled),
    attachInvoice: bool(input.attachInvoice),
    billingCopy: bool(input.billingCopy),
    cartShippingCents: Math.round(ship * 100),
  };
}

export function cleanVat(input: Record<string, unknown>): VatSettings {
  const problems: string[] = [];
  const home = String(input.homeCountry ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(home)) problems.push('Home country: a two-letter country code, e.g. NL.');
  const rate = Number(String(input.standardRatePct ?? '').replace(',', '.'));
  if (!Number.isFinite(rate) || rate < 0 || rate > 50) problems.push('Standard rate: a percentage from 0 to 50.');
  const def = String(input.defaultTreatment ?? '');
  if (!['DOMESTIC', 'REVERSE_CHARGE', 'EXPORT'].includes(def)) problems.push('Default treatment: pick one of the options.');
  const vd = String(input.viesDownPolicy ?? '');
  if (!['HOLD', 'CHARGE_HOME', 'BLOCK'].includes(vd)) problems.push('When VIES is down: pick one of the options.');
  if (problems.length) throw new ConfigError(problems);
  return {
    homeCountry: home,
    standardRatePct: Math.round(rate * 100) / 100,
    defaultTreatment: def as VatSettings['defaultTreatment'],
    autoDecide: bool(input.autoDecide),
    reverseChargeEnabled: bool(input.reverseChargeEnabled),
    requireVies: bool(input.requireVies),
    viesDownPolicy: vd as VatSettings['viesDownPolicy'],
    exportZeroEnabled: bool(input.exportZeroEnabled),
    allowOverride: bool(input.allowOverride),
  };
}

export function cleanNumbering(input: Record<string, unknown>): NumberingSettings {
  const problems: string[] = [];
  const receiptUsesInvoice = bool(input.RECEIPT_useInvoiceNumber);
  const series = (k: 'QUOTE' | 'INVOICE' | 'RECEIPT') => {
    const d = {
      pattern: String(input[`${k}_pattern`] ?? '').trim(),
      start: int(input[`${k}_start`], `${k.charAt(0)}${k.slice(1).toLowerCase()} start number`, 1, 99_999_999, problems),
      yearlyReset: bool(input[`${k}_yearlyReset`]),
    };
    // An unused receipt series (receipts carry the invoice number) is not checked.
    if (!(k === 'RECEIPT' && receiptUsesInvoice)) problems.push(...checkPattern(k, d));
    return d;
  };
  const out: NumberingSettings = {
    QUOTE: series('QUOTE'),
    INVOICE: series('INVOICE'),
    RECEIPT: { ...series('RECEIPT'), useInvoiceNumber: receiptUsesInvoice },
    ORDER: { pattern: String(input.ORDER_pattern ?? '').trim() },
  };
  problems.push(...checkPattern('ORDER', out.ORDER));
  if (problems.length) throw new ConfigError(problems);
  return out;
}

export async function saveConfig(key: string, data: unknown, actor: Actor, note?: string): Promise<number> {
  return saveEntry(key, data, actor, note);
}

/** Every key the History tab covers, with a readable name. */
export function configKeys(): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const kindLabel: Record<DocKind, string> = { QUOTE: 'Quote', INVOICE: 'Invoice', RECEIPT: 'Receipt' };
  for (const kind of DOC_KINDS) {
    for (const lang of LANGS) out.push({ key: KEY.texts(kind, lang), label: `${kindLabel[kind]} texts (${lang.toUpperCase()})` });
    out.push({ key: KEY.options(kind), label: `${kindLabel[kind]} options` });
  }
  for (const lang of LANGS) out.push({ key: KEY.labels(lang), label: `Shared labels (${lang.toUpperCase()})` });
  out.push({ key: KEY.general, label: 'General document settings' });
  out.push({ key: KEY.vat, label: 'VAT rules' });
  out.push({ key: KEY.numbering, label: 'Numbering' });
  out.push({ key: 'settings:company', label: 'Company & bank' });
  return out;
}
