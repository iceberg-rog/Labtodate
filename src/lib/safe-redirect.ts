/**
 * Validate a post-auth redirect target. Only same-origin, relative paths are
 * allowed — an absolute URL (`https://evil.com`), protocol-relative (`//evil`)
 * or backslash-tricked (`/\evil`) value is rejected and replaced by `fallback`.
 * Without this, `?redirect=https://evil.com` would bounce a freshly signed-in
 * user off-site (credential phishing / open redirect).
 */
export function safeRedirect(raw: string | null | undefined, fallback = '/auth/continue'): string {
  // Must start with a single "/" NOT followed by another "/" or a "\", and may
  // not contain control characters, whitespace or backslashes anywhere: URL
  // parsers silently drop tabs/newlines, so "/\t/evil.com" became "//evil.com".
  if (raw && /^\/(?![/\\])/.test(raw) && !/[\u0000-\u0020\u007F\\]/.test(raw)) return raw;
  return fallback;
}
