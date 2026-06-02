import nodemailer, { type Transporter } from 'nodemailer';
import { ensureSettingsLoaded } from './settings';
import { prisma } from './db';

interface SendEmailParams {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

// Built per send so admin-updated keys take effect without a restart.
function buildTransport(): Transporter {
  // 1) Highest priority: Resend (managed transactional, single API key).
  // Default port 2587 — Resend's alternate port that works when ISPs/hosts
  // block the standard 587/465 outbound. Override with RESEND_SMTP_PORT if
  // running on a network where the standard ports are open.
  if (process.env.RESEND_API_KEY) {
    return nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: parseInt(process.env.RESEND_SMTP_PORT || '2587', 10),
      secure: false,
      auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
    });
  }

  // 2) Real SMTP with credentials (STRATO, Postmark, AWS SES, etc.)
  // Heuristic: if SMTP_USER + SMTP_PASS are set we treat it as a real
  // provider that requires auth + TLS. SMTP_SECURE=true forces implicit
  // SSL (port 465); otherwise STARTTLS is negotiated on 587.
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    const explicitSecure = process.env.SMTP_SECURE;
    const secure = explicitSecure
      ? explicitSecure === 'true' || explicitSecure === '1'
      : port === 465; // sensible default — 465 implies implicit SSL
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
    result = await buildTransport().sendMail({ from, to, subject, html, text });
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
