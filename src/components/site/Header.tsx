import { ensureSettingsLoaded } from '@/lib/settings';
import { legalIdentity } from '@/lib/brand/identity';
import { HeaderBar } from './HeaderBar';

/**
 * The public site header. Reads the brand on the server — the site name and
 * the logo uploaded in Admin → Settings → Logo (the built-in mark when none) —
 * so a new logo shows on the next page load; the bar itself is a client
 * component (menu, search, session).
 */
export async function Header({ searchPlaceholder }: { searchPlaceholder?: string }) {
  await ensureSettingsLoaded();
  const id = legalIdentity();
  return <HeaderBar searchPlaceholder={searchPlaceholder} brand={{ name: id.siteName, logoUrl: id.logoUrl }} />;
}
