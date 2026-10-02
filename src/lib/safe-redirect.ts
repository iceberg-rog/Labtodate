/**
 * Validate a post-auth redirect target. Only same-origin, relative paths are
 * allowed — an absolute URL (`https://evil.com`), protocol-relative (`//evil`)
 * or backslash-tricked (`/\evil`, `/%5Cevil`) value is rejected and replaced by
 * `fallback`. Without this, `?redirect=https://evil.com` would bounce a freshly
 * signed-in user off-site (credential phishing / open redirect).
 */
export function safeRedirect(raw: string | null | undefined, fallback = '/auth/continue'): string {
  if (!raw) return fallback;
  // A #fragment is meaningless as a post-sign-in target and better-auth
  // rejects callback URLs carrying one ("Invalid callbackURL"), so drop it.
  const target = raw.split('#')[0];
  // Must start with a single "/" NOT followed by another "/" or a "\", and may
  // not contain control characters, whitespace or backslashes anywhere: URL
  // parsers silently drop tabs/newlines, so "/\t/evil.com" became "//evil.com".
  // Percent-encoded slashes/backslashes in the path are refused too.
  if (
    /^\/(?![/\\])/.test(target) &&
    !/[\u0000- \u007F\\]/.test(target) &&
    !/%(2f|5c)/i.test(target.split('?')[0])
  ) {
    return target;
  }
  return fallback;
}

// better-auth's own rule for relative callback URLs (auth/trusted-origins.mjs).
// A magic-link request whose callbackURL / errorCallbackURL breaks it is
// refused with 403 "Invalid callbackURL".
const BETTER_AUTH_RELATIVE = /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/;

/**
 * The sign-in page as a magic link's error target: it explains the `?error=`
 * better-auth appends (expired/used link, no account, suspended) and still
 * knows where the user was heading. better-auth URL-decodes errorCallbackURL
 * once more before redirecting, hence the double encoding.
 */
export function signInErrorURL(redirect: string | null | undefined): string {
  const target = safeRedirect(redirect);
  if (target === '/auth/continue') return '/auth/sign-in';
  const url = `/auth/sign-in?redirect=${encodeURIComponent(encodeURIComponent(target))}`;
  return BETTER_AUTH_RELATIVE.test(url) ? url : '/auth/sign-in';
}

/** callbackURL / errorCallbackURL for `signIn.magicLink`, always acceptable to better-auth. */
export function magicLinkTargets(redirect: string): { callbackURL: string; errorCallbackURL: string } {
  const callbackURL = BETTER_AUTH_RELATIVE.test(redirect) ? redirect : '/auth/continue';
  return { callbackURL, errorCallbackURL: signInErrorURL(callbackURL) };
}
