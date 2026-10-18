import { ensureSettingsLoaded } from '@/lib/settings';
import { siteBrand } from '@/lib/brand/site-logo';
import { AdminTopBarClient } from './AdminTopBarClient';

/**
 * The admin top bar with the brand from Settings: the website logo (siteBrand:
 * the built-in mark when none) and the site name — it used to read a fixed
 * "lab2date". The bar itself is a client component (bell, sign-out).
 */
export async function AdminTopBar({ email, unreadCount }: { email: string; unreadCount: number }) {
  await ensureSettingsLoaded();
  return <AdminTopBarClient email={email} unreadCount={unreadCount} brand={siteBrand()} />;
}
