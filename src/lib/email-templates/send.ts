import { prisma } from '@/lib/db';
import { readEntry } from '@/lib/cms/store';
import { checkText, fillPlain, fillRich, fillRichPlain, type Vars } from '@/lib/cms/text';
import { escapeHtml as esc } from '@/lib/email-html';
import { sendEmail, type EmailAttachment } from '@/lib/email';
import { ensureSettingsLoaded } from '@/lib/settings';
import { getGeneral } from '@/lib/documents/config';
import { asLang, type Lang } from '@/lib/documents/types';
import { allowedEmailFields, emailDef, EMAIL_KEY } from './registry';
import type { EmailDef, EmailOptions, EmailTexts } from './types';

/**
 * Templated e-mail: texts from Admin → Documents → E-mails (or the built-in
 * defaults), fields filled and escaped, wrapped in the one branded layout.
 */

export interface EmailLayout {
  footer: string;
}

export const DEFAULT_LAYOUT: Record<Lang, EmailLayout> = {
  en: { footer: '{{company.name}} · {{site.url}}\nQuestions? Reply to this e-mail or write to {{support.email}}.' },
  nl: { footer: '{{company.name}} · {{site.url}}\nVragen? Beantwoord deze e-mail of schrijf naar {{support.email}}.' },
};

function merge<T extends object>(def: T, stored: unknown): T {
  if (!stored || typeof stored !== 'object') return { ...def };
  const out = { ...def } as Record<string, unknown>;
  for (const k of Object.keys(def)) {
    const v = (stored as Record<string, unknown>)[k];
    if (typeof v === typeof (def as Record<string, unknown>)[k]) out[k] = v;
  }
  return out as T;
}

export async function getEmailTexts(key: string, lang: Lang): Promise<EmailTexts> {
  return merge(emailDef(key).defaults[lang], await readEntry(EMAIL_KEY.texts(key, lang)));
}

export async function getEmailOptions(key: string): Promise<EmailOptions> {
  return merge({ enabled: true }, await readEntry(EMAIL_KEY.options(key)));
}

export async function getEmailLayout(lang: Lang): Promise<EmailLayout> {
  return merge(DEFAULT_LAYOUT[lang], await readEntry(`${EMAIL_KEY.layout}:${lang}`));
}

export function checkEmailTexts(def: EmailDef, t: EmailTexts): string[] {
  const allowed = allowedEmailFields(def);
  const keep = (def.subjectMustKeep ?? []).filter((f) => !t.subject.includes(`{{${f}}}`)).map((f) => `Subject: keep {{${f}}} in the subject — repeated messages are grouped by it.`);
  return [
    ...keep,
    ...checkText('Subject', t.subject, allowed, { required: true, max: 200 }),
    ...checkText('Body', t.body, allowed, { required: true, max: 6000 }),
    ...checkText('Button', t.button, allowed, { max: 40 }),
  ];
}

export async function commonVars(): Promise<Vars> {
  await ensureSettingsLoaded();
  const e = (k: string) => (process.env[k] || '').trim();
  return {
    'site.name': e('SITE_NAME') || 'Labtodate',
    'site.url': (e('BETTER_AUTH_URL') || 'https://labtodate.com').replace(/\/+$/, ''),
    'company.name': e('COMPANY_LEGAL_NAME') || e('SITE_NAME') || 'Labtodate',
    'support.email': e('SUPPORT_EMAIL') || e('COMPANY_EMAIL') || e('EMAIL_FROM'),
  };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Build the e-mail from given texts (the admin preview passes unsaved texts). */
export async function renderEmail(def: EmailDef, texts: EmailTexts, lang: Lang, vars: Vars, layoutOverride?: EmailLayout): Promise<RenderedEmail> {
  const [general, layout, common] = await Promise.all([getGeneral(), layoutOverride ? Promise.resolve(layoutOverride) : getEmailLayout(lang), commonVars()]);
  const all: Vars = { ...common, ...vars };
  const accent = general.accent;
  const logoUrl = (process.env.COMPANY_LOGO_URL || '').trim();
  const absLogo = logoUrl && !/^https?:\/\//i.test(logoUrl) ? `${all['site.url']}${logoUrl.startsWith('/') ? '' : '/'}${logoUrl}` : logoUrl;
  const subject = fillPlain(texts.subject, all).replace(/\s+/g, ' ').trim();
  const body = fillRich(texts.body, all, { p: 'margin:0 0 14px 0;', ul: 'margin:0 0 14px 18px;padding:0;', li: 'margin:0 0 4px 0;' });
  const link = def.buttonLink ? String(all[def.buttonLink] ?? '') : '';
  const buttonLabel = fillPlain(texts.button, all).trim();
  const button = link && buttonLabel && /^https?:\/\//.test(link)
    ? `<p style="margin:22px 0;"><a href="${esc(link)}" style="background:${accent};color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">${esc(buttonLabel)}</a></p>`
    : '';
  const footer = fillRich(layout.footer, all, { p: 'margin:0 0 6px 0;' });
  const html = `<!doctype html><html lang="${lang}"><body style="margin:0;padding:0;background:#f4f5f7;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:15px;line-height:1.55;">
  <div style="padding:0 0 16px 0;">${absLogo ? `<img src="${esc(absLogo)}" alt="${esc(String(all['site.name']))}" style="max-height:40px;max-width:200px;border:0;">` : `<span style="font-size:20px;font-weight:800;color:${accent};">${esc(String(all['site.name']))}</span>`}</div>
  <div style="background:#ffffff;border-radius:12px;padding:28px 26px;border-top:4px solid ${accent};">${body}${button}</div>
  <div style="padding:16px 4px 0 4px;color:#6b7280;font-size:12px;line-height:1.5;">${footer}</div>
</div></body></html>`;
  const text = [fillRichPlain(texts.body, all), link && buttonLabel ? `${buttonLabel}: ${link}` : '', '—', fillRichPlain(layout.footer, all)].filter(Boolean).join('\n\n');
  return { subject, html, text };
}

/** Language for a recipient: explicit → their account setting → the default. */
export async function recipientLang(email: string, explicit?: string | null): Promise<Lang> {
  if (explicit === 'en' || explicit === 'nl') return explicit;
  try {
    const u = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { docLanguage: true } });
    if (u?.docLanguage === 'en' || u?.docLanguage === 'nl') return u.docLanguage;
  } catch {
    /* fall through */
  }
  return asLang((await getGeneral()).defaultLang);
}

export interface SendTemplatedArgs {
  key: string;
  to: string;
  lang?: Lang | null;
  vars: Vars;
  attachments?: EmailAttachment[];
}

/**
 * Send a templated e-mail. Returns false when the admin switched it off.
 * Throws when delivery fails (callers decide whether that is fatal).
 */
export async function sendTemplatedEmail(a: SendTemplatedArgs): Promise<boolean> {
  const def = emailDef(a.key);
  if (def.canDisable) {
    const opts = await getEmailOptions(a.key);
    if (!opts.enabled) return false;
  }
  const lang = await recipientLang(a.to, a.lang);
  const texts = await getEmailTexts(a.key, lang);
  const mail = await renderEmail(def, texts, lang, a.vars);
  await sendEmail({ to: a.to, subject: mail.subject, html: mail.html, text: mail.text, attachments: a.attachments });
  return true;
}

/**
 * sendTemplatedEmail for e-mails sent AFTER the action's change is saved
 * (a reply, a refund, a ticket): a mail-server failure is logged and never
 * turns a completed action into an error.
 */
export async function sendTemplatedEmailSafe(a: SendTemplatedArgs): Promise<boolean> {
  try {
    return await sendTemplatedEmail(a);
  } catch (e) {
    const { logError } = await import('@/lib/observability');
    await logError(`email.${a.key}`, e);
    return false;
  }
}
