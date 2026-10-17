import { trySendEmail, type EmailAttachment } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { mailLayout, mailTable, siteBase } from '@/lib/quotes/mail';

/**
 * Buyer emails of the fulfilment / returns & refunds area. One branded layout
 * (lib/quotes/mail.ts), texts from Settings (plain text, escaped here), and an
 * outcome the caller reports truthfully to the person who acted.
 * Server-internal — never import from a client component.
 */

export type MailOutcome = { ok: true; to: string } | { ok: false; to: string; error: string; skipped: boolean };

/** Settings text (plain, may have line breaks) → escaped paragraphs. */
export function textParagraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split(/\r?\n/).map((l) => escapeHtml(l)).join('<br>'));
}

export function orderUrl(orderNumber: string): string {
  return `${siteBase()}/app/orders/${orderNumber}`;
}

export async function sendBuyerMail(p: {
  to: string;
  subject: string;
  heading: string;
  /** Plain settings text, escaped and split into paragraphs. */
  text?: string;
  /** Extra paragraphs, ALREADY escaped HTML. */
  html?: string[];
  table?: Array<[string, string, boolean?]>;
  cta?: { href: string; label: string } | null;
  footer?: string[];
  attachments?: EmailAttachment[];
  context: string;
}): Promise<MailOutcome> {
  // The buyer is the PRIMARY recipient: always attempted (like the invoice and
  // quote emails) and the mail server's answer is reported — never skipped silently.
  const to = (p.to ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, to, error: 'no email address on the account', skipped: true };
  const body = [
    ...(p.text ? textParagraphs(p.text) : []),
    ...(p.table && p.table.length ? [mailTable(p.table)] : []),
    ...(p.html ?? []),
  ];
  const html = mailLayout({ heading: p.heading, body, cta: p.cta ?? null, footer: p.footer });
  const plain = [p.text ?? '', ...(p.table ?? []).map(([l, v]) => `${l.replace(/<[^>]+>/g, '')}: ${v.replace(/<[^>]+>/g, '')}`), p.cta ? `${p.cta.label}: ${p.cta.href}` : ''].filter(Boolean).join('\n\n');
  const r = await trySendEmail({ to, subject: p.subject, html, text: plain, attachments: p.attachments ?? [] }, p.context);
  return r.ok ? { ok: true, to } : { ok: false, to, error: r.error, skipped: false };
}

/** One sentence for the staff member who acted. */
export function mailOutcomeText(r: MailOutcome, who = 'The buyer'): string {
  if (r.ok) return `${who} was emailed (${r.to}).`;
  if (r.skipped) return `${who} has no deliverable email address — notified in-app only.`;
  return `The email to ${r.to} could NOT be delivered (${r.error}) — the in-app notification went out; contact the buyer another way if it matters.`;
}
