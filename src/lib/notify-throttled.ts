import { prisma } from './db';
import type { Vars } from './cms/text';
import { sendTemplatedEmail } from './email-templates/send';
import { notifyUser } from './observability';

/**
 * Fire a Notification + (throttled) email to the same recipient.
 *
 * Rationale: when two people are actively chatting (admin replies →
 * seller replies → admin replies, all in 10 minutes), pumping an email
 * for every message is noise that trains people to ignore the inbox.
 * We always create the in-app Notification (cheap, visible in the bell)
 * and we send an email only if no email landed in the recipient's
 * inbox in the last EMAIL_THROTTLE_HOURS window.
 *
 * The window is governed by the admin Setting `EMAIL_THROTTLE_HOURS`
 * (default 2). Set it to 0 to disable throttling and email every reply.
 *
 * `dedupeKey` should be stable per conversation thread (we recommend
 * `<submissionId>` or `<orderId>`) so that the throttle only suppresses
 * follow-up emails about the SAME thing — emails about a different deal
 * still fire even if both land in the same hour.
 *
 * The email is a templated one (Admin → Documents → E-mails): `emailKey`
 * names it and `emailVars` fills its fields. Its default subject carries the
 * dedupeKey; an admin who removes that field from the subject also removes
 * the throttle for that email.
 */
export async function notifyAndMaybeEmail(opts: {
  userId: string | null;
  toEmail: string;
  notifTitle: string;
  notifBody: string;
  notifHref: string;
  emailKey: string;
  emailVars: Vars;
  /** Stable identifier of the underlying thread (used in the throttle scan). */
  dedupeKey: string;
}): Promise<{ inAppCreated: boolean; emailSent: boolean; throttled: boolean }> {
  let inAppCreated = false;
  if (opts.userId) {
    try {
      await notifyUser(opts.userId, opts.notifTitle, opts.notifBody, opts.notifHref);
      inAppCreated = true;
    } catch {
      // notifyUser is best-effort already; swallow here too
    }
  }

  // Resolve throttle window. Setting may be a non-numeric blank → fall back
  // to default 2h. 0 explicitly disables the throttle.
  const raw = parseFloat(process.env.EMAIL_THROTTLE_HOURS ?? '');
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 2;

  if (hours > 0 && opts.toEmail) {
    // Did we already email this address about this same thread inside the
    // window? The dedupeKey is matched against the subject as a substring
    // so callers can put the ref (e.g. SS-IHDY5J) anywhere in the subject.
    const cutoff = new Date(Date.now() - hours * 3600_000);
    const recent = await prisma.emailLog.findFirst({
      where: {
        toAddr: opts.toEmail,
        status: 'sent',
        createdAt: { gte: cutoff },
        subject: { contains: opts.dedupeKey },
      },
      select: { id: true },
    });
    if (recent) {
      return { inAppCreated, emailSent: false, throttled: true };
    }
  }

  try {
    // false = the admin switched this email off.
    const sent = await sendTemplatedEmail({ key: opts.emailKey, to: opts.toEmail, vars: opts.emailVars });
    return { inAppCreated, emailSent: sent, throttled: false };
  } catch {
    return { inAppCreated, emailSent: false, throttled: false };
  }
}
