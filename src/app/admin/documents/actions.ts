'use server';

import { revalidatePath } from 'next/cache';
import { getServerSession, hasCapability } from '@/lib/auth-server';
import { audit } from '@/lib/observability';
import { getEffectiveSettings, saveSettings } from '@/lib/settings';
import { getVersion, listVersions, readEntry, saveEntry, diffJson, type Actor } from '@/lib/cms/store';
import {
  cleanGeneral,
  cleanLabels,
  cleanNumbering,
  cleanOptions,
  cleanTexts,
  cleanVat,
  ConfigError,
  getVatSettings,
  KEY,
} from '@/lib/documents/config';
import { DEFAULT_GENERAL, DEFAULT_LABELS, DEFAULT_TEXTS, defaultOptions } from '@/lib/documents/defaults';
import { DEFAULT_NUMBERING } from '@/lib/documents/numbering';
import { DEFAULT_VAT_SETTINGS, decideVat, type VatDecision, type ViesEvidence } from '@/lib/tax/vat';
import { checkVies } from '@/lib/tax/vies';
import { asLang, DOC_KINDS, type DocKind, type Lang } from '@/lib/documents/types';
import { EMAIL_KEY, emailDef } from '@/lib/email-templates/registry';
import { checkEmailTexts, DEFAULT_LAYOUT, getEmailLayout, getEmailTexts, renderEmail } from '@/lib/email-templates/send';
import { checkText } from '@/lib/cms/text';
import { sendEmail } from '@/lib/email';
import type { EmailTexts } from '@/lib/email-templates/types';
import { previewSnapshot } from '@/lib/documents/preview';
import { COMPANY_FIELDS } from '@/lib/documents/company-fields';
import { documentFileName } from '@/lib/documents/issue';
import { htmlToPdf } from '@/lib/documents/pdf';
import { pdfFooter, renderDocumentHtml } from '@/lib/documents/render';

export type ActionResult = { ok: boolean; message: string; problems?: string[] };

async function actor(cap = 'documents:edit'): Promise<Actor | ActionResult> {
  const session = await getServerSession();
  if (!session?.user || session.user.role !== 'ADMIN') return { ok: false, message: 'Sign in as an admin.' };
  if (!(await hasCapability(cap))) return { ok: false, message: `Your admin account lacks the “${cap}” permission — ask a super-admin to grant it.` };
  return { id: session.user.id, email: session.user.email };
}

function isResult(v: unknown): v is ActionResult {
  return !!v && typeof v === 'object' && 'ok' in v;
}

async function save(key: string, data: unknown, who: Actor, what: string, note = 'saved'): Promise<ActionResult> {
  const v = await saveEntry(key, data, who, note);
  await audit('documents.config.save', key, `${what} → v${v}`).catch(() => {});
  revalidatePath('/admin/documents');
  if (key.startsWith('site:')) revalidatePath('/', 'layout');
  return { ok: true, message: `${what} saved (version ${v}).` };
}

function fail(e: unknown): ActionResult {
  if (e instanceof ConfigError) return { ok: false, message: 'Nothing was saved. Fix these first:', problems: e.problems };
  return { ok: false, message: e instanceof Error ? e.message : 'Saving failed.' };
}

const kindOf = (k: string): DocKind => (DOC_KINDS.includes(k as DocKind) ? (k as DocKind) : 'QUOTE');

// ─── Templates ─────────────────────────────────────────────────────────

export async function saveDocTexts(kind: string, lang: string, data: Record<string, unknown>): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  try {
    const k = kindOf(kind);
    const l = asLang(lang);
    return await save(KEY.texts(k, l), cleanTexts(k, data), who, `${k.toLowerCase()} texts (${l.toUpperCase()})`);
  } catch (e) {
    return fail(e);
  }
}

export async function saveLabels(lang: string, data: Record<string, unknown>): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  try {
    const l = asLang(lang);
    return await save(KEY.labels(l), cleanLabels(data), who, `Shared labels (${l.toUpperCase()})`);
  } catch (e) {
    return fail(e);
  }
}

export async function saveDocOptions(kind: string, data: Record<string, unknown>): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  try {
    const k = kindOf(kind);
    return await save(KEY.options(k), cleanOptions(k, data), who, `${k.toLowerCase()} options`);
  } catch (e) {
    return fail(e);
  }
}

export async function resetToDefault(key: string): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  let data: unknown = null;
  if (key.startsWith('doc:texts:')) {
    const [, , kind, lang] = key.split(':');
    data = DEFAULT_TEXTS[kindOf(kind)][asLang(lang)];
  } else if (key.startsWith('doc:labels:')) data = DEFAULT_LABELS[asLang(key.split(':')[2])];
  else if (key.startsWith('doc:options:')) data = defaultOptions(kindOf(key.split(':')[2]));
  else if (key === KEY.general) data = DEFAULT_GENERAL;
  else if (key === KEY.vat) data = DEFAULT_VAT_SETTINGS;
  else if (key === KEY.numbering) data = DEFAULT_NUMBERING;
  else if (key.startsWith('email:') && key.split(':').length === 3 && key.split(':')[2] !== 'options') {
    const [, ek, lang] = key.split(':');
    data = ek === 'layout' ? DEFAULT_LAYOUT[asLang(lang)] : emailDef(ek).defaults[asLang(lang)];
  }
  if (data === null) return { ok: false, message: 'This item has no built-in default.' };
  return save(key, data, who, 'Reset to the built-in default', 'reset to default');
}

// ─── General, VAT, numbering ───────────────────────────────────────────

export async function saveGeneralSettings(data: Record<string, unknown>): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  try {
    return await save(KEY.general, cleanGeneral(data), who, 'General document settings');
  } catch (e) {
    return fail(e);
  }
}

export async function saveVatSettings(data: Record<string, unknown>): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  try {
    return await save(KEY.vat, cleanVat(data), who, 'VAT rules');
  } catch (e) {
    return fail(e);
  }
}

export async function saveNumberingSettings(data: Record<string, unknown>): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  try {
    return await save(KEY.numbering, cleanNumbering(data), who, 'Numbering');
  } catch (e) {
    return fail(e);
  }
}

/** The VAT tester on the VAT tab and the quote composer's live suggestion. */
export async function testVat(country: string, vatId: string): Promise<{ ok: boolean; decision?: VatDecision; vies?: ViesEvidence | null; message?: string }> {
  const session = await getServerSession();
  if (!session?.user || session.user.role !== 'ADMIN') return { ok: false, message: 'Sign in as an admin.' };
  if (!(await hasCapability('documents:edit')) && !(await hasCapability('quotes:proforma'))) return { ok: false, message: 'Missing permission.' };
  const s = await getVatSettings();
  const c = (country || '').trim().toUpperCase();
  const id = (vatId || '').trim();
  let vies: ViesEvidence | null = null;
  if (id && c && c !== s.homeCountry && s.reverseChargeEnabled && s.requireVies) vies = await checkVies(id);
  return { ok: true, decision: decideVat({ country: c, vatId: id, vies }, s), vies };
}

// ─── Company & bank ────────────────────────────────────────────────────

export async function saveCompanyDetails(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  const input: Record<string, string> = {};
  for (const k of COMPANY_FIELDS) input[k] = String(form.get(k) ?? '');
  // Light sanity checks the settings layer does not make.
  const problems: string[] = [];
  const iban = input.BANK_IBAN.replace(/\s+/g, '').toUpperCase();
  if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) problems.push('IBAN: this does not look like an IBAN (e.g. NL91 ABNA 0417 1643 00).');
  const bic = input.BANK_SWIFT.replace(/\s+/g, '').toUpperCase();
  if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) problems.push('BIC: 8 or 11 letters/digits, e.g. INGBNL2A.');
  if (input.COMPANY_KVK && !/^\d{8}$/.test(input.COMPANY_KVK.replace(/\s+/g, ''))) problems.push('KvK: 8 digits.');
  if (problems.length) return { ok: false, message: 'Nothing was saved. Fix these first:', problems };
  try {
    const res = await saveSettings(input);
    const after = await getEffectiveSettings();
    const snapshot = Object.fromEntries(COMPANY_FIELDS.map((k) => [k, after[k] ?? '']));
    if (res.changed.length) {
      await saveEntry('settings:company', snapshot, who, `changed: ${res.changed.join(', ')}`);
      await audit('documents.company.save', 'company', res.changed.join(', ')).catch(() => {});
    }
    revalidatePath('/admin/documents');
    return { ok: true, message: res.changed.length ? `Saved: ${res.changed.join(', ')}.` : 'Nothing changed.' };
  } catch (e) {
    return fail(e);
  }
}

// ─── E-mails ───────────────────────────────────────────────────────────

function cleanEmailTexts(key: string, data: Record<string, unknown>): EmailTexts {
  const def = emailDef(key);
  const t: EmailTexts = {
    subject: String(data.subject ?? '').replace(/\r\n?/g, '\n').trim(),
    body: String(data.body ?? '').replace(/\r\n?/g, '\n').trim(),
    button: String(data.button ?? '').trim(),
  };
  const problems = checkEmailTexts(def, t);
  if (problems.length) throw new ConfigError(problems);
  return t;
}

export async function saveEmailTexts(key: string, lang: string, data: Record<string, unknown>): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  try {
    const l = asLang(lang);
    return await save(EMAIL_KEY.texts(key, l), cleanEmailTexts(key, data), who, `E-mail “${emailDef(key).label}” (${l.toUpperCase()})`);
  } catch (e) {
    return fail(e);
  }
}

export async function setEmailEnabled(key: string, enabled: boolean): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  const def = emailDef(key);
  if (!def.canDisable && !enabled) return { ok: false, message: 'This e-mail cannot be switched off (security or a document the customer needs).' };
  return save(EMAIL_KEY.options(key), { enabled }, who, `E-mail “${def.label}” ${enabled ? 'switched on' : 'switched off'}`);
}

export async function saveEmailLayout(lang: string, data: Record<string, unknown>): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  const l = asLang(lang);
  const footer = String(data.footer ?? '').replace(/\r\n?/g, '\n').trim();
  const problems = checkText('Footer', footer, ['customer.name', 'site.name', 'site.url', 'company.name', 'support.email'], { max: 800 });
  if (problems.length) return { ok: false, message: 'Nothing was saved. Fix these first:', problems };
  return save(`${EMAIL_KEY.layout}:${l}`, { footer }, who, `E-mail footer (${l.toUpperCase()})`);
}

function exampleVars(key: string): Record<string, string> {
  const def = emailDef(key);
  const out: Record<string, string> = { 'customer.name': 'Anna de Vries' };
  for (const f of def.fields) out[f.name] = f.example;
  return out;
}

export async function previewEmail(key: string, lang: string, data: Record<string, unknown>, footer?: string): Promise<{ ok: boolean; subject?: string; html?: string; message?: string; problems?: string[] }> {
  const who = await actor();
  if (isResult(who)) return who;
  try {
    const l = asLang(lang);
    const texts = cleanEmailTexts(key, data);
    const layout = footer !== undefined ? { footer } : await getEmailLayout(l);
    const mail = await renderEmail(emailDef(key), texts, l, exampleVars(key), layout);
    return { ok: true, subject: mail.subject, html: mail.html };
  } catch (e) {
    const f = fail(e);
    return { ok: false, message: f.message, problems: f.problems };
  }
}

export async function sendTestEmail(key: string, lang: string, data: Record<string, unknown>, to: string): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  const addr = (to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return { ok: false, message: 'Enter the address to send the test to.' };
  try {
    const l = asLang(lang);
    const mail = await renderEmail(emailDef(key), cleanEmailTexts(key, data), l, exampleVars(key));
    await sendEmail({ to: addr, subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text });
    await audit('documents.email.test', key, addr).catch(() => {});
    return { ok: true, message: `Test sent to ${addr}. It uses example values.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Sending failed: ${e.message}` : 'Sending failed.' };
  }
}

/** Send the document preview (as PDF, with the matching e-mail) to an address. */
export async function sendTestDocument(input: { kind: string; lang: string; source: string; to: string; override?: Record<string, unknown> }): Promise<ActionResult> {
  const who = await actor();
  if (isResult(who)) return who;
  const addr = (input.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return { ok: false, message: 'Enter the address to send the test to.' };
  try {
    const kind = kindOf(input.kind);
    const lang = asLang(input.lang);
    const snap = await previewSnapshot({ kind, lang, source: input.source, override: input.override });
    const { footerText, pageLabel } = pdfFooter(snap);
    const pdf = await htmlToPdf(renderDocumentHtml(snap), { footerText, pageLabel });
    const emailKey = kind === 'QUOTE' ? 'quote_sent' : 'payment_received';
    const mail = await renderEmail(emailDef(emailKey), await getEmailTexts(emailKey, lang), lang, exampleVars(emailKey));
    await sendEmail({
      to: addr,
      subject: `[TEST] ${mail.subject}`,
      html: mail.html,
      text: mail.text,
      attachments: [{ filename: documentFileName(snap), content: pdf, contentType: 'application/pdf' }],
    });
    await audit('documents.document.test', kind, addr).catch(() => {});
    return { ok: true, message: `Test ${snap.texts.title} sent to ${addr} with the PDF attached.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Sending failed: ${e.message}` : 'Sending failed.' };
  }
}

// ─── History ───────────────────────────────────────────────────────────

const capFor = (key: string) => (key.startsWith('site:') ? 'content:cms' : 'documents:edit');

export async function versionsOf(key: string) {
  const who = await actor(capFor(key));
  if (isResult(who)) return { ok: false as const, message: who.message };
  const rows = await listVersions(key, 30);
  return {
    ok: true as const,
    rows: rows.map((r, i) => ({
      version: r.version,
      note: r.note,
      at: r.createdAt.toISOString(),
      by: r.createdByEmail,
      changes: diffJson(rows[i + 1]?.data ?? null, r.data).slice(0, 40).map((d) => ({
        path: d.path,
        before: d.before === undefined || d.before === null ? '' : String(typeof d.before === 'object' ? JSON.stringify(d.before) : d.before),
        after: d.after === undefined || d.after === null ? '' : String(typeof d.after === 'object' ? JSON.stringify(d.after) : d.after),
      })),
    })),
  };
}

export async function restoreVersion(key: string, version: number): Promise<ActionResult> {
  const who = await actor(capFor(key));
  if (isResult(who)) return who;
  const data = await getVersion(key, version);
  if (data === null) return { ok: false, message: `Version ${version} was not found.` };
  if (key === 'settings:company') {
    // Company details live in the settings table: write them back there.
    const res = await saveSettings(data as Record<string, string>);
    await saveEntry(key, data, who, `restored v${version}`);
    revalidatePath('/admin/documents');
    return { ok: true, message: `Company details restored to version ${version}${res.changed.length ? ` (${res.changed.join(', ')})` : ''}.` };
  }
  const current = await readEntry(key);
  if (JSON.stringify(current) === JSON.stringify(data)) return { ok: true, message: 'That version is already the current one.' };
  return save(key, data, who, `Restored version ${version}`, `restored v${version}`);
}
