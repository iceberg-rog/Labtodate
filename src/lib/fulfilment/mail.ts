import { sendInternalEmail, trySendEmail, type EmailAttachment } from '@/lib/email';
import { isDeliverableEmail } from '@/lib/email-address';
import { escapeHtml } from '@/lib/email-html';
import { settingString } from '@/lib/settings';
import { mailLayout, mailTable, siteBase } from '@/lib/quotes/mail';

/**
 * Buyer and staff emails of the fulfilment / returns & refunds area. One branded
 * layout (lib/quotes/mail.ts) for every mail here — buyer, accounts payable and
 * staff — texts from Settings (plain text, escaped here), and an outcome the
 * caller reports truthfully to the person who acted.
 * Server-internal — never import from a client component.
 */

export type MailOutcome =
  | { ok: true; to: string; /** Not sent again: this mail already went out for the same record. */ already?: boolean }
  | { ok: false; to: string; error: string; skipped: boolean };

/** Settings text (plain, may have line breaks) → escaped paragraphs. */
export function textParagraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split(/\r?\n/).map((l) => escapeHtml(l)).join('<br>'));
}

/** An absolute link to a page of this site (mail clients need one). */
export function siteUrl(path: string): string {
  return `${siteBase()}${path}`;
}

export function orderUrl(orderNumber: string): string {
  return siteUrl(`/app/orders/${orderNumber}`);
}

/** The buyer's support tickets (where an RMA conversation lives). */
export function supportTicketsUrl(): string {
  return siteUrl('/app/support');
}

/** The monitored mailbox replies to customer mails go to (Settings → Email), or null: then mails come from a no-reply sender. */
export function transactionalReplyTo(): string | null {
  const v = settingString('TRANSACTIONAL_REPLY_TO').trim();
  return isDeliverableEmail(v) ? v : null;
}

/**
 * How the buyer reaches us about a mail, as escaped HTML that fits after “If …,”:
 * “reply to this e-mail” only when replies reach a monitored mailbox, else the
 * support page — never a promise the no-reply sender can not keep.
 */
export function contactUsHtml(): string {
  if (transactionalReplyTo()) return 'reply to this e-mail';
  const base = siteBase();
  return base ? `contact us through our <a href="${escapeHtml(`${base}/support`)}">support page</a>` : 'contact us through the support page on our website';
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
  /** Default: Settings → Email → “Replies to customer e-mails go to” (none = no Reply-To). */
  replyTo?: string | null;
  context: string;
}): Promise<MailOutcome> {
  // The buyer is the PRIMARY recipient: always attempted (like the invoice and
  // quote emails) and the mail server's answer is reported — never skipped silently.
  const to = (p.to ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, to, error: 'no email address on the account', skipped: true };
  const { html, plain } = render(p);
  const replyTo = p.replyTo === undefined ? transactionalReplyTo() : p.replyTo;
  const r = await trySendEmail({ to, subject: p.subject, html, text: plain, attachments: p.attachments ?? [], ...(replyTo ? { replyTo } : {}) }, p.context);
  return r.ok ? { ok: true, to } : { ok: false, to, error: r.error, skipped: false };
}

/** A staff / company inbox mail (intake, [copy]) in the same layout; skipped when the address is a placeholder, never fatal. */
export async function sendStaffMail(p: {
  to: string | null | undefined;
  subject: string;
  heading: string;
  text?: string;
  html?: string[];
  table?: Array<[string, string, boolean?]>;
  cta?: { href: string; label: string } | null;
  attachments?: EmailAttachment[];
  context: string;
}): Promise<void> {
  const to = (p.to ?? '').trim();
  if (!to) return;
  const { html, plain } = render(p);
  await sendInternalEmail({ to, subject: p.subject, html, ...(plain ? { text: plain } : {}), attachments: p.attachments ?? [] }, p.context);
}

function render(p: { heading: string; text?: string; html?: string[]; table?: Array<[string, string, boolean?]>; cta?: { href: string; label: string } | null; footer?: string[] }) {
  const body = [
    ...(p.text ? textParagraphs(p.text) : []),
    ...(p.table && p.table.length ? [mailTable(p.table)] : []),
    ...(p.html ?? []),
  ];
  const html = mailLayout({ heading: p.heading, body, cta: p.cta ?? null, footer: p.footer });
  const plain = [p.text ?? '', ...(p.table ?? []).map(([l, v]) => `${l.replace(/<[^>]+>/g, '')}: ${v.replace(/<[^>]+>/g, '')}`), p.cta ? `${p.cta.label}: ${p.cta.href}` : ''].filter(Boolean).join('\n\n');
  return { html, plain };
}

/** One sentence for the staff member who acted. */
export function mailOutcomeText(r: MailOutcome, who = 'The buyer'): string {
  if (r.ok && r.already) return `${who} was already emailed about this (${r.to}) — not sent twice.`;
  if (r.ok) return `${who} was emailed (${r.to}).`;
  if (r.skipped) return `${who} has no deliverable email address — notified in-app only.`;
  return `The email to ${r.to} could NOT be delivered (${r.error}) — the in-app notification went out; contact the buyer another way if it matters.`;
}
