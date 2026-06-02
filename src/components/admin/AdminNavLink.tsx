'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function AdminNavLink({
  href,
  icon,
  label,
  badge,
}: {
  href: string;
  // Receive an already-rendered icon element from the server parent —
  // React forbids passing component *functions* across the RSC boundary.
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  const pathname = usePathname() || '';
  // Active when exact match, or a descendant route (e.g. /admin/products/123).
  // Overview ('/admin') is only active when the path is exactly '/admin'.
  const active =
    href === '/admin'
      ? pathname === '/admin'
      : pathname === href || pathname.startsWith(href + '/');

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={[
        'flex items-center gap-3 pl-3 pr-2 py-2 rounded-md text-sm transition-colors border-l-2',
        active
          ? 'bg-primary/[0.07] text-foreground border-primary font-semibold'
          : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted',
      ].join(' ')}
    >
      <span className="flex-shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {badge && badge > 0 ? (
        <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-accent text-accent-foreground text-[11px] font-bold tabular-nums">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </Link>
  );
}

export function NavSection({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      {title && (
        <p className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">
          {title}
        </p>
      )}
      {children}
    </div>
  );
}
