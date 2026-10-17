import { AsyncLocalStorage } from 'node:async_hooks';
import nodemailer, { type Transporter } from 'nodemailer';
import { ensureSettingsLoaded } from './settings';
import { prisma } from './db';
import { headerText, plainTextBody } from './email-html';
import { clientIp } from './ratelimit';
import {
  bareAddress,
  bypassesGuards,
  emailDomain,
  guardOutgoing,
  isPermanentRecipientFailure,
  recordPermanentFailure,
  type EmailTrigger,
  type GuardScope,
  type GuardStatus,
} from './email-guard';

import { isDeliverableEmail } from './email-address';

export { isDeliverableEmail };
export type { EmailTrigger };

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface SendEmailParams {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  /** Files attached to the message (e.g. a proforma / invoice PDF). */
  attachments?: EmailAttachment[];
  /** Where replies go (e.g. the support inbox for announcements). */
  replyTo?: string;
  /** Extra MIME headers, e.g. List-Unsubscribe / List-Unsubscribe-Post (RFC 8058). */
  headers?: Record<string, string>;
  /**
   * What makes the site send this e-mail (src/lib/email-guard/rules.ts).
   * Triggers a visitor can cause without signing in (auth.*, form.*) are
   * rate-limited per address / domain / hour. Default: transactional.
   */
  trigger?: EmailTrigger;
}

/** Thrown when no real mail transport is configured (production). */
export class EmailNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Email is not configured: ${reason}`);
    this.name = 'EmailNotConfiguredError';
  }
}

/** Thrown when the anonymous-mail guards refuse an e-mail (nothing was handed to the mail server). */
export class EmailBlockedError extends Error {
  constructor(
    readonly status: GuardStatus,
    readonly scope: GuardScope,
    readonly code: string,
    readonly userMessage: string,
    readonly retryAfterSec: number | undefined,
    reason: string,
  ) {
    super(`Not sent (${status}): ${reason}`);
    this.name = 'EmailBlockedError';
  }
}

/**
 * Guard refusals during one request. better-auth swallows errors thrown by
 * its mail senders, so the auth route runs the endpoint inside
 * `mailRefusals.run([], …)` and reads back what was held back.
 */
export const mailRefusals = new AsyncLocalStorage<EmailBlockedError[]>();

/** The client address of the request that is sending, when there is one (not in cron / scripts). */
async function requestIp(): Promise<string | null> {
  try {
    const ip = await clientIp();
    return ip && ip !== 'unknown' ? ip.slice(0, 64) : null;
  } catch {
    return null;
  }
}

export type EmailTransportStatus = {
  /** A real transport is set up (or the dev capture box outside production). */
  configured: boolean;
  mode: 'resend' | 'smtp' | 'smtp-relay' | 'dev-capture' | 'none';
  /** One line for admin screens, e.g. "SMTP (mail.example.com:465, as user@...)". */
  label: string;
  /** Why it is not configured (production only). */
  problem?: string;
};

const isProduction = () => process.env.NODE_ENV === 'production';
const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? '').trim());

/**
 * Which transport sendEmail will use, read from the live settings. In
 * production there is NO silent fallback: without a Resend key, or an SMTP
 * host with a login (or an explicit "SMTP without login" relay), mail is
 * refused and logged as not_configured — it used to go to an unauthenticated
 * localhost:1025 relay and be logged as "sent". The dev capture mailbox is a
 * development-only convenience.
 */
export function emailTransportStatus(): EmailTransportStatus {
  const from = (process.env.EMAIL_FROM || '').trim();
  const fromAddr = from.match(/<([^>]+)>\s*$/)?.[1] ?? from;
  if (isProduction() && !isDeliverableEmail(fromAddr)) {
    return {
      configured: false,
      mode: 'none',
      label: 'not configured',
      problem: fromAddr
        ? `the From address “${fromAddr}” is a placeholder no mail server accepts — set a real one in Settings → Email`
        : 'no From address — set one in Settings → Email',
    };
  }
  if (process.env.RESEND_API_KEY) return { configured: true, mode: 'resend', label: 'Resend API' };
  const host = (process.env.SMTP_HOST || '').trim();
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    if (isProduction() && !host) {
      return { configured: false, mode: 'none', label: 'not configured', problem: 'an SMTP login is set but the SMTP host is empty' };
    }
    return {
      configured: true,
      mode: 'smtp',
      label: `SMTP (${host || 'localhost'}:${process.env.SMTP_PORT || '465'}, as ${process.env.SMTP_USER})`,
    };
  }
  if (host && truthy(process.env.SMTP_NO_AUTH)) {
    return { configured: true, mode: 'smtp-relay', label: `SMTP relay without login (${host}:${process.env.SMTP_PORT || '25'})` };
  }
  if (isProduction()) {
    return {
      configured: false,
      mode: 'none',
      label: 'not configured',
      problem: 'no Resend API key and no SMTP login, so nothing can be delivered — configure it in Settings → Email',
    };
  }
  return {
    configured: true,
    mode: 'dev-capture',
    label: `development mailbox (${host || 'localhost'}:${process.env.SMTP_PORT || '1025'}) — not delivered to real inboxes`,
  };
}

// Resend HTTP API send — used when RESEND_API_KEY is set.
// The previous SMTP path (smtp.resend.com:2587) is blocked by many cloud
// providers' outbound-SMTP policies (anti-spam) — Vultr, DigitalOcean,
// Hetzner unverified accounts, etc. — which caused submit forms to hang on
// a 30s SMTP CONNECT timeout. HTTPS/443 is always allowed, so going through
// Resend's REST API is the reliable path.
async function sendViaResendHttp(
  from: string,
  to: string,
  subject: string,
  html?: string,
  text?: string,
  attachments?: EmailAttachment[],
  replyTo?: string,
  headers?: Record<string, string>,
): Promise<{ messageId?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  const controller = new AbortController();
  // Attachments make the request body larger — give it a little more time.
  const timeout = setTimeout(() => controller.abort(), attachments?.length ? 30_000 : 15_000);
  let resp: Response;
  try {
    resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(headers ? { headers } : {}),
        // Resend takes base64 file content + filename (+ optional content_type).
        ...(attachments?.length
          ? {
              attachments: attachments.map((a) => ({
                filename: a.filename,
                content: a.content.toString('base64'),
                content_type: a.contentType,
              })),
            }
          : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Resend HTTP ${resp.status}: ${body.slice(0, 240)}`);
  }
  const data = (await resp.json().catch(() => ({}))) as { id?: string };
  return { messageId: data.id };
}

// Built per send so admin-updated keys take effect without a restart.
// Returns null when the HTTP path (Resend) should be used instead.
function buildTransport(status: EmailTransportStatus): Transporter | null {
  // 1) Highest priority handled outside via sendViaResendHttp.
  if (status.mode === 'resend') return null;

  // 2) Real SMTP with credentials (STRATO, Postmark, AWS SES, etc.)
  if (status.mode === 'smtp') {
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    const explicitSecure = process.env.SMTP_SECURE;
    const secure = explicitSecure
      ? explicitSecure === 'true' || explicitSecure === '1'
      : port === 465;
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'localhost',
      port,
      secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // Bound every stage so a hung/slow SMTP server can't pin a request (and
      // its DB connection) open indefinitely — request-side stability.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  // 3) An explicitly configured relay that needs no login (SMTP_NO_AUTH).
  if (status.mode === 'smtp-relay') {
    const port = parseInt(process.env.SMTP_PORT || '25', 10);
    const explicitSecure = process.env.SMTP_SECURE;
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: explicitSecure ? explicitSecure === 'true' || explicitSecure === '1' : port === 465,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  // 4) Development only — local capture mailbox (no auth, no TLS).
  if (status.mode === 'dev-capture') {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'localhost',
      port: parseInt(process.env.SMTP_PORT || '1025', 10),
      secure: false,
      ignoreTLS: true,
    });
  }
  return null;
}

/**
 * Send one email. THROWS when the mail server refuses or the transport fails,
 * so callers that need the outcome can report it. Code that has already
 * written to the database must not let that throw escape — use
 * {@link trySendEmail} (primary recipient, report the outcome) or
 * {@link sendInternalEmail} (staff / company copies, never fatal) instead.
 */
export async function sendEmail({
  to,
  subject: rawSubject,
  html,
  text: rawText,
  attachments,
  replyTo,
  headers,
  trigger = 'transactional',
}: SendEmailParams): Promise<void> {
  await ensureSettingsLoaded();
  const status = emailTransportStatus();
  const logMeta = { trigger, toDomain: emailDomain(to) || null, ip: await requestIp() };
  // Blocked / throw-away domains, suppressed addresses and the limits on
  // e-mails visitors can trigger: refused before anything reaches the mail
  // server, and logged like a failed send so the trail stays complete.
  const guard = await guardOutgoing(to, trigger);
  if (!guard.ok) {
    try {
      await prisma.emailLog.create({
        data: { toAddr: to, subject: headerText(rawSubject, 250), status: guard.status, error: guard.reason.slice(0, 500), ...logMeta },
      });
    } catch {
      /* best effort */
    }
    const refusal = new EmailBlockedError(guard.status, guard.scope, guard.code, guard.message, guard.retryAfterSec, guard.reason);
    mailRefusals.getStore()?.push(refusal);
    throw refusal;
  }
  // Subjects often carry user-typed parts (ticket subject, item title): keep
  // the header single-line and bounded. Callers escape their own HTML.
  const subject = headerText(rawSubject, 250);
  const text = rawText === undefined ? undefined : plainTextBody(rawText);
  // Outside production a missing From falls back to a dev placeholder; in
  // production emailTransportStatus() refuses to send without a real one.
  const addr = process.env.EMAIL_FROM || 'no-reply@lab2date.local';
  const name = headerText(process.env.SITE_NAME || 'Labtodate', 80).replace(/"/g, '') || 'Labtodate';
  const from = addr.includes('<') ? addr : `"${name}" <${addr}>`;
  // Attachment filenames end up in a MIME header: keep them single-line and safe.
  const files = attachments?.map((a) => ({
    ...a,
    filename: headerText(a.filename, 120).replace(/[\\/"]/g, '_') || 'attachment',
  }));
  const reply = replyTo && isDeliverableEmail(replyTo) ? replyTo : undefined;
  const extraHeaders = headers
    ? Object.fromEntries(Object.entries(headers).map(([k, v]) => [headerText(k, 80), headerText(v, 900)]))
    : undefined;
  let result: { messageId?: string } | undefined;
  let sendError: Error | null = null;
  try {
    if (!status.configured) throw new EmailNotConfiguredError(status.problem ?? 'no mail transport');
    if (status.mode === 'resend') {
      result = await sendViaResendHttp(from, to, subject, html, text, files, reply, extraHeaders);
    } else {
      const t = buildTransport(status);
      if (!t) throw new EmailNotConfiguredError('no mail transport');
      result = await t.sendMail({
        from,
        to,
        subject,
        html,
        text,
        ...(reply ? { replyTo: reply } : {}),
        ...(extraHeaders ? { headers: extraHeaders } : {}),
        ...(files?.length
          ? { attachments: files.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) }
          : {}),
      });
    }
  } catch (e) {
    sendError = e instanceof Error ? e : new Error(String(e));
    // "No such mailbox" and the like: stop sending there (staff copies excepted).
    if (!bypassesGuards(trigger) && isPermanentRecipientFailure(e)) {
      await recordPermanentFailure(bareAddress(to), sendError.message).catch(() => false);
    }
  }
  // Persist an audit row regardless of outcome so ops has a trail when a
  // recipient says "I never got it." The DB write is itself try/catch'd —
  // if the DB is unreachable we still surface the original send error.
  try {
    await prisma.emailLog.create({
      data: {
        toAddr: to,
        subject: files?.length ? `${subject} [+${files.map((f) => f.filename).join(', ')}]`.slice(0, 500) : subject,
        status: sendError instanceof EmailNotConfiguredError ? 'not_configured' : sendError ? 'failed' : 'sent',
        error: sendError ? sendError.message.slice(0, 500) : null,
        messageId: result?.messageId ?? null,
        ...logMeta,
      },
    });
  } catch {
    // Logging is best-effort; never let it mask the real send result.
  }
  if (sendError) throw sendError;
}

export type EmailOutcome =
  | { ok: true }
  | { ok: false; skipped: true; error: string }
  | { ok: false; skipped?: false; error: string };

/** One short, human-readable line for a failed send (e.g. "550 5.1.1 recipient rejected"). */
export function emailErrorSummary(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const flat = msg.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat || 'unknown error';
}

/**
 * Send without throwing and return what happened. For the PRIMARY recipient of
 * an action that has already been saved: the caller reports a failure
 * truthfully ("Saved, but the email to x could not be delivered") instead of
 * pretending the whole action failed.
 */
export async function trySendEmail(params: SendEmailParams, context = 'email'): Promise<EmailOutcome> {
  try {
    await sendEmail(params);
    return { ok: true };
  } catch (e) {
    console.error(`[${context}] email to ${params.to} failed:`, emailErrorSummary(e));
    return { ok: false, error: emailErrorSummary(e) };
  }
}

/**
 * Staff / company / intake copies ("[copy] Proforma", "New quote request", the
 * billing BCC on invoices…). Skipped when the address is a placeholder that no
 * real mail server accepts (COMPANY_EMAIL defaults to billing@lab2date.local),
 * and NEVER fatal: a rejected copy is logged and the caller carries on — it
 * must never turn a completed action into "not sent".
 */
export async function sendInternalEmail(params: SendEmailParams, context = 'internal-email'): Promise<EmailOutcome> {
  if (!isDeliverableEmail(params.to)) {
    return { ok: false, skipped: true, error: `skipped: ${params.to || '(no address)'} is not a deliverable address` };
  }
  return trySendEmail({ trigger: 'internal', ...params }, context);
}

/** The billing / company inbox for document copies, or null when unset or a placeholder. */
export function companyCopyAddress(): string | null {
  const addr = (process.env.COMPANY_EMAIL || '').trim();
  return isDeliverableEmail(addr) ? addr : null;
}
