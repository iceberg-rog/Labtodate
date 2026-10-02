/**
 * Helpers for the hand-built HTML emails (template literals passed to
 * sendEmail). Every value that comes from a user, the database, a product
 * listing or an admin setting must go through escapeHtml() / escapeHtmlLines()
 * before it is interpolated into email HTML: otherwise a name like
 * `<a href="https://evil.example">Verify your account</a>` turns into a live
 * phishing link inside a lab2date-branded email. Values we generate ourselves
 * (order numbers, refs, ids, formatted amounts, BETTER_AUTH_URL links) are
 * safe as-is. Pure functions — safe to import anywhere.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for an HTML element body or a double-quoted attribute value. */
export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** escapeHtml for multi-line user text: line breaks are kept as <br>. */
export function escapeHtmlLines(value: string | null | undefined): string {
  return escapeHtml(value).replace(/\r\n?|\n/g, '<br>');
}

/**
 * User-controlled text going into an email header (the subject). Headers are
 * plain text, so no HTML escaping — but CR/LF and other control characters are
 * removed (header injection) and the value is capped so a 5,000-character
 * field can't become the subject line.
 */
export function headerText(value: string | null | undefined, max = 100): string {
  const flat = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Plain-text email body: drop control characters except tab and line breaks. */
export function plainTextBody(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
