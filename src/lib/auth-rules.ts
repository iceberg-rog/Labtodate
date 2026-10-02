/**
 * Account rules shared by the auth server config (src/lib/auth.ts) and the
 * auth / profile forms, so client-side checks and copy can't drift from what
 * the server enforces (the reset and profile forms used to say 8 characters
 * while the server required 12). Safe to import from client components.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 120;

export const PASSWORD_RULE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
export const NAME_RULE = `Please enter your name (${NAME_MIN_LENGTH}–${NAME_MAX_LENGTH} characters).`;

/** Trimmed, whitespace-collapsed display name, or null when it breaks the length rule. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  return name.length >= NAME_MIN_LENGTH && name.length <= NAME_MAX_LENGTH ? name : null;
}

/**
 * Readable text for a better-auth client error. Most server messages are
 * fine as-is; these codes come back terse ("Password too short") or
 * technical ("Invalid OTP").
 */
export function authErrorMessage(
  err: { code?: string; message?: string } | null | undefined,
  fallback: string,
): string {
  switch (err?.code) {
    case 'PASSWORD_TOO_SHORT':
      return PASSWORD_RULE;
    case 'PASSWORD_TOO_LONG':
      return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
    case 'INVALID_OTP':
      return 'That code is incorrect. Check it, or press “Resend code” for a new one.';
    case 'OTP_EXPIRED':
      return 'That code has expired. Press “Resend code” for a new one.';
    case 'TOO_MANY_ATTEMPTS':
      return 'Too many wrong codes. Press “Resend code” for a new one.';
    default:
      return err?.message || fallback;
  }
}
