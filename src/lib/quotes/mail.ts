import { escapeHtml } from '@/lib/email-html';
import { isDeliverableEmail } from '@/lib/email-address';
import { legalIdentity, type LegalIdentity } from '@/lib/brand/identity';
import { emailBrandColor } from '@/lib/brand/color';
import { ensureSettingsLoaded, settingString } from '@/lib/settings';

/**
 * The ONE branded layout for customer e-mails (account, quote, payment, order
 * and ticket mails, staff notices): the uploaded logo (else the site name) on
 * top, the brand colour from Settings → Brand, and a footer with the seller's
 * legal identity from Settings → Company (legal name, address, KvK, VAT,
 * support e-mail, website), as Dutch law asks of business mail (BW 3:15d).
 * Callers escape their own user-typed values; `html` parts are inserted as
 * given. Synchronous: reads the settings hydrated by ensureSettingsLoaded().
 */

export function siteBase(): string {
  return (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
}

/** Heading / link / button colour of every e-mail (EMAIL_BRAND_COLOR, else the default green). */
export function mailBrandColor(): string {
  return emailBrandColor(settingString('EMAIL_BRAND_COLOR'));
}

/** The seller identity under every e-mail: only the fields that are filled in. */
function legalLines(id: LegalIdentity) {
  return {
    name: [id.displayName, id.addressLines.join(', ')].filter(Boolean).join(', '),
    numbers: [id.kvk ? `KvK ${id.kvk}` : '', id.vat ? `VAT ${id.vat}` : ''].filter(Boolean).join(' · '),
    email: id.supportEmail,
    web: id.websiteUrl,
    webLabel: id.websiteUrl.replace(/^https?:\/\//i, ''),
  };
}

/** The legal footer as plain text, for the text part of an e-mail. */
export function mailTextFooter(id: LegalIdentity = legalIdentity()): string {
  const l = legalLines(id);
  return ['—', l.name, l.numbers, [l.email, l.webLabel].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
}

/**
 * How a customer reaches a person from an e-mail. With TRANSACTIONAL_REPLY_TO
 * set, every customer e-mail carries it as Reply-To and may say “reply to this
 * e-mail”; without it (see the setting's hint) the e-mail points to the
 * support page instead of promising that a reply is read.
 */
export function replyHint(): { invitesReply: boolean; html: string; text: string } {
  if (isDeliverableEmail(settingString('TRANSACTIONAL_REPLY_TO').trim())) {
    return { invitesReply: true, html: 'Just reply to this e-mail.', text: 'Just reply to this e-mail.' };
  }
  const url = `${siteBase()}/support`;
  return {
    invitesReply: false,
    html: `Contact us via <a href="${escapeHtml(url)}" style="color:${mailBrandColor()};">our support page</a>.`,
    text: `Contact us via ${url}.`,
  };
}

export function mailLayout(p: {
  heading: string;
  /** Paragraph HTML strings (already escaped where needed). */
  body: string[];
  cta?: { href: string; label: string } | null;
  /** Small grey lines under the button. */
  footer?: string[];
}): string {
  const id = legalIdentity();
  const brand = mailBrandColor();
  const site = escapeHtml(id.siteName);
  // Mail clients need an absolute logo URL; without one the site name is the header.
  const mark = id.logoAbsoluteUrl
    ? `<img src="${escapeHtml(id.logoAbsoluteUrl)}" alt="${site}" height="40" style="display:block;height:40px;width:auto;max-width:220px;border:0;outline:none;text-decoration:none;">`
    : `<span style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${brand};">${site}</span>`;
  const l = legalLines(id);
  const contact = [
    l.email ? `<a href="mailto:${escapeHtml(l.email)}" style="color:#6b7280;">${escapeHtml(l.email)}</a>` : '',
    l.web ? `<a href="${escapeHtml(l.web)}" style="color:#6b7280;">${escapeHtml(l.webLabel)}</a>` : '',
  ].filter(Boolean);
  const legal = [escapeHtml(l.name), escapeHtml(l.numbers), contact.join(' · ')].filter(Boolean);
  return `
<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:580px;color:#111827;line-height:1.5;">
  <div style="margin:0 0 18px;">${l.web ? `<a href="${escapeHtml(l.web)}" style="text-decoration:none;">${mark}</a>` : mark}</div>
  <h2 style="color:${brand};margin:0 0 12px;font-size:20px;">${escapeHtml(p.heading)}</h2>
  ${p.body.map((b) => (b.trim().startsWith('<') ? b : `<p style="margin:0 0 12px;">${b}</p>`)).join('\n  ')}
  ${p.cta ? `<p style="margin:20px 0;"><a href="${escapeHtml(p.cta.href)}" style="background:${brand};color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">${escapeHtml(p.cta.label)}</a></p>` : ''}
  ${(p.footer ?? []).map((f) => `<p style="margin:6px 0 0;color:#6b7280;font-size:12px;">${f}</p>`).join('\n  ')}
  <div style="margin:24px 0 0;padding:12px 0 0;border-top:1px solid #e5e7eb;color:#6b7280;font-size:11px;line-height:1.6;">
    ${legal.map((line) => `<div>${line}</div>`).join('\n    ')}
  </div>
</div>`;
}

/**
 * A whole e-mail (subject, HTML in the layout above, text part with the legal
 * footer) after loading the live settings; `build` gets the site name
 * (SITE_NAME) for subject and copy. Spread the result into sendEmail().
 */
export async function brandedMail(
  build: (site: string) => {
    subject: string;
    heading: string;
    body: string[];
    cta?: { href: string; label: string } | null;
    footer?: string[];
    text: string;
  },
): Promise<{ subject: string; html: string; text: string }> {
  await ensureSettingsLoaded();
  const m = build(legalIdentity().siteName);
  return {
    subject: m.subject,
    html: mailLayout({ heading: m.heading, body: m.body, cta: m.cta, footer: m.footer }),
    text: `${m.text}\n\n${mailTextFooter()}`,
  };
}

/** A label/value table (amounts, terms) for emails. */
export function mailTable(rows: Array<[string, string, boolean?]>): string {
  return `<table style="border-collapse:collapse;font-size:14px;margin:6px 0 14px;">${rows
    .map(([l, v, strong]) => `<tr><td style="padding:3px 18px 3px 0;color:#4b5563;vertical-align:top;">${l}</td><td style="padding:3px 0;text-align:right;${strong ? 'font-weight:700;font-size:16px;' : ''}">${v}</td></tr>`)
    .join('')}</table>`;
}
