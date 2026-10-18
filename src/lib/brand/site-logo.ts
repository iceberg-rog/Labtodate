import { settingString } from '@/lib/settings';
import { siteName } from './identity';

/**
 * The brand as the website chrome shows it (site header and footer, auth
 * screens, admin top bar). The site is dark only, while the logo uploaded on
 * the Logo tab (COMPANY_LOGO_URL) is made for white documents and e-mails: a
 * dark logo would be nearly invisible on the dark bar. So the chrome uses the
 * dark-background version (COMPANY_LOGO_DARK_URL, Settings → Brand) as it is
 * and otherwise sets the document logo on a white tile; with neither, the
 * built-in mark and the site name. Mails and documents keep COMPANY_LOGO_URL.
 *
 * Read after `await ensureSettingsLoaded()`.
 */
export interface SiteBrand {
  /** SITE_NAME: the wordmark of the built-in mark and the logo's alt text. */
  name: string;
  /** The logo to show; '' = the built-in mark. */
  logoUrl: string;
  /** The logo is made for a light background: shown on a white tile. */
  logoOnLight: boolean;
}

/** Which logo the dark website shows (pure). */
export function siteLogoOf(darkUrl: string, documentUrl: string): Pick<SiteBrand, 'logoUrl' | 'logoOnLight'> {
  const dark = darkUrl.trim();
  if (dark) return { logoUrl: dark, logoOnLight: false };
  const doc = documentUrl.trim();
  return { logoUrl: doc, logoOnLight: doc !== '' };
}

export function siteBrand(): SiteBrand {
  return { name: siteName(), ...siteLogoOf(settingString('COMPANY_LOGO_DARK_URL'), settingString('COMPANY_LOGO_URL')) };
}
