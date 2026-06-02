import {
  LayoutDashboard,
  Tag,
  Building2,
  Users,
  FileText,
  BookOpen,
  Banknote,
  Inbox,
  MessageSquare,
  ShoppingCart,
  Settings,
  Megaphone,
  Home,
  LifeBuoy,
  TrendingUp,
  ScrollText,
  AlertTriangle,
  Quote,
  Briefcase,
  FlaskConical,
} from 'lucide-react';
import { requireSession, getAdminCaps } from '@/lib/auth-server';
import { capsAllow, capsAllowSection } from '@/lib/capabilities';
import { prisma } from '@/lib/db';
import { AdminNavLink, NavSection } from '@/components/admin/AdminNavLink';
import { AdminTopBar } from '@/components/admin/AdminTopBar';
import { NewOrderToast } from '@/components/admin/NewOrderToast';
import { MobileDrawer } from '@/components/util/MobileDrawer';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  const caps = await getAdminCaps();
  const can = (c: string) => capsAllow(caps, c);
  const canSection = (s: string) => capsAllowSection(caps, s);

  // Live counts for actionable badges so the operator sees what needs work
  // without going to Overview first.
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [pendingApprovals, pendingQuotes, pendingSells, openTickets, errors24h, unreadNotifs] =
    await Promise.all([
      prisma.product.count({ where: { status: 'PENDING_REVIEW' } }).catch(() => 0),
      prisma.sourcingRequest.count({ where: { status: 'PENDING' } }).catch(() => 0),
      prisma.sellSubmission.count({ where: { status: 'PENDING' } }).catch(() => 0),
      prisma.supportTicket
        .count({ where: { status: { in: ['OPEN', 'PENDING'] } } })
        .catch(() => 0),
      prisma.errorLog.count({ where: { createdAt: { gte: since24h } } }).catch(() => 0),
      prisma.notification.count({ where: { userId: session.user.id, readAt: null } }).catch(() => 0),
    ]);

  // The full nav tree — rendered TWICE: once inside the desktop aside, once
  // inside the mobile drawer. Capturing it as a fragment keeps the source of
  // truth single-place.
  const navTree = (
    <>
      <NavSection>
            <AdminNavLink href="/admin" icon={<LayoutDashboard className="h-4 w-4" />} label="Overview" />
          </NavSection>

          {(canSection('orders') ||
            canSection('quotes') ||
            canSection('tickets') ||
            canSection('sell') ||
            canSection('messages')) && (
            <NavSection title="Operate">
              {can('orders:view') && (
                <AdminNavLink href="/admin/orders" icon={<ShoppingCart className="h-4 w-4" />} label="Orders & sales" />
              )}
              {can('quotes:view') && (
                <AdminNavLink
                  href="/admin/quotes"
                  icon={<Inbox className="h-4 w-4" />}
                  label="Quote requests"
                  badge={pendingQuotes}
                />
              )}
              {can('tickets:view') && (
                <AdminNavLink
                  href="/admin/tickets"
                  icon={<LifeBuoy className="h-4 w-4" />}
                  label="Support tickets"
                  badge={openTickets}
                />
              )}
              {can('sell:view') && (
                <AdminNavLink
                  href="/admin/sell"
                  icon={<Banknote className="h-4 w-4" />}
                  label="Acquisitions"
                  badge={pendingSells}
                />
              )}
              {can('messages:view') && (
                <AdminNavLink href="/admin/messages" icon={<MessageSquare className="h-4 w-4" />} label="Messages" />
              )}
            </NavSection>
          )}

          {(canSection('products') || can('categories:manage')) && (
            <NavSection title="Catalog">
              {can('products:view') && (
                <AdminNavLink
                  href="/admin/products"
                  icon={<Tag className="h-4 w-4" />}
                  label="Products"
                  badge={pendingApprovals}
                />
              )}
              {can('products:edit') && (
                <AdminNavLink href="/admin/brands" icon={<Tag className="h-4 w-4" />} label="Brands" />
              )}
              {can('categories:manage') && (
                <AdminNavLink href="/admin/categories" icon={<Tag className="h-4 w-4" />} label="Categories" />
              )}
            </NavSection>
          )}

          {(can('users:view') || can('companies:manage')) && (
            <NavSection title="People">
              {can('users:view') && (
                <AdminNavLink href="/admin/users" icon={<Users className="h-4 w-4" />} label="Users" />
              )}
              {can('companies:manage') && (
                <AdminNavLink href="/admin/companies" icon={<Building2 className="h-4 w-4" />} label="Shops & suppliers" />
              )}
            </NavSection>
          )}

          {(can('content:write') || can('content:cms')) && (
            <NavSection title="Content">
              {can('content:write') && (
                <AdminNavLink href="/admin/blog" icon={<FileText className="h-4 w-4" />} label="Blog" />
              )}
              {can('content:write') && (
                <AdminNavLink href="/admin/wiki" icon={<BookOpen className="h-4 w-4" />} label="Wiki" />
              )}
              {can('content:cms') && (
                <AdminNavLink href="/admin/testimonials" icon={<Quote className="h-4 w-4" />} label="Testimonials" />
              )}
              {can('content:cms') && (
                <AdminNavLink href="/admin/case-studies" icon={<Briefcase className="h-4 w-4" />} label="Case studies" />
              )}
              {can('content:cms') && (
                <AdminNavLink href="/admin/lab-rental" icon={<FlaskConical className="h-4 w-4" />} label="Lab rental" />
              )}
              {can('content:cms') && (
                <AdminNavLink href="/admin/announcements" icon={<Megaphone className="h-4 w-4" />} label="Announcements" />
              )}
            </NavSection>
          )}

          {(can('content:cms') ||
            can('settings:view') ||
            can('analytics:view') ||
            can('audit:view') ||
            can('errors:view')) && (
            <NavSection title="System">
              {can('content:cms') && (
                <AdminNavLink href="/admin/homepage" icon={<Home className="h-4 w-4" />} label="Homepage" />
              )}
              {can('settings:view') && (
                <AdminNavLink href="/admin/settings" icon={<Settings className="h-4 w-4" />} label="Settings" />
              )}
              {can('analytics:view') && (
                <AdminNavLink href="/admin/analytics" icon={<TrendingUp className="h-4 w-4" />} label="Analytics" />
              )}
              {can('audit:view') && (
                <AdminNavLink href="/admin/audit" icon={<ScrollText className="h-4 w-4" />} label="Audit log" />
              )}
              {can('errors:view') && (
                <AdminNavLink
                  href="/admin/errors"
                  icon={<AlertTriangle className="h-4 w-4" />}
                  label="Errors"
                  badge={errors24h}
                />
              )}
            </NavSection>
          )}
    </>
  );

  return (
    <div className="min-h-screen bg-foreground/[0.02]">
      <AdminTopBar email={session.user.email} unreadCount={unreadNotifs} />
      {/* Mobile-only: hamburger to open the full admin nav as a left drawer. */}
      <div className="lg:hidden px-4 py-3 border-b border-border bg-card flex items-center justify-between gap-3">
        <MobileDrawer triggerLabel="Admin menu" title="Administrator">
          <nav className="space-y-2">{navTree}</nav>
        </MobileDrawer>
        <p className="text-xs text-muted-foreground truncate">{session.user.email}</p>
      </div>
      <div className="grid lg:grid-cols-[240px_1fr] gap-0">
        <aside className="hidden lg:block lg:sticky lg:top-14 lg:self-start lg:h-[calc(100vh-3.5rem)] border-r border-border bg-card px-3 py-4 overflow-y-auto">
          {navTree}
        </aside>

        <main className="p-4 md:p-8 max-w-[1400px] w-full min-w-0">{children}</main>
      </div>
      {/* Global toast for new orders / paid / shipping-missing — fires on any
       *  admin route, not just /admin/orders, so an admin on the dashboard
       *  or in settings still sees a sale arrive. */}
      <NewOrderToast />
    </div>
  );
}
