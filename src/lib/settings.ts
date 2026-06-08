import { prisma } from './db';

/**
 * Admin-configurable base settings. Stored in the DB so they can be set
 * from the admin dashboard, then hydrated into process.env at runtime so
 * existing consumers (email, stripe, webhook) keep reading process.env.
 * DB value wins over the .env default.
 */
export const SETTING_DEFS = [
  { key: 'RESEND_API_KEY', label: 'Resend API key', secret: true, group: 'Email',
    hint: 'From resend.com → API Keys. Enables real outbound email.' },
  { key: 'EMAIL_FROM', label: 'From address', secret: false, group: 'Email', verify: 'email',
    hint: 'e.g. notifications@yourdomain.com (must be a verified Resend domain).' },
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
      for (const r of rows) {
        if (r.value && r.value.trim()) process.env[r.key] = r.value;
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

export async function saveSettings(input: Record<string, string>): Promise<void> {
  for (const d of SETTING_DEFS) {
    const clear = input[`__clear_${d.key}`] === 'on';
    if (clear) {
      await prisma.setting.deleteMany({ where: { key: d.key } });
      delete process.env[d.key];
      continue;
    }
    const raw = input[d.key];
    if (raw === undefined) continue;
    const value = raw.trim();
    // Empty input = leave the existing value untouched (avoids wiping a
    // secret when the admin re-submits the form without re-typing it).
    if (value === '') continue;
    await prisma.setting.upsert({
      where: { key: d.key },
      update: { value },
      create: { key: d.key, value },
    });
    process.env[d.key] = value;
  }
  lastLoad = Date.now();
}
