import Link from 'next/link';
import { LayoutDashboard, Package, MessageSquare, Heart, FileText, User as UserIcon, Inbox, Bell, LifeBuoy, Banknote } from 'lucide-react';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { MobileDrawer } from '@/components/util/MobileDrawer';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession({ redirectTo: '/app' });
  const role = (session.user as { role?: string }).role || 'BUYER';
  const [unread, unreadNotifs] = await Promise.all([
    prisma.message.count({
      where: {
        thread: { OR: [{ buyerId: session.user.id }, { sellerId: session.user.id }] },
        readAt: null,
        authorId: { not: session.user.id },
      },
    }),
    prisma.notification.count({ where: { userId: session.user.id, readAt: null } }),
  ]);

  const navLinks = (
    <>
      <div className="px-3 pb-2">
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
          {role === 'ADMIN' ? 'Administrator' : role === 'SELLER' ? 'Seller account' : 'Buyer account'}
        </p>
        <p className="text-sm font-semibold mt-0.5 truncate">{session.user.name}</p>
      </div>
      <NavLink href="/app" icon={LayoutDashboard} label="Overview" />
      <NavLink href="/app/orders" icon={Package} label="Orders" />
      <NavLink href="/app/quotes" icon={FileText} label="Quotes" />
      <NavLink href="/app/inbox" icon={MessageSquare} label="Inbox" badge={unread} />
      <NavLink href="/app/notifications" icon={Bell} label="Notifications" badge={unreadNotifs} />
      <NavLink href="/app/support" icon={LifeBuoy} label="Support" />
      <NavLink href="/app/wishlist" icon={Heart} label="Wishlist" />
      <NavLink href="/app/sell-submissions" icon={Banknote} label="My equipment offers" />
      <NavLink href="/app/profile" icon={UserIcon} label="Profile" />
      {(role === 'SELLER' || role === 'ADMIN') && (
        <>
          <div className="pt-4 px-3 pb-2 text-xs uppercase tracking-wider text-muted-foreground font-semibold">Sell</div>
          <NavLink href="/app/seller" icon={LayoutDashboard} label="Seller overview" />
          <NavLink href="/app/seller/products" icon={Package} label="My listings" />
          <NavLink href="/app/seller/inbox" icon={Inbox} label="Quote inbox" />
          <NavLink href="/app/seller/payouts" icon={Banknote} label="Payouts" />
        </>
      )}
    </>
  );

  return (
    <div className="container-px py-4 lg:py-8">
      {/* Mobile-only nav trigger — pinned above the page content.
          On desktop the sticky sidebar handles navigation. */}
      <div className="lg:hidden mb-4 flex items-center justify-between gap-3">
        <MobileDrawer triggerLabel="Menu" title={role === 'SELLER' ? 'Seller account' : 'Your account'}>
          <nav className="space-y-1">{navLinks}</nav>
        </MobileDrawer>
        <p className="text-xs text-muted-foreground truncate">{session.user.email}</p>
      </div>

      <div className="grid lg:grid-cols-[220px_1fr] gap-8">
        <aside className="hidden lg:block space-y-1 lg:sticky lg:top-20 lg:self-start">
          {navLinks}
        </aside>

        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}

function NavLink({
  href,
  icon: Icon,
  label,
  badge,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1">{label}</span>
      {badge ? (
        <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-accent text-accent-foreground text-[11px] font-bold tabular-nums">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </Link>
  );
}
