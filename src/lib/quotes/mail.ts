import { escapeHtml } from '@/lib/email-html';

/**
 * One consistent, branded layout for the quote / payment emails (offer,
 * acceptance, reminders, cancellation, staff notices). Callers escape their
 * own user-typed values; `html` parts are inserted as given.
 */

export function siteBase(): string {
  return (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
}

export function mailLayout(p: {
  heading: string;
  /** Paragraph HTML strings (already escaped where needed). */
  body: string[];
  cta?: { href: string; label: string } | null;
  /** Small grey lines under the button. */
  footer?: string[];
}): string {
  const site = escapeHtml(process.env.SITE_NAME || 'Labtodate');
  return `
<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:580px;color:#111827;line-height:1.5;">
  <p style="margin:0 0 14px;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#0E4F40;">${site}</p>
  <h2 style="color:#0E4F40;margin:0 0 12px;font-size:20px;">${escapeHtml(p.heading)}</h2>
  ${p.body.map((b) => (b.trim().startsWith('<') ? b : `<p style="margin:0 0 12px;">${b}</p>`)).join('\n  ')}
  ${p.cta ? `<p style="margin:20px 0;"><a href="${escapeHtml(p.cta.href)}" style="background:#0E4F40;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">${escapeHtml(p.cta.label)}</a></p>` : ''}
  ${(p.footer ?? []).map((f) => `<p style="margin:6px 0 0;color:#6b7280;font-size:12px;">${f}</p>`).join('\n  ')}
</div>`;
}

/** A label/value table (amounts, terms) for emails. */
export function mailTable(rows: Array<[string, string, boolean?]>): string {
  return `<table style="border-collapse:collapse;font-size:14px;margin:6px 0 14px;">${rows
    .map(([l, v, strong]) => `<tr><td style="padding:3px 18px 3px 0;color:#4b5563;vertical-align:top;">${l}</td><td style="padding:3px 0;text-align:right;${strong ? 'font-weight:700;font-size:16px;' : ''}">${v}</td></tr>`)
    .join('')}</table>`;
}
