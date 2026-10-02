import { prisma } from './db';

/**
 * Admin-configurable base settings. Stored in the DB so they can be set
 * from the admin dashboard, then hydrated into process.env at runtime so
 * existing consumers (email, stripe, webhook) keep reading process.env.
 * DB value wins over the .env default.
 */
export const SETTING_DEFS = [
  { key: 'RESEND_API_KEY', label: 'Resend API key', secret: true, group: 'Email',
    hint: 'From resend.com → API Keys. If set, this HTTP path is used and the SMTP fields below are ignored. Leave blank to send via your own SMTP server instead.' },
  { key: 'EMAIL_FROM', label: 'From address', secret: false, group: 'Email', verify: 'email',
    hint: 'e.g. notifications@yourdomain.com. For Resend it must be a verified domain; for SMTP, an address your mail server is allowed to send as.' },
  { key: 'SMTP_HOST', label: 'SMTP host', secret: false, group: 'Email',
    hint: 'Your mail server, e.g. smtp.gmail.com, smtp.office365.com, mail.yourdomain.com. Used only when the Resend key above is empty.' },
  { key: 'SMTP_PORT', label: 'SMTP port', secret: false, group: 'Email', verify: 'number',
    hint: '465 for SSL/TLS, 587 for STARTTLS, 25 for plain. Default 465.' },
  { key: 'SMTP_USER', label: 'SMTP username', secret: false, group: 'Email',
    hint: 'Login for your mail server — usually the full mailbox address.' },
  { key: 'SMTP_PASS', label: 'SMTP password', secret: true, group: 'Email',
    hint: 'Mailbox password, or an app-specific password (Gmail / Outlook require one — normal passwords are rejected).' },
  { key: 'SMTP_SECURE', label: 'SMTP encryption', secret: false, group: 'Email',
    hint: 'true = implicit SSL/TLS (port 465). false = STARTTLS or none (587 / 25). Leave blank to auto-detect from the port.' },
  { key: 'SELL_INTAKE_EMAIL', label: 'Sell submissions go to', secret: false, group: 'Email', verify: 'email',
    hint: 'Inbox that receives “sell your equipment” submissions.' },
  { key: 'QUOTE_INTAKE_EMAIL', label: 'Quote requests go to', secret: false, group: 'Email', verify: 'email',
    hint: 'Inbox for “Let us find it” / unassigned quote requests.' },
  { key: 'SUPPORT_INTAKE_EMAIL', label: 'Support tickets go to', secret: false, group: 'Email', verify: 'email',
    hint: 'Inbox that receives new support tickets / contact messages.' },
  { key: 'STRIPE_SECRET_KEY', label: 'Stripe secret key', secret: true, group: 'Payments',
    hint: 'sk_live_… or sk_test_… — enables real checkout & orders.' },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook secret', secret: true, group: 'Payments',
    hint: 'whsec_… from the Stripe webhook endpoint.' },
  { key: 'BANK_NAME', label: 'Bank name (for transfers)', secret: false, group: 'Payments',
    hint: 'Shown to buyers as the payee bank, e.g. “ING Bank”.' },
  { key: 'BANK_IBAN', label: 'Bank IBAN', secret: false, group: 'Payments',
    hint: 'Full IBAN, e.g. NL00 INGB 0000 0000 00. Shown in proformas and payment workspace.' },
  { key: 'BANK_SWIFT', label: 'Bank SWIFT / BIC', secret: false, group: 'Payments',
    hint: 'e.g. INGBNL2A. For international wires.' },
  { key: 'BANK_REFERENCE_HINT', label: 'Reference line hint', secret: false, group: 'Payments',
    hint: 'Tells buyer what to put in transfer reference, e.g. “Use order number”.' },
  { key: 'PROFORMA_VALID_DAYS', label: 'Proforma validity (days)', secret: false, group: 'Payments', verify: 'number',
    hint: 'How long a proforma stays valid before auto-expiring to Lost. Default: 14.' },
  { key: 'COMPANY_RECEIVING_ADDRESS', label: 'Receiving warehouse address', secret: false, group: 'Acquisitions', multiline: true,
    hint: 'Full address sellers ship accepted equipment to. Multi-line OK. Shown in their shipping form once we accept their offer.' },
  { key: 'EMAIL_THROTTLE_HOURS', label: 'Email throttle (hours)', secret: false, group: 'Acquisitions', verify: 'number',
    hint: 'When we reply to a seller/buyer, skip the email if we already emailed them in the last N hours (the in-app notification still fires). Stops chat-rapid-fire spam. Default: 2.' },
  { key: 'SITE_NAME', label: 'Site / brand name', secret: false, group: 'Brand', preview: '/',
    hint: 'Display name used in emails and page metadata.' },
  { key: 'SUPPORT_EMAIL', label: 'Public support email', secret: false, group: 'Brand', verify: 'email',
    hint: 'Shown in the footer “contact us” link.' },
  { key: 'COMPANY_LEGAL_NAME', label: 'Legal company name', secret: false, group: 'Company',
    hint: 'Registered name printed on invoices & proformas.' },
  { key: 'COMPANY_ADDRESS', label: 'Company address', secret: false, group: 'Company', multiline: true,
    hint: 'Full registered address (one line or comma-separated).' },
  { key: 'COMPANY_COUNTRY', label: 'Country', secret: false, group: 'Company',
    hint: 'e.g. Netherlands.' },
  { key: 'COMPANY_PHONE', label: 'Phone', secret: false, group: 'Company',
    hint: 'Business phone shown on invoices.' },
  { key: 'COMPANY_EMAIL', label: 'Billing email', secret: false, group: 'Company', verify: 'email',
    hint: 'Billing/accounts contact; also BCC’d on invoices.' },
  { key: 'COMPANY_VAT', label: 'VAT / reg. number', secret: false, group: 'Company',
    hint: 'VAT or company registration number for invoices.' },
  { key: 'COMPANY_KVK', label: 'KvK / trade register number', secret: false, group: 'Company',
    hint: 'Chamber-of-commerce number printed on invoices (NL: KvK, BE: KBO, DE: HRB…). Leave blank to hide.' },
  { key: 'COMPANY_WEBSITE', label: 'Website', secret: false, group: 'Company',
    hint: 'e.g. samparsbenelux.com. Shown next to the “i” icon in the invoice header.' },
  { key: 'COMPANY_CITY', label: 'Issuing city', secret: false, group: 'Company',
    hint: 'City shown before the date on proformas (e.g. “Zoetermeer, 30-05-2026”).' },
  { key: 'COMPANY_LOGO_URL', label: 'Company logo URL', secret: false, group: 'Company', verify: 'image',
    hint: 'Auto-filled when you upload a logo below. Used on invoices & proformas.' },
  { key: 'AI_API_KEY', label: 'AI API key', secret: true, group: 'AI assistant',
    hint: 'OpenAI-compatible key (sk-…). Powers the on-site assistant.' },
  { key: 'AI_BASE_URL', label: 'AI base URL', secret: false, group: 'AI assistant', verify: 'url',
    hint: 'Default https://api.openai.com/v1 — change for any OpenAI-compatible provider.' },
  { key: 'AI_MODEL', label: 'AI model', secret: false, group: 'AI assistant',
    hint: 'e.g. gpt-4o-mini. Default: gpt-4o-mini.' },
  { key: 'ASSISTANT_NAME', label: 'Assistant name', secret: false, group: 'AI assistant', preview: '/',
    hint: 'Display name of the on-site chat assistant. Default: lab2date Assistant.' },
] as const;

export type SettingKey = (typeof SETTING_DEFS)[number]['key'];

type SettingDef = (typeof SETTING_DEFS)[number];

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

/** Per-type check run BEFORE anything is written. Returns a reason or null. */
function validateSettingValue(d: SettingDef, value: string): string | null {
  const verify = 'verify' in d ? d.verify : undefined;
  if (verify === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return `“${value}” is not a number.`;
    if (d.key === 'SMTP_PORT' && !(Number.isInteger(n) && n >= 1 && n <= 65535)) return 'must be a whole number between 1 and 65535.';
    if (d.key === 'PROFORMA_VALID_DAYS' && !(Number.isInteger(n) && n >= 1 && n <= 365)) return 'must be a whole number of days between 1 and 365.';
    return null;
  }
  if (verify === 'email') {
    // EMAIL_FROM may be written as `Name <addr@domain>`.
    const addr = value.match(/<([^>]+)>\s*$/)?.[1] ?? value;
    return /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(addr.trim()) ? null : `“${value}” is not a valid email address.`;
  }
  if (verify === 'url' || verify === 'image') {
    if (verify === 'image' && isSiteRelativePath(value)) return null; // site-relative upload path
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'must start with https:// (or http://).';
    } catch {
      return `“${value}” is not a valid URL (include https://).`;
    }
  }
  if (d.key === 'SMTP_SECURE' && !/^(true|false|1|0)$/i.test(value)) {
    return 'use true or false (or leave blank to auto-detect from the port).';
  }
  return null;
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

/** Current effective values (DB overrides env). Secrets are NOT masked here. */
export async function getEffectiveSettings(): Promise<Record<string, string>> {
  const rows = await prisma.setting.findMany();
  const db = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out: Record<string, string> = {};
  for (const d of SETTING_DEFS) out[d.key] = db[d.key] || process.env[d.key] || '';
  return out;
}

/** Keys whose effective value comes from the server .env (no DB override) —
 *  emptying such a field can't clear it; the settings page says so. */
export async function getEnvOnlySettingKeys(): Promise<Set<string>> {
  const rows = await prisma.setting.findMany({ select: { key: true, value: true } });
  const inDb = new Set(rows.filter((r) => r.value?.trim()).map((r) => r.key));
  return new Set(SETTING_DEFS.filter((d) => !inDb.has(d.key) && (process.env[d.key] ?? '').trim()).map((d) => d.key));
}

/** What a save did, so the settings page can say it truthfully. Labels. */
export type SaveSettingsResult = {
  /** Fields whose effective value changed (set, replaced or removed). */
  changed: string[];
  /** Fields that now follow the server .env value (override removed). */
  envDefault: string[];
  /** Emptied fields whose value comes only from .env, so nothing was removed. */
  envKept: string[];
};

export async function saveSettings(input: Record<string, string>): Promise<SaveSettingsResult> {
  // A set Resend key overrides SMTP, so an autofilled login password in that
  // field silently breaks all email. Real keys start with "re_"; reject anything
  // else before writing so a bad submit changes nothing.
  const resendKey = (input.RESEND_API_KEY ?? '').trim();
  if (resendKey && input.__clear_RESEND_API_KEY !== 'on' && !resendKey.startsWith('re_')) {
    throw new Error('Resend API key must start with "re_" (browser autofill?). Empty that field and save again.');
  }
  // Type checks (numbers, emails, URLs) — all fields first, so a bad submit
  // changes nothing (a "fourteen" in a days field used to save as "Saved ✓").
  const problems: string[] = [];
  for (const d of SETTING_DEFS) {
    if (input[`__clear_${d.key}`] === 'on') continue;
    const value = (input[d.key] ?? '').trim();
    if (!value) continue;
    const why = validateSettingValue(d, value);
    if (why) problems.push(`${d.label}: ${why}`);
  }
  if (problems.length) throw new Error(`${problems.join(' · ')} Nothing was saved.`);

  const rows = await prisma.setting.findMany({
    where: { key: { in: SETTING_DEFS.map((d) => d.key) } },
    select: { key: true, value: true },
  });
  const inDb = new Map(rows.map((r) => [r.key, r.value]));
  const result: SaveSettingsResult = { changed: [], envDefault: [], envKept: [] };

  for (const d of SETTING_DEFS) {
    const clear = input[`__clear_${d.key}`] === 'on';
    const raw = input[d.key];
    const value = (raw ?? '').replace(/\r\n/g, '\n').trim(); // textareas post CRLF
    const def = envDefault(d.key);
    const stored = (inDb.get(d.key) ?? '').trim();
    // Secret fields are never pre-filled, so empty = keep the current value.
    // Plain fields ARE pre-filled with their current value, so an emptied
    // field means "remove it" (it used to report "Saved ✓" and keep it).
    // Only a DB override can be removed here — the setting then falls back to
    // the server .env value at once; a value that comes only from .env stays
    // (the settings page and the save message say so instead of pretending).
    if (clear || (raw !== undefined && value === '' && !d.secret)) {
      if (inDb.has(d.key)) {
        await prisma.setting.deleteMany({ where: { key: d.key } });
        restoreEnvDefault(d.key);
        if (stored !== def) result.changed.push(d.label);
        if (def) result.envDefault.push(d.label);
      } else if (def) {
        result.envKept.push(d.label);
      }
      continue;
    }
    if (raw === undefined || value === '') continue;
    // One rule for the .env value: it is never copied into the DB (that froze
    // it against later .env changes). Saving it — typed back in, or a
    // pre-filled default submitted untouched — removes any override, so .env
    // is the source again and the setting has its .env value right away.
    if (def && value === def) {
      if (inDb.has(d.key)) {
        await prisma.setting.deleteMany({ where: { key: d.key } });
        if (stored !== def) result.changed.push(d.label);
        result.envDefault.push(d.label);
      }
      restoreEnvDefault(d.key);
      continue;
    }
    if (stored === value) continue; // unchanged
    await prisma.setting.upsert({
      where: { key: d.key },
      update: { value },
      create: { key: d.key, value },
    });
    process.env[d.key] = value;
    result.changed.push(d.label);
  }
  lastLoad = Date.now();
  return result;
}
