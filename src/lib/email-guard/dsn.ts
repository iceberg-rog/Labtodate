/**
 * Delivery status notifications (DSN, RFC 3464) — the bounce reports a mail
 * server e-mails back when it accepted a message but could not deliver it.
 * TransIP (production's SMTP) accepts every recipient at RCPT time and sends
 * these to the sending mailbox later, so the synchronous check in sendEmail
 * (isPermanentRecipientFailure) rarely sees a rejection; the bounce mailbox
 * reader (./bounce-mailbox.ts) feeds these reports to the same suppression.
 *
 * Pure apart from parsing with mailparser (no DB, no network); unit-tested in
 * dsn.test.ts against real reports.
 */

import { simpleParser, type ParsedMail } from 'mailparser';
import { bareAddress, replySaysAddressInvalid, statusCodes } from './rules';

/**
 * What a recipient's report means for us:
 *  - permanent: the mailbox or its domain does not exist / is disabled (counts towards suppression);
 *  - temporary: 4.x.x or "delayed" — the server keeps trying, nothing to do;
 *  - policy:    5.7.x — refused because of us (spam filter, SPF/DMARC, blocklist), not the address;
 *  - other:     another permanent failure about the message or a full mailbox (too big, content …);
 *  - delivered: a success report (delivered / relayed / expanded).
 */
export type DsnVerdict = 'permanent' | 'temporary' | 'policy' | 'other' | 'delivered';

export type DsnRecipient = {
  /** Final-Recipient, bare and lower-cased. */
  finalRecipient: string;
  /** Original-Recipient (the address we sent to, when the server rewrote it), or null. */
  originalRecipient: string | null;
  action: string | null;
  /** Enhanced status code (Status field, else the one in Diagnostic-Code), e.g. 5.1.1. */
  status: string | null;
  diagnostic: string | null;
  remoteMta: string | null;
  verdict: DsnVerdict;
};

export type ParsedDsn = {
  /** Message-ID of the report itself (without <>), or null. */
  reportId: string | null;
  /** Sender of the report, e.g. mailer-daemon@…. */
  reportFrom: string | null;
  reportingMta: string | null;
  /** Message-ID of the e-mail that bounced (from the returned message or its headers, without <>), or null. */
  originalMessageId: string | null;
  originalSubject: string | null;
  recipients: DsnRecipient[];
};

const STATUS = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;
const ADDRESS = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const DELIVERY_STATUS_TYPES = new Set(['message/delivery-status', 'message/global-delivery-status']);
const RETURNED_MESSAGE_TYPES = new Set(['message/rfc822', 'message/global', 'text/rfc822-headers', 'message/global-headers']);

/**
 * Header-style field groups ("Name: value", folded continuation lines,
 * groups separated by an empty line) — the body of a message/delivery-status
 * part, or the header block of a message. Names are lower-cased; the first
 * occurrence of a name in a group wins. Pure.
 */
export function parseFieldGroups(text: string): Record<string, string>[] {
  const groups: Record<string, string>[] = [];
  let group: Record<string, string> = {};
  let last: string | null = null;
  const flush = () => {
    if (Object.keys(group).length) groups.push(group);
    group = {};
    last = null;
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^[ \t]/.test(line)) {
      if (last) group[last] = `${group[last]} ${line.trim()}`.trim();
      continue;
    }
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (!m) {
      last = null;
      continue;
    }
    const name = m[1].toLowerCase();
    if (name in group) {
      last = null; // keep the first one; skip this field's continuation lines too
      continue;
    }
    group[name] = m[2].trim();
    last = name;
  }
  flush();
  return groups;
}

/** "rfc822; a@b.c" → "a@b.c" (the address type is optional in practice). */
function typedValue(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.includes(';') ? v.slice(v.indexOf(';') + 1) : v;
  return s.trim() || null;
}

function addressOf(v: string | undefined): string | null {
  const raw = typedValue(v);
  if (!raw) return null;
  const a = bareAddress(raw.replace(/^<|>$/g, ''));
  return ADDRESS.test(a) && a.length <= 254 ? a : null;
}

function stripId(v: string | undefined | null): string | null {
  const s = (v ?? '').trim().replace(/^<|>$/g, '').trim();
  return s && s.length <= 500 ? s : null;
}

/**
 * Classify one recipient of a report with the same rule as synchronous
 * rejections (replySaysAddressInvalid): only failures about the address
 * itself count; 5.7.x policy refusals never do. Pure.
 */
export function classifyDsnRecipient(r: { action?: string | null; status?: string | null; diagnostic?: string | null }): DsnVerdict {
  const action = (r.action ?? '').trim().toLowerCase();
  const diagnostic = r.diagnostic ?? '';
  const status = STATUS.exec(r.status ?? '')?.[0] ?? STATUS.exec(diagnostic)?.[0] ?? null;
  if (action === 'delayed') return 'temporary';
  if (['delivered', 'deliverable', 'relayed', 'expanded'].includes(action)) return 'delivered';
  const reply = /^\s*(?:smtp;\s*)?([245])\d\d\b/i.exec(diagnostic)?.[1];
  const cls = status?.[0] ?? reply ?? (action === 'failed' ? '5' : null);
  if (cls === '2') return 'delivered';
  if (cls === '4') return 'temporary';
  if (cls !== '5') return 'other';
  // A generic 5.0.0 often wraps the remote server's own, more precise code.
  const text = `${status ?? ''} ${diagnostic}`;
  if (statusCodes(text).some((c) => c.startsWith('5.7.'))) return 'policy';
  return replySaysAddressInvalid(text, true) ? 'permanent' : 'other';
}

function isDeliveryReport(mail: ParsedMail): boolean {
  const ct = mail.headers.get('content-type') as { value?: string; params?: Record<string, string> } | undefined;
  if (ct?.value?.toLowerCase() === 'multipart/report' && /delivery-status/i.test(ct.params?.['report-type'] ?? '')) return true;
  return mail.attachments.some((a) => DELIVERY_STATUS_TYPES.has(a.contentType.toLowerCase()));
}

/** Message-ID and subject of the returned message (message/rfc822 or text/rfc822-headers part). */
async function returnedMessage(mail: ParsedMail): Promise<{ messageId: string | null; subject: string | null } | null> {
  const part = mail.attachments.find((a) => RETURNED_MESSAGE_TYPES.has(a.contentType.toLowerCase()) && a.content.length > 0);
  if (!part) return null;
  const text = part.content.toString('utf8');
  const end = text.search(/\r?\n\r?\n/);
  // Only the header block (decodes encoded subjects, unfolds lines).
  const head = await simpleParser(`${end < 0 ? text : text.slice(0, end)}\r\n\r\n`, { skipHtmlToText: true, skipTextToHtml: true });
  return { messageId: stripId(head.messageId), subject: head.subject?.slice(0, 300) ?? null };
}

/**
 * Parse an e-mail; returns null when it is not a delivery status report
 * (no multipart/report; report-type=delivery-status and no
 * message/delivery-status part — e.g. a person's mail, an auto-reply, or an
 * old plain-text bounce, which are left alone).
 */
export async function parseDsn(source: Buffer | string): Promise<ParsedDsn | null> {
  const mail = await simpleParser(source, {
    keepDeliveryStatus: true,
    // Keep a returned message/rfc822 as one part so its headers can be read.
    ignoreEmbedded: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    skipTextLinks: true,
  } as Parameters<typeof simpleParser>[1]);
  if (!isDeliveryReport(mail)) return null;

  const status = mail.attachments.find((a) => DELIVERY_STATUS_TYPES.has(a.contentType.toLowerCase()));
  const groups = status ? parseFieldGroups(status.content.toString('utf8')) : [];
  // The first group holds the per-message fields; every later one with a
  // Final-Recipient is one recipient. Some servers omit the per-message group.
  const perMessage = groups[0] && !groups[0]['final-recipient'] ? groups[0] : {};
  const recipients: DsnRecipient[] = [];
  for (const g of groups) {
    const finalRecipient = addressOf(g['final-recipient']);
    if (!finalRecipient) continue;
    const r = {
      finalRecipient,
      originalRecipient: addressOf(g['original-recipient']),
      action: g['action']?.toLowerCase() ?? null,
      status: STATUS.exec(g['status'] ?? '')?.[0] ?? STATUS.exec(g['diagnostic-code'] ?? '')?.[0] ?? null,
      diagnostic: typedValue(g['diagnostic-code'])?.slice(0, 500) ?? null,
      remoteMta: typedValue(g['remote-mta']),
    };
    recipients.push({ ...r, verdict: classifyDsnRecipient({ action: r.action, status: g['status'] ?? r.status, diagnostic: r.diagnostic }) });
  }

  const original = await returnedMessage(mail).catch(() => null);
  return {
    reportId: stripId(mail.messageId),
    reportFrom: mail.from?.value?.[0]?.address?.toLowerCase() ?? null,
    reportingMta: typedValue(perMessage['reporting-mta']),
    originalMessageId: original?.messageId ?? null,
    originalSubject: original?.subject ?? null,
    recipients,
  };
}
