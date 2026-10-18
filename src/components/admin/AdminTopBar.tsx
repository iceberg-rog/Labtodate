import { ensureSettingsLoaded } from '@/lib/settings';
import { legalIdentity } from '@/lib/brand/identity';
import { AdminTopBarClient } from './AdminTopBarClient';

/**
 * The admin top bar with the brand from Settings: the uploaded logo (the
 * built-in mark when none) and the site name — it used to read a fixed
 * "lab2date". The bar itself is a client component (bell, sign-out).
 */
export async function AdminTopBar({ email, unreadCount }: { email: string; unreadCount: number }) {
  await ensureSettingsLoaded();
  const id = legalIdentity();
  return <AdminTopBarClient email={email} unreadCount={unreadCount} brand={{ name: id.siteName, logoUrl: id.logoUrl }} />;
}
