import { Megaphone, Sparkles, AlertOctagon } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { sendAnnouncement } from '../actions';
import { AnnouncementComposer } from '@/components/admin/AnnouncementComposer';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Announcements' };

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  OFFER: Sparkles,
  ANNOUNCEMENT: Megaphone,
  SYSTEM: AlertOctagon,
};

const KIND_TINT: Record<string, string> = {
  OFFER: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  ANNOUNCEMENT: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  SYSTEM: 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
};

export default async function AdminAnnouncementsPage() {
  await requireCapability('content:cms');

  const [sendLog, allCount, buyerCount, sellerCount] = await Promise.all([
    // One audit row per broadcast (target = audience, meta = title). The list
    // used to group ALL notifications, so every order/quote system notice
    // showed up here as if it were an announcement.
    prisma.auditLog.findMany({
      where: { action: 'announcement.send' },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { target: true, meta: true, createdAt: true },
    }),
    prisma.user.count(),
    prisma.user.count({ where: { role: 'BUYER' } }),
    prisma.user.count({ where: { role: 'SELLER' } }),
  ]);

  // Recipient count per send: that broadcast's notification rows (same title,
  // written before the audit row — emails go out in between).
  const sends = await Promise.all(
    sendLog.map(async (a) => {
      const title = a.meta ?? '';
      const where = {
        title,
        kind: { in: Object.keys(KIND_ICON) },
        createdAt: { lte: a.createdAt, gte: new Date(a.createdAt.getTime() - 2 * 3600e3) },
      };
      const [count, sample] = await Promise.all([
        prisma.notification.count({ where }),
        prisma.notification.findFirst({ where, select: { kind: true, href: true } }),
      ]);
      return { title, kind: sample?.kind ?? 'ANNOUNCEMENT', at: a.createdAt, count, href: sample?.href ?? null };
    }),
  );

  const resendConfigured = !!process.env.RESEND_API_KEY;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Announcements &amp; offers</h1>
        <p className="text-muted-foreground mt-1">
          Push a notification (and optional email) to your registered users. Pick a template, edit, preview, send.
        </p>
      </div>

      <AnnouncementComposer
        action={sendAnnouncement}
        audienceCounts={{ ALL: allCount, BUYER: buyerCount, SELLER: sellerCount }}
        resendConfigured={resendConfigured}
      />

      <div>
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground mb-3">
          Recent sends ({sends.length})
        </h2>
        {sends.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center">
            <Megaphone className="h-7 w-7 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm font-semibold">Nothing sent yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Each announcement you send appears here with its recipient count.
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
