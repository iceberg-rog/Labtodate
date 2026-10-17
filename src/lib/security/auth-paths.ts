/**
 * The path as better-auth's router (rou3) sees it: it ignores a trailing
 * slash, so "/api/auth/sign-in/email/" reaches the sign-in endpoint and must
 * get the same limits as "/api/auth/sign-in/email". Pure.
 */
export function canonicalAuthPath(pathname: string): string {
  return pathname.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
}
