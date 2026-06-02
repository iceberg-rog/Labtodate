'use client';

import { usePathname } from 'next/navigation';

/**
 * Hides the public site header / footer / assistant / cookie banner on
 * /admin routes so the admin area can run its own standalone dashboard
 * chrome (no public marketplace nav, no search, no cart, no footer).
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

  if (isAdmin) {
    // Admin dashboard runs in its own chrome (see app/admin/layout.tsx).
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
