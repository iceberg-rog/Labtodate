import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight, ShieldOff, ShieldCheck, Trash2, KeyRound, AlertOctagon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import {
  setUserRole,
  setUserCaps,
  suspendUser,
  unsuspendUser,
  deleteUser,
} from '../../actions';
import { AdminUserDangerZone } from '@/components/admin/AdminUserDangerZone';
import { CAPABILITIES, CAPABILITY_PRESETS } from '@/lib/capabilities';
import { hasCapability } from '@/lib/auth-server';
import { UserRole } from '@prisma/client';
import { RoleSelect } from '../RoleSelect';

export const dynamic = 'force-dynamic';

async function updateRole(formData: FormData) {
  'use server';
  await setUserRole(String(formData.get('userId')), formData.get('role') as UserRole);
}

export default async function AdminUserDetailPage({ params }: { params: { id: string } }) {
  await requireCapability('users:view');
  const canManageUsers = await hasCapability('users:manage');

  const user = await prisma.user.findUnique({
    where: { id: params.id },
    include: { company: { select: { name: true, slug: true } } },
  });
  if (!user) notFound();

  const uid = user.id;
  const mail = user.email;

  const [orders, sourcing, sells, tickets, threads, reviews, wishlist, notifs, carts] =
    await Promise.all([
      prisma.order.findMany({
        where: { buyerId: user.id },
        orderBy: { createdAt: 'desc' },
        include: { items: { select: { titleSnapshot: true, quantity: true } } },
      }),
      prisma.sourcingRequest.findMany({
        where: { OR: [{ submittedById: uid }, { buyerEmail: mail }] },
        orderBy: { createdAt: 'desc' },
        select: { id: true, description: true, status: true, quotedPriceCents: true, createdAt: true },
      }),
      prisma.sellSubmission.findMany({
        where: { OR: [{ submittedById: uid }, { email: mail }] },
        orderBy: { createdAt: 'desc' },
        select: { id: true, itemTitle: true, status: true, phone: true, createdAt: true },
      }),
      prisma.supportTicket.findMany({
        where: { OR: [{ submittedById: uid }, { email: mail }] },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, ref: true, subject: true, status: true, priority: true,
          createdAt: true, lastReplyAt: true, archivedAt: true,
          _count: { select: { messages: true } },
        },
      }),
      prisma.messageThread.findMany({
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
            {phone && <span>· ☎ {phone}</span>}
            <span>· Joined {new Date(user.createdAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}</span>
            <span>· {user.emailVerified ? 'Email verified' : 'Email unverified'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <RoleSelect userId={user.id} current={user.role} action={updateRole} />
        </div>
      </div>

      {user.suspendedAt && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900 flex items-start gap-3">
          <AlertOctagon className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <div className="flex-1 text-sm">
            <p className="font-bold">This account is suspended</p>
            <p className="mt-1">
              Sign-in is blocked. Reason: <strong>{user.suspendedReason || '—'}</strong>
            </p>
            {canManageUsers && (
              <form action={unsuspendUser} className="mt-3">
                <input type="hidden" name="userId" value={user.id} />
                <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium">
                  <ShieldCheck className="h-3.5 w-3.5" /> Lift suspension
                </Button>
              </form>
            )}
          </div>
        </div>
      )}

      {canManageUsers && (
        <AdminUserDangerZone
          userId={user.id}
          email={user.email}
          suspended={!!user.suspendedAt}
          isAdmin={user.role === 'ADMIN'}
        />
      )}

      {canManageUsers && user.role === 'ADMIN' && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-sm font-bold mb-1">Admin capabilities</p>
          <p className="text-xs text-muted-foreground mb-4">
            Scope what this admin can do. <code className="font-mono">*</code> = super-admin (everything).
            Current: <span className="font-mono text-foreground">{user.adminCaps.join(', ') || '(none)'}</span>
          </p>

          <form action={setUserCaps} className="space-y-4">
            <input type="hidden" name="userId" value={user.id} />

            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
                Apply a preset (one-click role)
              </p>
              <div className="flex gap-3 flex-wrap">
                {Object.entries(CAPABILITY_PRESETS).map(([key, p]) => (
                  <button
                    key={key}
                    type="submit"
                    name="preset"
                    value={key}
                    className="rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <details>
              <summary className="text-xs font-bold uppercase tracking-wider text-muted-foreground cursor-pointer">
                Or pick individual capabilities
              </summary>
              <div className="mt-3 grid sm:grid-cols-2 gap-1.5">
                {CAPABILITIES.map((c) => (
                  <label key={c} className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="cap"
                      value={c}
                      defaultChecked={user.adminCaps.includes(c) || user.adminCaps.includes('*')}
                      className="accent-primary"
                    />
                    <code className="font-mono text-xs">{c}</code>
                  </label>
                ))}
              </div>
              <button
                type="submit"
                className="mt-3 rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-xs font-semibold"
              >
                Save selected
              </button>
            </details>
          </form>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Lifetime spend" value={formatPrice(spend, orders[0]?.currency ?? 'EUR')} />
        <Stat label="Orders" value={String(orders.length)} />
        <Stat label="Quote requests" value={String(sourcing.length)} />
        <Stat label="Sell offers" value={String(sells.length)} />
        <Stat label="Support tickets" value={String(tickets.length)} />
        <Stat label="Seller chats" value={String(threads.length)} />
        <Stat label="Reviews" value={String(reviews.length)} />
        <Stat label="Wishlist · cart" value={`${wishlist} · ${carts}`} />
      </div>

      <Section title={`Orders (${orders.length})`}>
        {orders.length === 0 ? <Empty /> : orders.map((o) => (
          <Row key={o.id} href={`/admin/orders?q=${o.orderNumber}`}
            main={o.orderNumber}
            sub={`${o.items.map((i) => i.titleSnapshot).join(', ').slice(0, 80) || '—'}`}
            right={`${formatPrice(o.totalCents, o.currency)} · ${o.status.toLowerCase()}`}
            date={o.createdAt} />
        ))}
      </Section>

      <Section title={`Quote / sourcing requests (${sourcing.length})`}>
        {sourcing.length === 0 ? <Empty /> : sourcing.map((s) => (
          <Row key={s.id} href={`/app/quotes/${s.id}`}
            main={s.description.slice(0, 80) || 'Request'}
            sub={s.quotedPriceCents ? `Quoted ${formatPrice(s.quotedPriceCents, 'EUR')}` : 'Not yet quoted'}
            right={s.status.toLowerCase()} date={s.createdAt} />
        ))}
      </Section>

      <Section title={`Sell offers (${sells.length})`}>
        {sells.length === 0 ? <Empty /> : sells.map((s) => (
          <Row key={s.id} href={`/admin/sell?q=${encodeURIComponent(s.itemTitle)}`}
            main={s.itemTitle} sub="" right={s.status.toLowerCase()} date={s.createdAt} />
        ))}
      </Section>

      <Section title={`Support tickets (${tickets.length})`}>
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
      </Section>

      <Section title={`Seller conversations (${threads.length})`}>
        {threads.length === 0 ? <Empty /> : threads.map((th) => (
          <Row key={th.id} href={`/admin/messages?q=${encodeURIComponent(th.subject ?? '')}`}
            main={th.subject ?? 'Conversation'} sub={`${th._count.messages} messages`}
            right="" date={th.lastMessageAt} />
        ))}
      </Section>

      <Section title={`Reviews (${reviews.length})`}>
        {reviews.length === 0 ? <Empty /> : reviews.map((r) => (
          <Row key={r.id} href={`/marketplace/${r.product.slug}`}
            main={r.product.title} sub={r.body.slice(0, 80)} right={`★ ${r.rating}`} date={r.createdAt} />
        ))}
      </Section>

      <div className="rounded-2xl border border-border bg-foreground/[0.02] p-5 text-sm text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">Not tracked</p>
        Page views, product-search history and AI-assistant chats are <strong>not recorded</strong> by
        the platform, so they cannot be shown here. Adding that requires opt-in event/search logging
        and persisting assistant conversations — ask if you want it built.
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
