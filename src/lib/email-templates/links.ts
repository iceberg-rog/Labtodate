/**
 * Absolute link into the site for an e-mail field ("link.order", …): the
 * configured BETTER_AUTH_URL without its trailing slash, plus `path`. Call it
 * after ensureSettingsLoaded() so an admin-changed URL is used. Pure.
 */
export function siteLink(path = ''): string {
  const base = (process.env.BETTER_AUTH_URL || '').trim().replace(/\/+$/, '');
  return `${base}${path}`;
}
