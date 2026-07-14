'use client';

import { usePathname } from 'next/navigation';

/**
 * Hides the public site header / footer / assistant / cookie banner on
 * /admin and /auth routes so those areas run their own standalone chrome:
 * the admin dashboard has its own nav (see app/admin/layout.tsx), and auth
 * screens are a focused, single-logo layout (see app/auth/layout.tsx) — this
 * is what prevents the site header logo from stacking above the auth logo.
 */
export function PublicChrome({
  header,
  footer,
  overlays,
  children,
}: {
  header: React.ReactNode;
  footer: React.ReactNode;
  overlays: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || '';
  const isAdmin = pathname === '/admin' || pathname.startsWith('/admin/');
  const isAuth = pathname === '/auth' || pathname.startsWith('/auth/');

  if (isAdmin || isAuth) {
    // Standalone chrome — the route's own layout supplies its header/logo.
    return <main className="flex-1">{children}</main>;
  }

  return (
    <>
      {header}
      <main className="flex-1">{children}</main>
      {footer}
      {overlays}
    </>
  );
}
