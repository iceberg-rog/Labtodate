import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight, AlertOctagon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { requireCapability, getAdminCaps } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { formatPrice } from '@/lib/utils';
import { setUserRole, setUserCaps, unsuspendUser, resetTwoFactorForUser } from '../../actions';
import { AdminUserDangerZone } from '@/components/admin/AdminUserDangerZone';
import {
  CAPABILITIES,
  CAPABILITY_INFO,
  CAPABILITY_PRESETS,
  SUPER_ADMIN_ONLY_CAPS,
  canGrantCapability,
  capsAllow,
  capsChangeProblems,
} from '@/lib/capabilities';
import { UserRole, type ShopPricingMode } from '@prisma/client';
import { RoleSelect } from '../RoleSelect';
import { linkSupplierCompany, promoteToSupplier } from '../company-link-actions';
import { SupplierCompanyPanel, UserAccessPanel, type CompanyOption } from '@/components/admin/UserAccessPanel';
import { UnsuspendButton } from '@/components/admin/UnsuspendButton';
import { getSecurityPolicy } from '@/lib/security/policy';
import { countOtherActiveSuperAdmins } from '@/lib/security/alerts';
import { companyPriceRule } from '@/lib/sellers/listing-rules';

export const dynamic = 'force-dynamic';

/** A company as the supplier-company panel lists it: name and pricing rule in words. */
function priceRule(c: { id: string; name: string; pricingMode: ShopPricingMode; pricingMarkupBp: number }): CompanyOption {
  return { id: c.id, name: c.name, ...companyPriceRule(c.pricingMode, c.pricingMarkupBp) };
}

export function generateMetadata(props: { params: Promise<{ id: string }> }) {
  return adminDetailTitle('users:view', 'User', async () => {
    const { id } = await props.params;
    const u = await prisma.user.findUnique({ where: { id }, select: { name: true } });
    return u && `User ${u.name}`;
  });
}

async function updateRole(formData: FormData) {
  'use server';
  return setUserRole(
    String(formData.get('userId')),
    formData.get('role') as UserRole,
    (formData.get('preset') as string | null) || null,
  );
}

export default async function AdminUserDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const viewer = await requireCapability('users:view');
  const viewerCaps = await getAdminCaps();
  const can = (c: string) => capsAllow(viewerCaps, c);
  const canManageUsers = can('users:manage');
  const policy = await getSecurityPolicy();

  const user = await prisma.user.findUnique({
    where: { id: params.id },
    include: { company: { select: { id: true, name: true, slug: true, pricingMode: true, pricingMarkupBp: true } } },
  });
  if (!user) notFound();

  const uid = user.id;
  const mail = user.email;

  const none = Promise.resolve([] as never[]);
  const [orders, sourcing, sells, tickets, threads, reviews, wishlist, notifs, carts] =
    await Promise.all([
      can('orders:view')
        ? prisma.order.findMany({
            where: { buyerId: user.id },
            orderBy: { createdAt: 'desc' },
            include: { items: { select: { titleSnapshot: true, quantity: true } } },
          })
        : none,
      can('quotes:view')
        ? prisma.sourcingRequest.findMany({
            where: { OR: [{ submittedById: uid }, { buyerEmail: mail }] },
            orderBy: { createdAt: 'desc' },
            select: { id: true, description: true, status: true, quotedPriceCents: true, createdAt: true },
          })
        : none,
      can('sell:view')
        ? prisma.sellSubmission.findMany({
            where: { OR: [{ submittedById: uid }, { email: mail }] },
            orderBy: { createdAt: 'desc' },
            select: { id: true, itemTitle: true, status: true, phone: true, createdAt: true },
          })
        : none,
      !can('tickets:view') ? none : prisma.supportTicket.findMany({
        where: { OR: [{ submittedById: uid }, { email: mail }] },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, ref: true, subject: true, status: true, priority: true,
          createdAt: true, lastReplyAt: true, archivedAt: true,
          _count: { select: { messages: true } },
        },
      }),
      !can('messages:view') ? none : prisma.messageThread.findMany({
        where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] },
        orderBy: { lastMessageAt: 'desc' },
        select: {
          id: true,
          subject: true,
          lastMessageAt: true,
          _count: { select: { messages: true } },
        },
      }),
      prisma.review.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        include: { product: { select: { title: true, slug: true } } },
      }),
      prisma.wishlistItem.count({ where: { userId: user.id } }),
      prisma.notification.count({ where: { userId: user.id } }),
      prisma.cartItem.count({ where: { userId: user.id } }),
    ]);

  const phone = sells.find((s) => s.phone)?.phone ?? null;
  const spend = orders
    .filter((o) => ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(o.status))
    .reduce((s, o) => s + o.totalCents, 0);

  // Access panel: what the viewer may change for this admin (the server
  // re-checks everything in src/lib/security/user-access.ts).
  const isSelf = user.id === viewer.user.id;
  const accessProblems =
    user.role === 'ADMIN' && canManageUsers
      ? capsChangeProblems({
          actorId: viewer.user.id,
          actorCaps: viewerCaps,
          targetId: user.id,
          targetRole: user.role,
          targetCaps: user.adminCaps,
          nextCaps: user.adminCaps,
          otherActiveSuperAdmins: await countOtherActiveSuperAdmins(user.id),
        })
      : [];
  const capRows = [
    { cap: '*', info: 'Super-admin — everything, including granting admin rights', grantable: viewerCaps.includes('*'), superOnly: true },
    ...CAPABILITIES.map((c) => ({
      cap: c,
      info: CAPABILITY_INFO[c],
      grantable: canGrantCapability(viewerCaps, c),
      superOnly: (SUPER_ADMIN_ONLY_CAPS as readonly string[]).includes(c),
    })),
  ];
  const presetRows = Object.entries(CAPABILITY_PRESETS).map(([key, p]) => ({
    key,
    label: p.label,
    caps: p.caps,
    grantable: p.caps.every((c) => canGrantCapability(viewerCaps, c)),
  }));
  const canPromote = canManageUsers && (!policy.ONLY_SUPER_ADMIN_CREATES_ADMINS || viewerCaps.includes('*'));
  // Supplier company (D84): becoming a supplier needs users:manage; moving a
  // supplier to another company also companies:manage.
  const canLinkCompany = canManageUsers || can('companies:manage');
  const companyOptions =
    canLinkCompany && user.role !== 'ADMIN'
      ? (await prisma.company.findMany({
          where: { suggestedByAi: false },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, pricingMode: true, pricingMarkupBp: true },
        })).map(priceRule)
      : [];

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
        <Link href="/admin/users" className="hover:text-foreground">Users</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{user.name}</span>
      </nav>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{user.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">{user.email}</p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-2 flex-wrap">
            <Badge variant={user.role === 'ADMIN' ? 'accent' : user.role === 'SELLER' ? 'success' : 'secondary'}>
              {user.role === 'SELLER' ? 'internal supplier' : user.role.toLowerCase()}
            </Badge>
            {user.suspendedAt && (
              <Badge variant="warning">
                suspended {new Date(user.suspendedAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}
              </Badge>
            )}
            {user.company && <span>· {user.company.name}</span>}
            {phone && can('sell:view') && <span>· ☎ {phone}</span>}
            <span>· Joined {new Date(user.createdAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}</span>
            <span>· {user.emailVerified ? 'Email verified' : 'Email unverified'}</span>
          </div>
        </div>
        {canManageUsers && !isSelf && (user.role !== 'ADMIN' || accessProblems.length === 0) && (
          <div className="flex items-center gap-2">
            <RoleSelect
              userId={user.id}
              current={user.role}
              action={updateRole}
              presets={presetRows.map(({ key, label, grantable }) => ({ key, label, grantable }))}
              canPromote={canPromote}
            />
          </div>
        )}
      </div>
      {user.suspendedAt && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 text-amber-900 dark:text-amber-300 flex items-start gap-3">
          <AlertOctagon className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <div className="flex-1 text-sm">
            <p className="font-bold">This account is suspended</p>
            <p className="mt-1">
              Sign-in is blocked. Reason: <strong>{user.suspendedReason || '—'}</strong>
            </p>
            {canManageUsers && <UnsuspendButton userId={user.id} action={unsuspendUser} />}
          </div>
        </div>
      )}
      {canManageUsers && (
        <AdminUserDangerZone
          userId={user.id}
          email={user.email}
          suspended={!!user.suspendedAt}
          isAdmin={user.role === 'ADMIN'}
          blockedReason={
            isSelf
              ? 'This is your own account — suspend or delete it is not possible from here.'
              : user.role === 'ADMIN' && accessProblems.length
                ? accessProblems.join(' ')
                : null
          }
        />
      )}
      {canManageUsers && user.role === 'ADMIN' && (
        <UserAccessPanel
          userId={user.id}
          email={user.email}
          caps={user.adminCaps}
          capRows={capRows}
          presets={presetRows}
          canEdit={!isSelf && accessProblems.length === 0}
          editBlockedReason={isSelf ? 'This is your own account — another super-admin has to change your permissions.' : accessProblems.join(' ') || null}
          twoFactorEnabled={!!user.twoFactorEnabled}
          twoFactorRequired={policy.TWO_FACTOR_REQUIRED_ROLES.includes(user.role)}
          setCaps={setUserCaps}
          resetTwoFactor={resetTwoFactorForUser}
          canResetTwoFactor={!isSelf && accessProblems.length === 0}
        />
      )}
      {canManageUsers && user.role !== 'ADMIN' && user.twoFactorEnabled && !isSelf && (
        <UserAccessPanel
          userId={user.id}
          email={user.email}
          caps={[]}
          capRows={[]}
          presets={[]}
          canEdit={false}
          editBlockedReason={null}
          twoFactorEnabled
          twoFactorRequired={policy.TWO_FACTOR_REQUIRED_ROLES.includes(user.role)}
          setCaps={setUserCaps}
          resetTwoFactor={resetTwoFactorForUser}
          canResetTwoFactor
        />
      )}
      {canLinkCompany && !isSelf && (user.role === 'BUYER' || user.role === 'SELLER') && (user.role === 'SELLER' || canManageUsers) && (
        <SupplierCompanyPanel
          userId={user.id}
          email={user.email}
          role={user.role}
          current={user.company ? priceRule(user.company) : null}
          companies={companyOptions}
          canPromote={canManageUsers}
          canLink={canLinkCompany}
          promote={promoteToSupplier}
          link={linkSupplierCompany}
        />
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {can('finance:view') && <Stat label="Lifetime spend" value={formatPrice(spend, orders[0]?.currency ?? 'EUR')} />}
        {can('orders:view') && <Stat label="Orders" value={String(orders.length)} />}
        {can('quotes:view') && <Stat label="Quote requests" value={String(sourcing.length)} />}
        {can('sell:view') && <Stat label="Sell offers" value={String(sells.length)} />}
        {can('tickets:view') && <Stat label="Support tickets" value={String(tickets.length)} />}
        {can('messages:view') && <Stat label="Seller chats" value={String(threads.length)} />}
        <Stat label="Reviews" value={String(reviews.length)} />
        <Stat label="Wishlist · cart" value={`${wishlist} · ${carts}`} />
      </div>
      {can('orders:view') && <Section title={`Orders (${orders.length})`}>
        {orders.length === 0 ? <Empty /> : orders.map((o) => (
          <Row key={o.id} href={`/admin/orders/${o.id}`}
            main={o.orderNumber}
            sub={`${o.items.map((i) => i.titleSnapshot).join(', ').slice(0, 80) || '—'}`}
            right={`${formatPrice(o.totalCents, o.currency)} · ${o.status.toLowerCase()}`}
            date={o.createdAt} />
        ))}
      </Section>}
      {can('quotes:view') && <Section title={`Quote / sourcing requests (${sourcing.length})`}>
        {sourcing.length === 0 ? <Empty /> : sourcing.map((s) => (
          <Row key={s.id} href={`/admin/quotes/${s.id}`}
            main={s.description.slice(0, 80) || 'Request'}
            sub={s.quotedPriceCents ? `Quoted ${formatPrice(s.quotedPriceCents, 'EUR')}` : 'Not yet quoted'}
            right={s.status.toLowerCase()} date={s.createdAt} />
        ))}
      </Section>}
      {can('sell:view') && <Section title={`Sell offers (${sells.length})`}>
        {sells.length === 0 ? <Empty /> : sells.map((s) => (
          <Row key={s.id} href={`/admin/sell/${s.id}`}
            main={s.itemTitle} sub="" right={s.status.toLowerCase()} date={s.createdAt} />
        ))}
      </Section>}
      {can('tickets:view') && <Section title={`Support tickets (${tickets.length})`}>
        {tickets.length === 0 ? <Empty /> : tickets.map((t) => (
          <Row
            key={t.id}
            href={`/admin/tickets/${t.id}`}
            main={t.subject}
            sub={`${t.ref} · ${t._count.messages} message${t._count.messages === 1 ? '' : 's'}${t.archivedAt ? ' · archived' : ''}`}
            right={`${t.priority.toLowerCase()} · ${t.status.toLowerCase().replace(/_/g, ' ')}`}
            date={t.lastReplyAt ?? t.createdAt}
          />
        ))}
      </Section>}
      {can('messages:view') && <Section title={`Seller conversations (${threads.length})`}>
        {threads.length === 0 ? <Empty /> : threads.map((th) => (
          <Row key={th.id} href={`/admin/messages/threads/${th.id}`}
            main={th.subject ?? 'Conversation'} sub={`${th._count.messages} messages`}
            right="" date={th.lastMessageAt} />
        ))}
      </Section>}
      <Section title={`Reviews (${reviews.length})`}>
        {reviews.length === 0 ? <Empty /> : reviews.map((r) => (
          <Row key={r.id} href={`/marketplace/${r.product.slug}`}
            main={r.product.title} sub={r.body.slice(0, 80)} right={`★ ${r.rating}`} date={r.createdAt} />
        ))}
      </Section>
      <div className="rounded-2xl border border-border bg-foreground/[0.02] p-5 text-sm text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">Not shown here</p>
        Page views and product-search history are <strong>not recorded</strong> by the platform. Conversations with
        the on-site assistant <strong>are</strong> stored{can('messages:view') ? <> — see <Link href="/admin/messages" className="underline">Messages</Link></> : null}.
        {!can('orders:view') || !can('quotes:view') || !can('sell:view') ? ' Sections you have no permission for are hidden.' : ''}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xl font-bold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground mb-3">{title}</h2>
      <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
        {children}
      </ul>
    </div>
  );
}

function Empty() {
  return <li className="p-4 text-sm text-muted-foreground">None.</li>;
}

function Row({
  href, main, sub, right, date,
}: { href: string; main: string; sub: string; right: string; date: Date }) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-4 p-4 hover:bg-foreground/[0.03]">
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate">{main}</p>
          {sub && <p className="text-xs text-muted-foreground truncate mt-0.5">{sub}</p>}
        </div>
        {right && <span className="text-xs text-muted-foreground">{right}</span>}
        <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
          {new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      </Link>
    </li>
  );
}
