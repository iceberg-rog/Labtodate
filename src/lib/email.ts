import nodemailer, { type Transporter } from 'nodemailer';
import { ensureSettingsLoaded } from './settings';
import { prisma } from './db';

interface SendEmailParams {
  to: string;
  subject: string;
  html?: string;
  text?: string;
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
      body: JSON.stringify({ from, to, subject, html, text }),
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

export async function sendEmail({ to, subject, html, text }: SendEmailParams): Promise<void> {
  await ensureSettingsLoaded();
  const addr = process.env.EMAIL_FROM || 'no-reply@lab2date.local';
  const name = process.env.SITE_NAME || 'lab2date';
  const from = addr.includes('<') ? addr : `"${name}" <${addr}>`;
  let result: { messageId?: string } | undefined;
  let sendError: Error | null = null;
  try {
    if (process.env.RESEND_API_KEY) {
      result = await sendViaResendHttp(from, to, subject, html, text);
    } else {
      const t = buildTransport();
      if (!t) throw new Error('No mail transport configured.');
      result = await t.sendMail({ from, to, subject, html, text });
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
        subject,
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
