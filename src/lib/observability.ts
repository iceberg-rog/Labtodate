import { prisma } from '@/lib/db';
import { getServerSession } from '@/lib/auth-server';
import { dispatchWebhook, type NotifyKind } from '@/lib/webhooks';

/** Best-effort admin action audit log. Never throws. */
export async function audit(action: string, target?: string, meta?: string): Promise<void> {
  try {
    const session = await getServerSession();
    await prisma.auditLog.create({
      data: {
        actorEmail: session?.user.email ?? null,
        action,
        target: target ?? null,
        meta: meta ? meta.slice(0, 1000) : null,
      },
    });
  } catch {
    /* observability must never break the action */
  }
}

/** In-app notify every ADMIN AND fan out to any active webhooks. Never throws.
 *  `kind` lets external webhooks subscribe selectively (e.g. only ORDER_PAID). */
export async function notifyAdmins(
  title: string,
  body: string,
  href: string,
  kind: NotifyKind = 'SYSTEM',
): Promise<void> {
  // Always attempt the in-app side first; webhook is best-effort.
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    if (admins.length > 0) {
      await prisma.notification.createMany({
        data: admins.map((a) => ({
          userId: a.id,
          title: title.slice(0, 140),
          body: body.slice(0, 500),
          href,
          kind,
        })),
      });
    }
  } catch {
    /* never break the submission */
  }
  // Outbound webhook (Slack/Discord/Telegram). Already wrapped in
  // Promise.allSettled inside dispatchWebhook, so failures are absorbed.
  try {
    await dispatchWebhook(kind, title, body, href);
  } catch {
    /* ignore */
  }
}

/**
 * In-app notification for one specific user (buyer/seller). Used so the
 * recipient finds out about quote replies, order/shipping updates, refunds
 * etc. without depending on email (which may not be configured).
 */
export async function notifyUser(
  userId: string | null | undefined,
  title: string,
  body: string,
  href: string,
): Promise<void> {
  if (!userId) return;
  try {
    await prisma.notification.create({
      data: {
        userId,
        title: title.slice(0, 140),
        body: body.slice(0, 500),
        href,
        kind: 'SYSTEM',
      },
    });
  } catch {
    /* never break the calling action */
  }
}

/** Best-effort error log surfaced in /admin/errors. Never throws. */
export async function logError(where: string, e: unknown): Promise<void> {
  try {
    const message = e instanceof Error ? `${e.message}` : String(e);
    await prisma.errorLog.create({
      data: { where: where.slice(0, 200), message: message.slice(0, 2000) },
    });
  } catch {
    /* ignore */
  }
}
