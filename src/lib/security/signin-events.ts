import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { brandedMail, mailBrandColor } from '@/lib/quotes/mail';
import { getSecurityPolicy } from './policy';

/** "Chrome on Windows" from a user agent (coarse on purpose: a browser update is not a new device). */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

/**
 * A completed sign-in: audit it with the device, and e-mail the owner when
 * it is a device this account has not signed in from before
 * (NEW_DEVICE_ALERT, Settings → Security). The very first sign-in of an
 * account is not "new".
 */
export async function noteSuccessfulSignIn(
  user: { id: string; email: string },
  ip: string,
  userAgent: string | null,
  method: string,
): Promise<void> {
  try {
    const device = deviceLabel(userAgent);
    const [seenDevice, anyBefore] = await Promise.all([
      prisma.auditLog.count({ where: { actorId: user.id, action: 'auth.signin', meta: { contains: `device=${device};` } } }),
      prisma.auditLog.count({ where: { actorId: user.id, action: 'auth.signin' } }),
    ]);
    await prisma.auditLog.create({
      data: { actorEmail: user.email, actorId: user.id, ip, action: 'auth.signin', target: user.id, meta: `device=${device}; ${method}` },
    });
    if (seenDevice > 0 || anyBefore === 0) return;
    const policy = await getSecurityPolicy();
    if (!policy.NEW_DEVICE_ALERT) return;
    const site = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
    const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });
    const mail = await brandedMail((brand) => {
      const link = `style="color:${mailBrandColor()};"`;
      return {
        subject: `New sign-in to your ${brand} account`,
        heading: 'New sign-in',
        body: [
          `Your account was just signed in to${method === 'magic link' ? ' with an e-mailed sign-in link' : ''} from a device we haven’t seen before:`,
          `<p style="margin:0 0 12px;"><strong>${escapeHtml(device)}</strong><br>IP address ${escapeHtml(ip)}<br>${escapeHtml(when)} (Amsterdam time)</p>`,
          'Was this you? Then there is nothing to do.',
          `Not you? <a href="${site}/auth/forgot-password" ${link}>Reset your password</a> now, then check the signed-in devices under <a href="${site}/app/security" ${link}>Account security</a>.`,
        ],
        text: `New sign-in to your ${brand} account: ${device}, IP ${ip}, ${when} (Amsterdam time). Not you? Reset your password at ${site}/auth/forgot-password and check ${site}/app/security.`,
      };
    });
    await sendEmail({ to: user.email, trigger: 'account', ...mail }).catch(() => {});
  } catch {
    /* never block a sign-in on this */
  }
}
