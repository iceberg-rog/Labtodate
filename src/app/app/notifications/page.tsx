import Link from 'next/link';
import { Bell, Tag, Megaphone, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { markNotificationsRead } from '@/lib/notifications/actions';
import { AutoRefresh } from '@/components/util/AutoRefresh';

export const dynamic = 'force-dynamic';

const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  OFFER: Tag,
  ANNOUNCEMENT: Megaphone,
  SYSTEM: Info,
};

export default async function NotificationsPage() {
  const session = await requireSession({ redirectTo: '/app/notifications' });
  const items = await prisma.notification.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const unread = items.filter((n) => !n.readAt).length;

  // Viewing the list = you've seen them: mark read so the sidebar badge
  // clears. The unread highlight below still reflects this visit because
  // `items` was fetched before this update.
  if (unread > 0) {
    await prisma.notification.updateMany({
      where: { userId: session.user.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
          <p className="text-muted-foreground mt-1">
            {unread > 0 ? `${unread} unread` : 'All caught up'}
          </p>
        </div>
        {unread > 0 && (
          <form action={markNotificationsRead}>
            <Button type="submit" variant="outline" className="rounded-full font-semibold">
              Mark all read
            </Button>
          </form>
        )}
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <Bell className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No notifications</p>
          <p className="text-sm text-muted-foreground mt-2">Offers and updates will appear here.</p>
        </div>
      ) : (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
          {items.map((n) => {
            const Icon = ICON[n.kind] ?? Bell;
            const inner = (
              <div className={`p-5 flex gap-4 ${n.readAt ? '' : 'bg-accent/[0.05]'}`}>
                <div className="flex-shrink-0 h-10 w-10 rounded-xl bg-accent/15 text-primary flex items-center justify-center">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {!n.readAt && <span className="h-2 w-2 rounded-full bg-accent flex-shrink-0" />}
                    <p className="font-semibold">{n.title}</p>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap leading-relaxed">
                    {n.body}
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    {new Date(n.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                  </p>
                </div>
              </div>
            );
            return (
              <li key={n.id}>
                {n.href ? (
                  <Link href={n.href} className="block hover:bg-foreground/[0.02]">
                    {inner}
                  </Link>
                ) : (
                  inner
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
