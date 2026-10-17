import { prisma } from '@/lib/db';

/**
 * Security & platform policy — every rule an admin can switch, with a typed
 * default. Stored in the Setting table (same key/value store as the rest of
 * Admin → Settings) and edited on Admin → Settings → Security. A key without a
 * row uses the default below. Shaped like the B00 settings registry
 * ({key, group, type, default, validate}) so it can be folded into it.
 */

import { POLICY_DEFS, type PolicyDef } from './policy-defs';

// The definitions live in ./policy-defs (pure, imported by the settings registry).
export {
  STEP_UP_ACTION_LABELS,
  POLICY_ROLES,
  POLICY_GROUPS,
  POLICY_DEFS,
  type StepUpAction,
  type PolicyDef,
  type PolicyGroup,
} from './policy-defs';

export type SecurityPolicy = {
  TWO_FACTOR_REQUIRED_ROLES: string[];
  ADMIN_MAGIC_LINK_ALLOWED: boolean;
  STEP_UP_ACTIONS: string[];
  STEP_UP_MAX_AGE_MIN: number;
  ONLY_SUPER_ADMIN_CREATES_ADMINS: boolean;
  ADMIN_EMAIL_DOMAINS: string;
  STAFF_INVITE_TTL_HOURS: number;
  ADMIN_SESSION_ABSOLUTE_HOURS: number;
  ADMIN_IDLE_TIMEOUT_MIN: number;
  LOGIN_MAX_FAILS_PER_ACCOUNT_IP: number;
  LOGIN_MAX_FAILS_PER_ACCOUNT: number;
  LOGIN_FAIL_WINDOW_MIN: number;
  LOCKOUT_BASE_MINUTES: number;
  LOCKOUT_MAX_MINUTES: number;
  IP_SIGNIN_LIMIT_PER_15MIN: number;
  LOCKOUT_EMAIL_ENABLED: boolean;
  NEW_DEVICE_ALERT: boolean;
  CAPTCHA_ALWAYS: string[];
  CAPTCHA_SIGNED_IN_FORMS: boolean;
  CAPTCHA_SIGNIN_AFTER_FAILS: number;
  CAPTCHA_SIGNIN_AFTER_IP_FAILS: number;
  CAPTCHA_COST: number;
  CAPTCHA_MAX_TRIES: number;
  CAPTCHA_ESCALATE_AFTER: number;
  CAPTCHA_EXPIRY_MIN: number;
  MAIL_BLOCKED_DOMAINS: string[];
  MAIL_BLOCK_DISPOSABLE: boolean;
  MAIL_ALLOWED_DOMAINS: string[];
  MAIL_ADDRESS_COOLDOWN_SEC: number;
  MAIL_ADDRESS_MAX_PER_DAY: number;
  MAIL_DOMAIN_MAX_PER_HOUR: number;
  MAIL_DOMAIN_CAP_EXEMPT: string[];
  MAIL_ANON_MAX_PER_HOUR: number;
  MAIL_IP_SIGNUPS_PER_HOUR: number;
  MAIL_IP_REQUESTS_PER_15MIN: number;
  MAIL_BOUNCE_SUPPRESS_AFTER: number;
  MAIL_GUARD_ALERTS: boolean;
  MAIL_BOUNCE_IMAP_ENABLED: boolean;
  MAIL_BOUNCE_IMAP_HOST: string;
  MAIL_BOUNCE_IMAP_PORT: number;
  MAIL_BOUNCE_IMAP_USER: string;
  MAIL_BOUNCE_IMAP_FOLDER: string;
  MAIL_BOUNCE_IMAP_DONE_FOLDER: string;
  MAIL_BOUNCE_IMAP_MATCH_REQUIRED: boolean;
  MAIL_BOUNCE_IMAP_MAX_PER_RUN: number;
  UNVERIFIED_PURGE_DAYS: number;
  UNVERIFIED_AUTO_PURGE: boolean;
  MARKETING_SOFT_OPT_IN: boolean;
  ANNOUNCEMENT_EMAILS_PER_MINUTE: number;
  EMAIL_REPLY_TO: string;
  BACKUP_TARGET: string;
  BACKUP_KEEP_DAILY: number;
  BACKUP_KEEP_MONTHLY: number;
  BACKUP_MAX_AGE_HOURS: number;
  BACKUP_ALERT_EMAILS: string;
};
export type PolicyKey = keyof SecurityPolicy;

const DEFS_BY_KEY = new Map(POLICY_DEFS.map((d) => [d.key, d]));

/** Entries of a 'list' value as typed (one per line or comma-separated): trimmed, lower-cased, de-duplicated. */
export function splitPolicyList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, ''))
        .filter(Boolean),
    ),
  );
}

/** Parse a stored string; returns undefined when it is not a valid value for the def. */
function parseStored(d: PolicyDef, raw: string): unknown {
  const v = raw.trim();
  switch (d.type) {
    case 'list': {
      const items = splitPolicyList(v);
      return items.length <= d.maxItems && items.every((i) => d.item.test(i)) ? items : undefined;
    }
    case 'bool':
      if (v === 'true') return true;
      if (v === 'false') return false;
      return undefined;
    case 'int': {
      const n = Number(v);
      return Number.isInteger(n) && n >= d.min && n <= d.max ? n : undefined;
    }
    case 'set': {
      if (v === '') return [];
      const items = v.split(',').map((s) => s.trim()).filter(Boolean);
      return items.every((i) => i in d.options) ? Array.from(new Set(items)) : undefined;
    }
    case 'text':
      return d.pattern && !d.pattern.test(v) ? undefined : v;
  }
}

/** Defaults for every key (also what a fresh install runs with). */
export function defaultPolicy(): SecurityPolicy {
  return Object.fromEntries(POLICY_DEFS.map((d) => [d.key, d.default])) as unknown as SecurityPolicy;
}

/** Build a policy from stored rows (pure; unit-tested). Invalid rows fall back to the default. */
export function policyFromRows(rows: { key: string; value: string }[]): SecurityPolicy {
  const out = defaultPolicy() as unknown as Record<string, unknown>;
  for (const r of rows) {
    const d = DEFS_BY_KEY.get(r.key);
    if (!d) continue;
    const parsed = parseStored(d, r.value);
    if (parsed !== undefined) out[d.key] = parsed;
  }
  return out as unknown as SecurityPolicy;
}

let cache: { at: number; policy: SecurityPolicy } | null = null;
const TTL_MS = 5000;

/** Current policy (5 s cache per process; a save clears it at once). Never throws. */
export async function getSecurityPolicy(): Promise<SecurityPolicy> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.policy;
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: POLICY_DEFS.map((d) => d.key) } },
      select: { key: true, value: true },
    });
    const policy = policyFromRows(rows);
    cache = { at: Date.now(), policy };
    return policy;
  } catch {
    // DB down / table missing: run with the safe defaults rather than failing open.
    return defaultPolicy();
  }
}

export function invalidatePolicyCache(): void {
  cache = null;
}

/** Human-readable value for history / alerts. */
export function formatPolicyValue(key: string, value: unknown): string {
  const d = DEFS_BY_KEY.get(key);
  if (Array.isArray(value)) {
    if (!value.length) return '(none)';
    return value.length > 12 ? `${value.slice(0, 12).join(', ')} … (${value.length} in total)` : value.join(', ');
  }
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (d?.type === 'int' && d.unit) return `${value} ${d.unit}`;
  return value === '' ? '(empty)' : String(value);
}

export type PolicyChange = { key: string; label: string; from: string; to: string };

/**
 * Validate a submitted form (all keys) and work out what changes. Pure.
 * Returns problems (nothing is saved when there are any) or the rows to write
 * (value null = delete row, i.e. back to the default).
 */
export function planPolicySave(
  current: SecurityPolicy,
  input: Record<string, string | string[] | undefined>,
): { problems: string[]; changes: PolicyChange[]; writes: { key: string; value: string | null }[] } {
  const problems: string[] = [];
  const changes: PolicyChange[] = [];
  const writes: { key: string; value: string | null }[] = [];
  for (const d of POLICY_DEFS) {
    const raw = input[d.key];
    let next: unknown;
    if (d.type === 'bool') {
      next = raw === 'on' || raw === 'true';
    } else if (d.type === 'set') {
      const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const bad = arr.filter((x) => !(x in d.options));
      if (bad.length) {
        problems.push(`${d.label}: unknown option ${bad.join(', ')}.`);
        continue;
      }
      next = Array.from(new Set(arr)).sort();
    } else if (d.type === 'list') {
      const items = splitPolicyList(Array.isArray(raw) ? raw.join('\n') : String(raw ?? ''));
      const bad = items.filter((i) => !d.item.test(i));
      if (bad.length) {
        problems.push(`${d.label}: “${bad.slice(0, 5).join('”, “')}” ${bad.length === 1 ? 'is' : 'are'} not valid (${d.itemHint}).`);
        continue;
      }
      if (items.length > d.maxItems) {
        problems.push(`${d.label}: at most ${d.maxItems} entries.`);
        continue;
      }
      next = items.sort();
    } else if (d.type === 'int') {
      const s = String(raw ?? '').trim();
      const n = Number(s);
      if (s === '' || !Number.isInteger(n) || n < d.min || n > d.max) {
        problems.push(`${d.label}: enter a whole number from ${d.min} to ${d.max}.`);
        continue;
      }
      next = n;
    } else {
      const s = String(raw ?? '').trim();
      if (d.pattern && !d.pattern.test(s)) {
        problems.push(`${d.label}: “${s}” is not valid (${d.patternHint ?? 'check the format'}).`);
        continue;
      }
      next = s;
    }
    const cur = (current as unknown as Record<string, unknown>)[d.key];
    const same = JSON.stringify(Array.isArray(cur) ? [...cur].sort() : cur) === JSON.stringify(next);
    if (same) continue;
    const isDefault =
      JSON.stringify(Array.isArray(d.default) ? [...d.default].sort() : d.default) === JSON.stringify(next);
    writes.push({ key: d.key, value: isDefault ? null : Array.isArray(next) ? next.join(',') : String(next) });
    changes.push({ key: d.key, label: d.label, from: formatPolicyValue(d.key, cur), to: formatPolicyValue(d.key, next) });
  }
  // Cross-field rules.
  const get = <K extends PolicyKey>(k: K) => {
    const w = writes.find((x) => x.key === k);
    if (!w) return current[k];
    return (w.value === null ? defaultPolicy()[k] : parseStored(DEFS_BY_KEY.get(k)!, w.value)) as SecurityPolicy[K];
  };
  if (get('LOCKOUT_MAX_MINUTES') < get('LOCKOUT_BASE_MINUTES')) {
    problems.push('The longest pause can’t be shorter than the first pause.');
  }
  if (get('LOGIN_MAX_FAILS_PER_ACCOUNT') < get('LOGIN_MAX_FAILS_PER_ACCOUNT_IP')) {
    problems.push('The all-networks limit must be at least the per-network limit.');
  }
  if (get('MAIL_BOUNCE_IMAP_ENABLED') && !get('MAIL_BOUNCE_IMAP_HOST')) {
    problems.push('Reading bounce reports needs the IMAP server of the sending mailbox (e.g. imap.transip.email).');
  }
  const doneFolder = get('MAIL_BOUNCE_IMAP_DONE_FOLDER');
  if (doneFolder && doneFolder.toLowerCase() === get('MAIL_BOUNCE_IMAP_FOLDER').toLowerCase()) {
    problems.push('Handled bounce reports must move to another folder than the one that is read (or leave the field empty).');
  }
  return { problems, changes: problems.length ? [] : changes, writes: problems.length ? [] : writes };
}

/** Write a planned save. */
export async function applyPolicyWrites(writes: { key: string; value: string | null }[]): Promise<void> {
  await prisma.$transaction(
    writes.map((w) =>
      w.value === null
        ? prisma.setting.deleteMany({ where: { key: w.key } })
        : prisma.setting.upsert({ where: { key: w.key }, update: { value: w.value }, create: { key: w.key, value: w.value } }),
    ),
  );
  invalidatePolicyCache();
}

/** Whether `email` may hold an admin account under ADMIN_EMAIL_DOMAINS. */
export function adminEmailAllowed(policy: Pick<SecurityPolicy, 'ADMIN_EMAIL_DOMAINS'>, email: string): boolean {
  const domains = policy.ADMIN_EMAIL_DOMAINS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!domains.length) return true;
  const at = email.toLowerCase().split('@')[1] ?? '';
  return domains.includes(at);
}
