/**
 * Bot-check names shared by the server (./captcha.ts) and the browser widget
 * (src/components/security/Captcha.tsx). Pure — safe in client components.
 */

export const CAPTCHA_PURPOSES = ['signup', 'signin', 'password_reset', 'magic_link', 'verify_email', 'support', 'sell', 'quote'] as const;
export type CaptchaPurpose = (typeof CAPTCHA_PURPOSES)[number];

/** Request header carrying the solved payload on better-auth calls. */
export const CAPTCHA_HEADER = 'x-captcha';

/** Error codes the server answers with when the check is missing or failed. */
export const CAPTCHA_ERROR_CODES = ['CAPTCHA_REQUIRED', 'CAPTCHA_INVALID', 'CAPTCHA_EXPIRED', 'CAPTCHA_REUSED'] as const;

/** Which auth forms show the check up front (from Settings → Security; passed by the server pages). */
export type AuthCaptchaFlags = {
  signup: boolean;
  password_reset: boolean;
  magic_link: boolean;
  verify_email: boolean;
  /** CAPTCHA_SIGNIN_AFTER_FAILS = 0: every password sign-in. */
  signin: boolean;
};

export const NO_AUTH_CAPTCHA: AuthCaptchaFlags = { signup: false, password_reset: false, magic_link: false, verify_email: false, signin: false };

export function isCaptchaError(code: unknown): boolean {
  return typeof code === 'string' && (CAPTCHA_ERROR_CODES as readonly string[]).includes(code);
}
