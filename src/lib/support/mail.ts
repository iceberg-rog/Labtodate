import { escapeHtml, escapeHtmlLines } from '@/lib/email-html';
import { mailLayout } from '@/lib/quotes/mail';
import { siteName } from '@/lib/brand/identity';
import { magicLinkDays, supportDate, supportReplyPromise } from './policy';

/**
 * Customer e-mails of the support tickets, on the shared branded layout
 * (mailLayout). Replies to these e-mails are not threaded into the ticket yet
 * (inbound mail, PKG-26), so every mail sends the customer to the ticket page
 * to answer. Callers pass the deep link (guest magic link or
 * /app/support?open=<ref>). Read after ensureSettingsLoaded().
 */

const files = (n: number) => `${n} attachment${n === 1 ? '' : 's'}`;
const quote = (text: string) =>
  `<blockquote style="border-left:3px solid #A3E635;margin:0 0 12px;padding-left:12px;color:#4b5563;">${escapeHtmlLines(text)}</blockquote>`;

/** Acknowledgement of a new ticket. `echo` = the address is the signed-in account's own (safe to repeat the text). */
export function ticketReceivedMail(p: {
  ref: string;
  name: string;
  subject: string;
  body: string;
  echo: boolean;
  guest: boolean;
  href: string;
  attachments: number;
}): string {
  const promise = supportReplyPromise();
  const body = [
    `Your support request has been logged with reference <strong>${escapeHtml(p.ref)}</strong>.`,
    ...(p.echo ? [`<p style="margin:0 0 6px;"><strong>${escapeHtml(p.subject)}</strong></p>`, quote(p.body)] : []),
    ...(p.attachments > 0 ? [`We received ${files(p.attachments)} with it.`] : []),
    promise ? `Our team replies within ${escapeHtml(promise)}; you get an e-mail when we do.` : 'You get an e-mail when our team replies.',
  ];
  return mailLayout({
    heading: p.echo ? `We’re on it, ${p.name}` : 'We received your request',
    body,
    cta: { href: p.href, label: p.guest ? 'View or add to your ticket' : 'Open your ticket' },
    footer: [
      'To add information, use the button above — it goes straight into your ticket.',
      ...(p.guest ? [`This link is private to your ticket and valid for ${magicLinkDays()} days; every reply from us renews it. Keep it to yourself.`] : []),
      ...(p.echo ? [] : [`If you didn’t contact ${escapeHtml(siteName())} support, you can ignore this e-mail.`]),
    ],
  });
}

/** A staff reply on the ticket. */
export function staffReplyMail(p: {
  ref: string;
  subject: string;
  body: string;
  attachments: number;
  href: string;
  linkValidUntil: Date | null;
}): string {
  return mailLayout({
    heading: `Re: ${p.subject}`,
    body: [
      ...(p.body ? [`<div style="font-size:14px;line-height:1.7;margin:0 0 12px;">${escapeHtmlLines(p.body)}</div>`] : []),
      ...(p.attachments > 0 ? [`This reply comes with ${files(p.attachments)} — open your ticket to view ${p.attachments === 1 ? 'it' : 'them'}.`] : []),
    ],
    cta: { href: p.href, label: 'Reply on your ticket page' },
    footer: [
      `Reference ${escapeHtml(p.ref)}. Please answer through your ticket page so your reply reaches the team handling this request.`,
      ...(p.linkValidUntil ? [`Your private link is valid until ${supportDate(p.linkValidUntil)}.`] : []),
    ],
  });
}

/** The ticket was resolved or closed: how to reopen it. */
export function ticketStatusMail(p: {
  ref: string;
  subject: string;
  status: 'RESOLVED' | 'CLOSED';
  href: string;
  reopenUntil: Date;
}): string {
  const word = p.status === 'RESOLVED' ? 'resolved' : 'closed';
  return mailLayout({
    heading: `Your request ${p.ref} is ${word}`,
    body: [
      `Our team marked your request “${escapeHtml(p.subject)}” as ${word}.`,
      `Not sorted yet? Reply on your ticket page until <strong>${supportDate(p.reopenUntil)}</strong> and the ticket reopens. After that, please open a new ticket and mention ${escapeHtml(p.ref)}.`,
    ],
    cta: { href: p.href, label: 'Open your ticket' },
    footer: [`Reference ${escapeHtml(p.ref)}.`],
  });
}

/** A new private link for a guest ticket (requested by the guest, or rotated by staff). */
export function freshLinkMail(p: { ref: string; name: string; href: string; byStaff: boolean; validUntil: Date }): string {
  return mailLayout({
    heading: `Here’s a fresh link, ${p.name}`,
    body: [
      p.byStaff
        ? `Our support team renewed the private link to ticket <strong>${escapeHtml(p.ref)}</strong>. Any previous link no longer works.`
        : `You asked for a new link to ticket <strong>${escapeHtml(p.ref)}</strong>. Any previous link no longer works.`,
    ],
    cta: { href: p.href, label: `View ticket ${p.ref}` },
    footer: [
      `This link is valid until ${supportDate(p.validUntil)}. Keep it private.`,
      ...(p.byStaff ? [] : [`If you didn’t ask for it, you can ignore this e-mail — only this address receives the link.`]),
    ],
  });
}
