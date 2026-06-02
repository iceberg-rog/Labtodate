import { Megaphone, Sparkles, AlertOctagon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { sendAnnouncement } from '../actions';
import { AnnouncementComposer } from '@/components/admin/AnnouncementComposer';

export const dynamic = 'force-dynamic';

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  OFFER: Sparkles,
  ANNOUNCEMENT: Megaphone,
  SYSTEM: AlertOctagon,
};

const KIND_TINT: Record<string, string> = {
  OFFER: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ANNOUNCEMENT: 'bg-sky-50 text-sky-700 border-sky-200',
  SYSTEM: 'bg-amber-50 text-amber-800 border-amber-200',
};

export default async function AdminAnnouncementsPage() {
  await requireCapability('content:cms');

  const [recent, allCount, buyerCount, sellerCount] = await Promise.all([
    prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: { title: true, kind: true, createdAt: true, href: true },
    }),
    prisma.user.count(),
    prisma.user.count({ where: { role: 'BUYER' } }),
    prisma.user.count({ where: { role: 'SELLER' } }),
  ]);

  // Group recent notifications into batches by title + minute so 1 send
  // doesn't look like N rows.
  const batches = new Map<
    string,
    { title: string; kind: string; at: Date; count: number; href: string | null }
  >();
  for (const n of recent) {
    const key = `${n.title}@${new Date(n.createdAt).toISOString().slice(0, 16)}`;
    const b = batches.get(key);
    if (b) b.count++;
    else batches.set(key, { title: n.title, kind: n.kind, at: n.createdAt, count: 1, href: n.href });
  }
  const sends = Array.from(batches.values()).slice(0, 30);

  const resendConfigured = !!process.env.RESEND_API_KEY;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Announcements &amp; offers</h1>
        <p className="text-muted-foreground mt-1">
          Push a notification (and optional email) to your registered users. Pick a template, edit, preview, send.
        </p>
      </div>

      <form action={sendAnnouncement} className="space-y-6">
        <AnnouncementComposer
          audienceCounts={{ ALL: allCount, BUYER: buyerCount, SELLER: sellerCount }}
          resendConfigured={resendConfigured}
        />
        <div className="sticky bottom-3 z-10 flex items-center gap-3 bg-background/95 backdrop-blur p-3 rounded-2xl border border-border shadow-sm">
          <Button type="submit" size="lg" className="rounded-2xl font-semibold">
            <Megaphone className="h-4 w-4" /> Send to users
          </Button>
          <span className="text-xs text-muted-foreground">
            In-app notifications deliver instantly. Emails are best-effort — check the Recent sends list below.
          </span>
        </div>
      </form>

      <div>
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground mb-3">
          Recent sends ({sends.length})
        </h2>
        {sends.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center">
            <Megaphone className="h-7 w-7 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm font-semibold">Nothing sent yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              When you send an announcement, recipient batches appear here grouped by title + minute.
            </p>
          </div>
        ) : (
          <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
            {sends.map((s, i) => {
              const Icon = KIND_ICON[s.kind] ?? Megaphone;
              const tint = KIND_TINT[s.kind] ?? 'bg-foreground/5 text-foreground border-border';
              return (
                <li key={i} className="p-4 flex items-center gap-4 flex-wrap">
                  <span
                    className={`inline-flex items-center justify-center h-9 w-9 rounded-full border ${tint} flex-shrink-0`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">{s.title}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {s.kind.toLowerCase()} ·{' '}
                      {new Date(s.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                      {s.href ? <> · linked to <code className="font-mono text-foreground">{s.href}</code></> : null}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs font-bold tabular-nums text-muted-foreground bg-foreground/5 px-2 py-1 rounded-full">
                    {s.count} recipient{s.count === 1 ? '' : 's'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
