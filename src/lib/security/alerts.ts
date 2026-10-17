import { prisma } from '@/lib/db';
import { sendInternalEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { dispatchWebhook } from '@/lib/webhooks';

/** Active (unsuspended) super-admins. */
export async function activeSuperAdmins(): Promise<{ id: string; email: string; name: string }[]> {
  return prisma.user.findMany({
    where: { role: 'ADMIN', suspendedAt: null, adminCaps: { has: '*' } },
    select: { id: true, email: true, name: true },
  });
}

/** Unsuspended super-admins other than `userId`. */
export async function countOtherActiveSuperAdmins(userId: string): Promise<number> {
  return prisma.user.count({
    where: { role: 'ADMIN', suspendedAt: null, adminCaps: { has: '*' }, NOT: { id: userId } },
  });
}

function siteUrl(): string {
  return (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
}

/**
 * Tell every super-admin about a security-relevant event (role / permission
 * change, refused escalation, lockout of an admin, policy change, backup
 * failure): in-app notification, e-mail and the configured webhooks. Never
 * throws — the action it reports has already happened (or been refused).
 * `extraTo` adds recipients (e.g. the backup alert list).
 */
export async function alertSuperAdmins(
  title: string,
  lines: string[],
  href = '/admin/audit',
  opts?: { extraTo?: string[]; onlyTo?: string[] },
): Promise<{ emailed: number; failed: number }> {
  let emailed = 0;
  let failed = 0;
  try {
    const admins = await activeSuperAdmins();
    if (admins.length) {
      await prisma.notification
        .createMany({
          data: admins.map((a) => ({
            userId: a.id,
            title: title.slice(0, 140),
            body: lines.join(' ').slice(0, 500),
            href,
            kind: 'SYSTEM',
          })),
        })
        .catch(() => {});
    }
    const to = new Set((opts?.onlyTo?.length ? opts.onlyTo : admins.map((a) => a.email)).map((e) => e.toLowerCase()));
    for (const e of opts?.extraTo ?? []) to.add(e.toLowerCase());
    const site = process.env.SITE_NAME || 'lab2date';
    const link = `${siteUrl()}${href}`;
    for (const addr of to) {
      const r = await sendInternalEmail(
        {
          to: addr,
          subject: `[${site} security] ${title}`,
          html: `<div style="font-family:system-ui,sans-serif;max-width:560px;">
            <h2 style="color:#0E4F40;font-size:18px;">${escapeHtml(title)}</h2>
            ${lines.map((l) => `<p style="color:#374151;margin:6px 0;">${escapeHtml(l)}</p>`).join('')}
            <p style="margin:18px 0;"><a href="${escapeHtml(link)}" style="color:#0E4F40;font-weight:600;">Open in the admin →</a></p>
            <p style="color:#9ca3af;font-size:12px;">You get this because you are a super-admin of ${escapeHtml(site)}.</p>
          </div>`,
          text: `${title}\n\n${lines.join('\n')}\n\n${link}`,
        },
        'security-alert',
      );
      if (r.ok) emailed++;
      else failed++;
    }
    await dispatchWebhook('SYSTEM', `Security: ${title}`, lines.join(' '), href).catch(() => {});
  } catch {
    /* alerts are best effort */
  }
  return { emailed, failed };
}
