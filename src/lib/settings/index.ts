import { prisma } from '../db';
import {
  SETTING_DEFS,
  displayValue,
  maskSecret,
  normaliseInput,
  settingDef,
  validateSettingValue,
  type SettingDefinition,
} from './defs';

export {
  SETTING_DEFS,
  SETTING_GROUPS,
  PANEL_GROUPS,
  settingDef,
  isSecurityPolicyKey,
  validateSettingValue,
  normaliseInput,
  displayValue,
  isValidIban,
  type SettingDefinition,
  type SettingGroup,
  type SettingKey,
  type SettingType,
} from './defs';

/**
 * Runtime side of the settings registry (B00).
 *
 * Effective value of a key:  DB row  >  server .env (as it was at boot)  >
 * registry default (defs.ts)  >  ''.
 *
 * DB values are hydrated into process.env (5 s cache) so older code that reads
 * process.env directly keeps working; new code uses the typed getters below
 * (`settingInt`, `settingBool`, …) AFTER `await ensureSettingsLoaded()`, or the
 * per-domain loaders (lib/tax/settings.ts, lib/documents/settings.ts …).
 *
 * Every save writes one SettingChange row per changed key (secrets masked),
 * with the actor, IP and user agent — the admin "Change history" + "Revert".
 */

declare global {
  var __settingEnvDefaults: Record<string, string | undefined> | undefined;
}

// .env values as they were at boot, before ensureSettingsLoaded copied any DB
// override over them — so clearing a DB value falls back to the .env default
// instead of leaving the stale DB value live (or wiping .env until restart).
// Kept on globalThis: the bundler can evaluate this module more than once per
// process, and a later copy would otherwise snapshot DB values as "defaults".
// Only this module writes these keys, so the first snapshot is the real .env.
const ENV_DEFAULTS: Record<string, string | undefined> = (globalThis.__settingEnvDefaults ??=
  Object.fromEntries(SETTING_DEFS.map((d) => [d.key, process.env[d.key]])));

/** The server .env value for a setting key ('' when .env doesn't set it). */
function envDefault(key: string): string {
  return (ENV_DEFAULTS[key] ?? '').replace(/\r\n/g, '\n').trim();
}

/** What the key falls back to without a DB row: .env, else the registry default. */
export function baselineValue(key: string): string {
  return envDefault(key) || (settingDef(key)?.default ?? '');
}

/** Put the boot-time .env value back into process.env (or unset it). */
function restoreEnvDefault(key: string): void {
  const def = ENV_DEFAULTS[key];
  if (def !== undefined) process.env[key] = def;
  else delete process.env[key];
}

/** A path on this site ("/media/…"), as an uploaded logo is stored — not a
 *  protocol-relative "//host/…" (or "/\host/…") URL. Save and Verify share
 *  this rule, so a value Save accepts is one Verify can check. */
export function isSiteRelativePath(value: string): boolean {
  return /^\/(?![/\\])/.test(value);
}

let lastLoad = 0;
let inflight: Promise<void> | null = null;
const TTL_MS = 5000;

/** Idempotent, cheap (5s cache): copy DB settings into process.env. */
export async function ensureSettingsLoaded(): Promise<void> {
  if (Date.now() - lastLoad < TTL_MS) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await prisma.setting.findMany();
      const stored = new Set<string>();
      for (const r of rows) {
        if (r.value && r.value.trim()) {
          process.env[r.key] = r.value;
          stored.add(r.key);
        }
      }
      // A setting whose DB row is gone (cleared from another worker, or by
      // hand) falls back to its .env default instead of keeping the old value.
      for (const d of SETTING_DEFS) {
        if (!stored.has(d.key)) restoreEnvDefault(d.key);
      }
      lastLoad = Date.now();
    } catch {
      /* table may not exist yet on first boot — ignore */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Force the next ensureSettingsLoaded() to re-read the DB (tests, scripts). */
export function invalidateSettingsCache(): void {
  lastLoad = 0;
}

// ── typed getters (sync; call ensureSettingsLoaded() first) ──────────────────

/** Effective raw value: hydrated DB/env value, else the registry default. */
export function settingRaw(key: string): string {
  const v = (process.env[key] ?? '').trim();
  return v || (settingDef(key)?.default ?? '');
}

export function settingString(key: string): string {
  return settingRaw(key);
}

export function settingInt(key: string, fallback?: number): number {
  const d = settingDef(key);
  const parse = (s: string) => (/^-?\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
  let n = parse(settingRaw(key));
  if (!Number.isFinite(n) || (d?.min !== undefined && n < d.min) || (d?.max !== undefined && n > d.max)) {
    n = parse(d?.default ?? '');
  }
  if (!Number.isFinite(n)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Setting ${key} has no valid integer value.`);
  }
  return n;
}

/** Optional int: null when the setting is empty / invalid. */
export function settingIntOrNull(key: string): number | null {
  const raw = settingRaw(key);
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

export function settingBool(key: string): boolean {
  const raw = settingRaw(key).toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return (settingDef(key)?.default ?? 'false') === 'true';
}

export function settingEnum<T extends string>(key: string): T {
  const d = settingDef(key);
  const raw = settingRaw(key);
  if (d?.options?.some((o) => o.value === raw)) return raw as T;
  return (d?.default ?? raw) as T;
}

/** Percent setting ("21", "25.5") as integer basis points (2100, 2550). */
export function settingPercentBp(key: string): number {
  const d = settingDef(key);
  const parse = (s: string) => (/^\d{1,3}(\.\d{1,2})?$/.test(s.trim()) ? Math.round(Number(s.trim()) * 100) : NaN);
  let bp = parse(settingRaw(key));
  if (!Number.isFinite(bp)) bp = parse(d?.default ?? '0');
  return Number.isFinite(bp) ? bp : 0;
}

export function settingList(key: string): string[] {
  return settingRaw(key).split(',').map((s) => s.trim()).filter(Boolean);
}

// ── admin page support ───────────────────────────────────────────────────────

export type SettingSource = 'db' | 'env' | 'default' | 'unset';

export interface SettingState {
  key: string;
  /** Effective stored value. */
  value: string;
  /** The same in the unit the admin form shows (money in euros). */
  display: string;
  source: SettingSource;
  baseline: string;
}

/** Current effective values (DB overrides env, env overrides the registry default). Secrets are NOT masked here. */
export async function getEffectiveSettings(): Promise<Record<string, string>> {
  const rows = await prisma.setting.findMany();
  const db = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out: Record<string, string> = {};
  for (const d of SETTING_DEFS) out[d.key] = (db[d.key] || '').trim() || envDefault(d.key) || d.default || '';
  return out;
}

export async function getSettingStates(): Promise<Record<string, SettingState>> {
  const rows = await prisma.setting.findMany();
  const db = new Map(rows.map((r) => [r.key, (r.value ?? '').trim()]));
  const out: Record<string, SettingState> = {};
  for (const d of SETTING_DEFS) {
    const dbv = db.get(d.key) ?? '';
    const env = envDefault(d.key);
    const value = dbv || env || d.default || '';
    const source: SettingSource = dbv ? 'db' : env ? 'env' : d.default ? 'default' : 'unset';
    out[d.key] = { key: d.key, value, display: displayValue(d, value), source, baseline: env || d.default || '' };
  }
  return out;
}

/** Keys whose effective value comes from the server .env (no DB override) —
 *  emptying such a field can't clear it; the settings page says so. */
export async function getEnvOnlySettingKeys(): Promise<Set<string>> {
  const rows = await prisma.setting.findMany({ select: { key: true, value: true } });
  const inDb = new Set(rows.filter((r) => r.value?.trim()).map((r) => r.key));
  return new Set(SETTING_DEFS.filter((d) => !inDb.has(d.key) && envDefault(d.key)).map((d) => d.key));
}

/** What a save did, so the settings page can say it truthfully. Labels. */
export type SaveSettingsResult = {
  /** Fields whose effective value changed (set, replaced or removed). */
  changed: string[];
  /** Fields that now follow the server .env value (override removed). */
  envDefault: string[];
  /** Fields that now follow the registry default — no .env value exists (override removed). */
  registryDefault: string[];
  /** Emptied fields whose value comes only from .env, so nothing was removed. */
  envKept: string[];
  /** Keys (not labels) whose effective value changed. */
  changedKeys: string[];
  /** Changed keys flagged `sensitive` (bank, identity, tax, numbering). */
  sensitiveChanged: string[];
};

export type SettingActor = {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  source?: 'ADMIN' | 'REVERT' | 'SYSTEM';
};

/**
 * Cross-row rules that need the DB. Return a reason or null.
 * - A series' start number is locked once that series issued a document in the
 *   current fiscal year (changing it then would break the gap-free sequence).
 */
async function guardProblem(d: SettingDefinition, value: string, current: string): Promise<string | null> {
  const series: Record<string, string> = {
    INVOICE_START_NUMBER: 'INVOICE',
    CREDIT_NOTE_START_NUMBER: 'CREDIT_NOTE',
    PROFORMA_START_NUMBER: 'PROFORMA',
  };
  if (series[d.key] && value !== current) {
    const { currentFiscalYear } = await import('../documents/numbering');
    const fy = currentFiscalYear(new Date());
    // fiscalYear 0 = one continuous sequence (NUMBERING_RESET_YEARLY = No).
    const used = await prisma.invoiceSequence.findFirst({
      where: { series: series[d.key], fiscalYear: { in: [fy, 0] } },
      select: { nextValue: true },
    });
    if (used) {
      return `locked — the ${series[d.key].toLowerCase().replace('_', ' ')} series for fiscal year ${fy} already started (next number ${used.nextValue}). It applies to the next fiscal year only if numbering restarts yearly.`;
    }
  }
  return null;
}

/** Numbering rules across keys (lib/documents/numbering.ts), for a proposed save. */
async function numberingProblems(input: Record<string, string>, normalised: Map<string, string>, inDb: Map<string, string>): Promise<string[]> {
  const { NUMBERING_KEYS, numberingFromValues, numberingConfigProblems, numberingLockProblems } = await import('../documents/numbering');
  const touched = NUMBERING_KEYS.some((k) => input[k] !== undefined || input[`__clear_${k}`] === 'on');
  if (!touched) return [];
  const currentVals: Record<string, string> = {};
  const nextVals: Record<string, string> = {};
  for (const k of NUMBERING_KEYS) {
    const cur = (inDb.get(k) ?? '').trim() || baselineValue(k);
    currentVals[k] = cur;
    const cleared = input[`__clear_${k}`] === 'on' || (input[k] !== undefined && (normalised.get(k) ?? '') === '');
    nextVals[k] = cleared ? baselineValue(k) : input[k] !== undefined ? normalised.get(k) ?? cur : cur;
  }
  const before = numberingFromValues(currentVals);
  const after = numberingFromValues(nextVals);
  const out = numberingConfigProblems(after).map((p) => `Numbering: ${p}`);
  const started = await prisma.invoiceSequence.findMany({
    where: { series: { in: ['INVOICE', 'CREDIT_NOTE', 'PROFORMA'] } },
    orderBy: [{ series: 'asc' }, { fiscalYear: 'desc' }],
    select: { series: true, fiscalYear: true, nextValue: true },
  });
  out.push(...numberingLockProblems(before, after, started).map((p) => `Numbering: ${p}`));
  return out;
}

/**
 * The value `key` will have once `input` is saved, as saveSettings applies it:
 * a cleared or emptied field falls back to .env / the registry default (an
 * empty secret keeps its value); a field not in the form keeps `current`.
 */
export function valueAfterSave(key: string, input: Record<string, string>, current: (key: string) => string): string {
  const d = settingDef(key);
  if (!d) return '';
  if (input[`__clear_${key}`] === 'on') return baselineValue(key);
  const raw = input[key];
  if (raw === undefined) return current(key);
  const value = normaliseInput(d, raw);
  if (value) return value;
  return d.secret ? current(key) : baselineValue(key);
}

export async function saveSettings(input: Record<string, string>, actor: SettingActor = {}): Promise<SaveSettingsResult> {
  // A set Resend key overrides SMTP, so an autofilled login password in that
  // field silently breaks all email. Real keys start with "re_"; reject anything
  // else before writing so a bad submit changes nothing.
  const resendKey = (input.RESEND_API_KEY ?? '').trim();
  if (resendKey && input.__clear_RESEND_API_KEY !== 'on' && !resendKey.startsWith('re_')) {
    throw new Error('Resend API key must start with "re_" (browser autofill?). Empty that field and save again.');
  }

  const rows = await prisma.setting.findMany({
    where: { key: { in: SETTING_DEFS.map((d) => d.key) } },
    select: { key: true, value: true },
  });
  const inDb = new Map(rows.map((r) => [r.key, r.value]));

  // Type checks (numbers, emails, URLs, enums, cross-row guards) — every field
  // first, so a bad submit changes nothing.
  const problems: string[] = [];
  const normalised = new Map<string, string>();
  const stored = (key: string) => (inDb.get(key) ?? '').trim() || baselineValue(key);
  // Rules that read another key (the KvK format follows the VAT home country)
  // see that key as it will be after this save.
  const ctx = { value: (key: string) => valueAfterSave(key, input, stored) };
  for (const d of SETTING_DEFS) {
    const raw = input[d.key];
    const clearing = input[`__clear_${d.key}`] === 'on' || (raw !== undefined && !d.secret && normaliseInput(d, raw) === '');
    // A required key (legal identity, IBAN) can be changed but not emptied —
    // not even back to a .env value: that fallback is not the registered name
    // or account the documents carry now. (Only from .env: emptying changes nothing.)
    if (clearing && d.required && (inDb.get(d.key) ?? '').trim()) {
      problems.push(`${d.label}: required on the documents — it can be changed but not emptied (enter the correct value instead).`);
      continue;
    }
    if (input[`__clear_${d.key}`] === 'on') continue;
    if (raw === undefined) continue;
    const value = normaliseInput(d, raw);
    normalised.set(d.key, value);
    if (!value) continue; // emptied: the override is removed below (falls back to .env / default)
    const why = validateSettingValue(d, value, ctx);
    if (why) {
      problems.push(`${d.label}: ${why}`);
      continue;
    }
    const guard = await guardProblem(d, value, stored(d.key));
    if (guard) problems.push(`${d.label}: ${guard}`);
  }
  // Cross-key rules of the document numbering (prefixes, format, year reset,
  // fiscal year): judged on the configuration as it would be after this save.
  problems.push(...(await numberingProblems(input, normalised, inDb)));
  if (problems.length) throw new Error(`${problems.join(' · ')} Nothing was saved.`);

  const result: SaveSettingsResult = { changed: [], envDefault: [], registryDefault: [], envKept: [], changedKeys: [], sensitiveChanged: [] };
  const history: Array<{ key: string; oldValue: string | null; newValue: string | null; secret: boolean }> = [];
  const record = (d: SettingDefinition, before: string, after: string) => {
    if (before === after) return;
    result.changed.push(d.label);
    result.changedKeys.push(d.key);
    if (d.sensitive) result.sensitiveChanged.push(d.key);
    history.push({
      key: d.key,
      oldValue: d.secret ? maskSecret(before) : before || null,
      newValue: d.secret ? maskSecret(after) : after || null,
      secret: d.secret,
    });
  };

  for (const d of SETTING_DEFS) {
    const clear = input[`__clear_${d.key}`] === 'on';
    const raw = input[d.key];
    const value = normalised.get(d.key) ?? '';
    const base = baselineValue(d.key);
    const env = envDefault(d.key);
    const stored = (inDb.get(d.key) ?? '').trim();
    const before = stored || base;
    // Secret fields are never pre-filled, so empty = keep the current value.
    // Plain fields ARE pre-filled with their current value, so an emptied
    // field means "remove the override" (falls back to .env / default).
    if (clear || (raw !== undefined && value === '' && !d.secret)) {
      if (inDb.has(d.key)) {
        await prisma.setting.deleteMany({ where: { key: d.key } });
        restoreEnvDefault(d.key);
        record(d, before, base);
        if (env) result.envDefault.push(d.label);
        else if (base) result.registryDefault.push(d.label);
      } else if (env) {
        result.envKept.push(d.label);
      }
      continue;
    }
    if (raw === undefined || value === '') continue;
    // The fallback value (.env or registry default) is never copied into the
    // DB (that froze it against later changes). Saving it — typed back in, or
    // a pre-filled default submitted untouched — removes any override.
    if (base && value === base) {
      if (inDb.has(d.key)) {
        await prisma.setting.deleteMany({ where: { key: d.key } });
        record(d, before, base);
        if (env) result.envDefault.push(d.label);
        else result.registryDefault.push(d.label);
      }
      restoreEnvDefault(d.key);
      continue;
    }
    if (stored === value) continue; // unchanged
    await prisma.setting.upsert({
      where: { key: d.key },
      update: { value, updatedById: actor.id ?? null },
      create: { key: d.key, value, updatedById: actor.id ?? null },
    });
    process.env[d.key] = value;
    record(d, before, value);
  }

  await writeSettingHistory(history, actor);
  lastLoad = Date.now();
  return result;
}

type HistoryEntry = { key: string; oldValue: string | null; newValue: string | null; secret: boolean };

async function writeSettingHistory(history: HistoryEntry[], actor: SettingActor): Promise<void> {
  if (history.length) {
    await prisma.settingChange.createMany({
      data: history.map((h) => ({
        ...h,
        source: actor.source ?? 'ADMIN',
        actorId: actor.id ?? null,
        actorEmail: actor.email ?? null,
        ip: actor.ip ? actor.ip.slice(0, 80) : null,
        userAgent: actor.userAgent ? actor.userAgent.slice(0, 300) : null,
      })),
    });
  }
}

/**
 * Change history for keys saved by their owner's own action instead of
 * saveSettings (the security policy). `before` / `after` are getSettingStates()
 * snapshots taken around the write; `explicit` holds values written as-is
 * (e.g. an emptied list, which the registry would otherwise show as its default).
 */
export async function recordSettingChanges(
  keys: string[],
  before: Record<string, SettingState>,
  after: Record<string, SettingState>,
  actor: SettingActor,
  explicit: Record<string, string> = {},
): Promise<void> {
  const history: HistoryEntry[] = [];
  for (const key of keys) {
    const d = settingDef(key);
    if (!d) continue;
    const oldValue = before[key]?.value ?? '';
    const newValue = key in explicit ? explicit[key] : (after[key]?.value ?? '');
    if (oldValue === newValue) continue;
    history.push({
      key,
      oldValue: d.secret ? maskSecret(oldValue) : oldValue || null,
      newValue: d.secret ? maskSecret(newValue) : newValue || null,
      secret: d.secret,
    });
  }
  await writeSettingHistory(history, actor);
}

export interface SettingChangeView {
  id: string;
  key: string;
  label: string;
  group: string;
  oldValue: string | null;
  newValue: string | null;
  secret: boolean;
  source: string;
  actorEmail: string | null;
  ip: string | null;
  createdAt: Date;
  /** Revert is offered for non-secret keys whose current value is still `newValue`. */
  revertable: boolean;
}

export async function listSettingChanges(opts: { take?: number; key?: string } = {}): Promise<SettingChangeView[]> {
  const rows = await prisma.settingChange.findMany({
    where: opts.key ? { key: opts.key } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(opts.take ?? 100, 1), 500),
  });
  const states = await getSettingStates();
  return rows.map((r) => {
    const d = settingDef(r.key);
    const current = states[r.key]?.value ?? '';
    return {
      id: r.id,
      key: r.key,
      label: d?.label ?? r.key,
      group: d?.group ?? '—',
      oldValue: d && r.oldValue != null ? displayValue(d, r.oldValue) : r.oldValue,
      newValue: d && r.newValue != null ? displayValue(d, r.newValue) : r.newValue,
      secret: r.secret,
      source: r.source,
      actorEmail: r.actorEmail,
      ip: r.ip,
      createdAt: r.createdAt,
      revertable: !!d && !r.secret && (r.newValue ?? '') === current,
    };
  });
}

/** Put a key back to the value it had before change `changeId` (non-secret only). */
export async function revertSettingChange(changeId: string, actor: SettingActor): Promise<{ ok: boolean; message: string }> {
  const ch = await prisma.settingChange.findUnique({ where: { id: changeId } });
  if (!ch) return { ok: false, message: 'That change no longer exists.' };
  const d = settingDef(ch.key);
  if (!d) return { ok: false, message: `${ch.key} is no longer a setting.` };
  if (ch.secret) return { ok: false, message: 'Secret values are never stored in the history, so they cannot be reverted — enter the old key again.' };
  const states = await getSettingStates();
  if ((states[ch.key]?.value ?? '') !== (ch.newValue ?? '')) {
    return { ok: false, message: `“${d.label}” was changed again after this change — revert the newer change first.` };
  }
  // Submit the old value through the normal save path (validation + history).
  const target = ch.oldValue ?? '';
  const res = await saveSettings({ [ch.key]: displayValue(d, target) }, { ...actor, source: 'REVERT' });
  return res.changedKeys.length
    ? { ok: true, message: `“${d.label}” reverted to ${target ? `“${displayValue(d, target)}”` : 'its default'}.` }
    : { ok: true, message: 'Nothing changed — the value was already the old one.' };
}
