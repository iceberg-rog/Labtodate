import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { getServerSession } from '@/lib/auth-server';
import { dispatchWebhook, type NotifyKind } from '@/lib/webhooks';
import { capsAllow } from '@/lib/capabilities';
import { clientIpFrom } from '@/lib/ratelimit';

async function requestIp(): Promise<string | null> {
  try {
    return clientIpFrom(await headers());
  } catch {
    return null; // outside a request (cron, background job)
  }
}

/** Best-effort admin action audit log (actor, actor id, IP). Never throws. */
export async function audit(action: string, target?: string, meta?: string): Promise<void> {
  try {
    const session = await getServerSession().catch(() => null);
    await prisma.auditLog.create({
      data: {
        actorEmail: session?.user.email ?? null,
        actorId: session?.user.id ?? null,
        ip: await requestIp(),
        action,
        target: target ?? null,
        meta: meta ? meta.slice(0, 1000) : null,
      },
    });
  } catch {
    /* observability must never break the action */
  }
}

/** Audit with an explicit actor — for auth events that happen before / without a session. */
export async function auditAs(
  actor: { email?: string | null; id?: string | null; ip?: string | null },
  action: string,
  target?: string,
  meta?: string,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorEmail: actor.email ?? null,
        actorId: actor.id ?? null,
        ip: actor.ip ?? (await requestIp()),
        action,
        target: target ?? null,
        meta: meta ? meta.slice(0, 1000) : null,
      },
    });
  } catch {
    /* ignore */
  }
}

/**
 * Which capability an admin needs to act on a notification, from the admin
 * page it links to — a scoped admin (support, content …) must not be sent
 * order amounts, buyer names or seller offers they are not allowed to open.
 */
export function capabilityForAdminHref(href: string): string | null {
  const path = href.replace(/^https?:\/\/[^/]+/, '');
  const rules: [RegExp, string][] = [
    [/^\/admin\/orders/, 'orders:view'],
    [/^\/admin\/quotes/, 'quotes:view'],
    [/^\/admin\/tickets/, 'tickets:view'],
    [/^\/admin\/sell/, 'sell:view'],
    [/^\/admin\/messages/, 'messages:view'],
    [/^\/admin\/products/, 'products:view'],
    [/^\/admin\/users/, 'users:view'],
    [/^\/admin\/companies/, 'companies:manage'],
    [/^\/admin\/settings/, 'settings:view'],
    [/^\/admin\/errors/, 'errors:view'],
    [/^\/admin\/audit/, 'audit:view'],
  ];
  for (const [re, cap] of rules) if (re.test(path)) return cap;
  return null;
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
    const needed = capabilityForAdminHref(href);
    const admins = (
      await prisma.user.findMany({
        where: { role: 'ADMIN', suspendedAt: null },
        select: { id: true, adminCaps: true },
      })
    ).filter((a) => !needed || capsAllow(a.adminCaps, needed));
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
