import { ensureSettingsLoaded } from '@/lib/settings';
import { siteBrand } from '@/lib/brand/site-logo';
import { HeaderBar } from './HeaderBar';

/**
 * The public site header. Reads the brand on the server — the site name and
 * the website logo from Admin → Settings (siteBrand: the built-in mark when none) —
 * so a new logo shows on the next page load; the bar itself is a client
 * component (menu, search, session).
 */
export async function Header({ searchPlaceholder }: { searchPlaceholder?: string }) {
  await ensureSettingsLoaded();
  return <HeaderBar searchPlaceholder={searchPlaceholder} brand={siteBrand()} />;
}
