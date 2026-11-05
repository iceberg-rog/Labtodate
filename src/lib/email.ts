import nodemailer, { type Transporter } from 'nodemailer';
import { ensureSettingsLoaded } from './settings';
import { prisma } from './db';
import { headerText, plainTextBody } from './email-html';

// Seed and importer accounts use placeholder addresses (sales@<shop>.import,
// *.example, *.local) that real mail servers reject outright. Callers that
// notify a seller check this and route to an intake inbox instead.
const PLACEHOLDER_TLDS = new Set(['import', 'example', 'ex', 'local', 'localhost', 'test', 'invalid']);

export function isDeliverableEmail(addr: string | null | undefined): addr is string {
  const m = /@[^@\s]+\.([a-z0-9-]+)$/i.exec((addr ?? '').trim());
  return !!m && !PLACEHOLDER_TLDS.has(m[1].toLowerCase());
}

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
  /** Files sent with the message (issued PDFs). */
  attachments?: EmailAttachment[];
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
): Promise<{ messageId?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
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
        ...(attachments?.length
          ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), content_type: a.contentType })) }
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
function buildTransport(): Transporter | null {
  // 1) Highest priority handled outside via sendViaResendHttp.
  if (process.env.RESEND_API_KEY) return null;

  // 2) Real SMTP with credentials (STRATO, Postmark, AWS SES, etc.)
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
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

  // 3) Fallback — Mailpit / dev capture (no auth, no TLS).
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT || '1025', 10),
    secure: false,
    ignoreTLS: true,
  });
}

/**
 * The From address: EMAIL_FROM, else the support / company inbox, else
 * no-reply@ the site's own domain — never a made-up domain (it used to be
 * no-reply@lab2date.local, which receiving servers reject or spam-file).
 */
function senderAddress(): string {
  const set = (process.env.EMAIL_FROM || process.env.SUPPORT_EMAIL || process.env.COMPANY_EMAIL || '').trim();
  if (set) return set;
  let host = 'labtodate.com';
  try {
    host = new URL(process.env.BETTER_AUTH_URL || 'https://labtodate.com').hostname.replace(/^www\./, '') || host;
  } catch {
    /* keep the default */
  }
  return `no-reply@${host}`;
}

export async function sendEmail({ to, subject: rawSubject, html, text: rawText, attachments }: SendEmailParams): Promise<void> {
  await ensureSettingsLoaded();
  // Subjects often carry user-typed parts (ticket subject, item title): keep
  // the header single-line and bounded. Callers escape their own HTML.
  const subject = headerText(rawSubject, 250);
  const text = rawText === undefined ? undefined : plainTextBody(rawText);
  const addr = senderAddress();
  const name = headerText(process.env.SITE_NAME || 'Labtodate', 80).replace(/"/g, '') || 'Labtodate';
  const from = addr.includes('<') ? addr : `"${name}" <${addr}>`;
  let result: { messageId?: string } | undefined;
  let sendError: Error | null = null;
  try {
    if (process.env.RESEND_API_KEY) {
      result = await sendViaResendHttp(from, to, subject, html, text, attachments);
    } else {
      const t = buildTransport();
      if (!t) throw new Error('No mail transport configured.');
      result = await t.sendMail({
        from,
        to,
        subject,
        html,
        text,
        attachments: attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
    }
  } catch (e) {
    sendError = e instanceof Error ? e : new Error(String(e));
  }
  // Persist an audit row regardless of outcome so ops has a trail when a
  // recipient says "I never got it." The DB write is itself try/catch'd —
  // if the DB is unreachable we still surface the original send error.
  try {
    await prisma.emailLog.create({
      data: {
        toAddr: to,
        subject: attachments?.length ? `${subject} [+${attachments.map((a) => a.filename).join(', ')}]`.slice(0, 500) : subject,
        status: sendError ? 'failed' : 'sent',
        error: sendError ? sendError.message.slice(0, 500) : null,
        messageId: result?.messageId ?? null,
      },
    });
  } catch {
    // Logging is best-effort; never let it mask the real send result.
  }
  if (sendError) throw sendError;
}
