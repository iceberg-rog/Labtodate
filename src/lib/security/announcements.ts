import { prisma } from '@/lib/db';
import { EmailNotConfiguredError, emailErrorSummary, emailTransportStatus, sendEmail } from '@/lib/email';
import { ensureSettingsLoaded } from '@/lib/settings';
import { getSecurityPolicy } from './policy';
import {
  MARKETING_SCOPE,
  audienceBreakdown,
  legalIdentity,
  listUnsubscribeHeaders,
  renderAnnouncementEmail,
  type AudienceKey,
} from './marketing';

/**
 * Announcement / offer broadcasts (A19). The admin action only queues: it
 * writes the in-app notifications, an AnnouncementJob and one
 * AnnouncementDelivery row per e-mail recipient. A background worker (kicked
 * right after the request with next/server `after`, and resumed by the
 * security-sweep cron after a restart) sends at the configured rate, re-checks
 * unsubscribes before every e-mail, and keeps the counters the admin page
 * shows as progress. Nothing is sent twice: a delivery is claimed (SENDING)
 * before its e-mail goes out, and one interrupted mid-send is reported as
 * "may not have been delivered" rather than retried.
 */

export type AnnouncementInput = {
  title: string;
  body: string;
  href: string | null;
  kind: 'OFFER' | 'ANNOUNCEMENT' | 'SYSTEM';
  audience: AudienceKey;
  email: boolean;
  createdById: string;
  createdByEmail: string;
};

/** OFFER / ANNOUNCEMENT are marketing (consent + unsubscribe); SYSTEM is a service message. */
export function categoryFor(kind: AnnouncementInput['kind']): 'MARKETING' | 'SERVICE' {
  return kind === 'SYSTEM' ? 'SERVICE' : 'MARKETING';
}

export async function queueAnnouncement(input: AnnouncementInput): Promise<{ ok: boolean; message: string; jobId?: string }> {
  await ensureSettingsLoaded();
  const category = categoryFor(input.kind);
  const breakdown = await audienceBreakdown(input.audience, category);
  if (breakdown.inApp === 0) return { ok: false, message: 'Nobody in that audience — nothing was sent.' };
  if (input.email) {
    const transport = emailTransportStatus();
    if (!transport.configured) return { ok: false, message: `Not sent — e-mail is not configured: ${transport.problem}.` };
    const legal = legalIdentity();
    if (category === 'MARKETING' && legal.missing.length) {
      return {
        ok: false,
        message: `Not sent — marketing e-mail must show who it is from. Fill in ${legal.missing.join(', ')} under Settings → Company first.`,
      };
    }
  }
  const users = await prisma.user.findMany({
    where: {
      suspendedAt: null,
      ...(input.audience === 'BUYER' ? { role: 'BUYER' } : input.audience === 'SELLER' ? { role: 'SELLER' } : { role: { in: ['BUYER', 'SELLER'] } }),
    },
    select: { id: true },
  });
  const job = await prisma.$transaction(async (tx) => {
    await tx.notification.createMany({
      data: users.map((u) => ({ userId: u.id, title: input.title, body: input.body, href: input.href, kind: input.kind })),
    });
    const j = await tx.announcementJob.create({
      data: {
        title: input.title,
        body: input.body,
        href: input.href,
        kind: input.kind,
        audience: input.audience,
        category,
        emailRequested: input.email,
        status: input.email && breakdown.emailable.length ? 'QUEUED' : 'DONE',
        inAppCount: users.length,
        total: input.email ? breakdown.emailable.length : 0,
        createdById: input.createdById,
        createdByEmail: input.createdByEmail,
        finishedAt: input.email && breakdown.emailable.length ? null : new Date(),
      },
    });
    if (input.email && breakdown.emailable.length) {
      await tx.announcementDelivery.createMany({
        data: breakdown.emailable.map((r) => ({ jobId: j.id, userId: r.userId, email: r.email.toLowerCase(), reason: r.reason })),
        skipDuplicates: true,
      });
    }
    return j;
  });
  const parts = [`Sent to ${users.length} user${users.length === 1 ? '' : 's'} in-app.`];
  if (input.email) {
    const ex = breakdown.excluded;
    parts.push(
      breakdown.emailable.length
        ? `${breakdown.emailable.length} e-mail${breakdown.emailable.length === 1 ? '' : 's'} queued — they go out in the background; progress is shown below.`
        : 'No one in this audience may receive this e-mail.',
    );
    const skipped = [
      ex.noConsent && `${ex.noConsent} without consent`,
      ex.unsubscribed && `${ex.unsubscribed} unsubscribed`,
      ex.notVerified && `${ex.notVerified} unverified`,
      ex.placeholder && `${ex.placeholder} placeholder address${ex.placeholder === 1 ? '' : 'es'}`,
    ].filter(Boolean);
    if (skipped.length) parts.push(`Not e-mailed: ${skipped.join(', ')}.`);
  }
  return { ok: true, message: parts.join(' '), jobId: job.id };
}

const LOCK_MS = 2 * 60_000;
const STALE_SENDING_MS = 10 * 60_000;
let running: Promise<void> | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Process queued jobs until none is left (one loop per process). */
export function kickAnnouncementWorker(): Promise<void> {
  if (!running) {
    running = workLoop()
      .catch((e) => console.error('[announcements] worker failed:', e))
      .finally(() => {
        running = null;
      });
  }
  return running;
}

async function claimJob(): Promise<string | null> {
  const now = new Date();
  const candidate = await prisma.announcementJob.findFirst({
    where: { status: { in: ['QUEUED', 'RUNNING'] }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) return null;
  const claimed = await prisma.announcementJob.updateMany({
    where: { id: candidate.id, status: { in: ['QUEUED', 'RUNNING'] }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { status: 'RUNNING', lockedUntil: new Date(Date.now() + LOCK_MS), startedAt: undefined },
  });
  if (!claimed.count) return null;
  await prisma.announcementJob.updateMany({ where: { id: candidate.id, startedAt: null }, data: { startedAt: now } });
  return candidate.id;
}

async function workLoop(): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const jobId = await claimJob();
    if (!jobId) return;
    await runJob(jobId);
  }
}

async function refreshCounters(jobId: string) {
  const groups = await prisma.announcementDelivery.groupBy({ by: ['status'], where: { jobId }, _count: { _all: true } });
  const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
  await prisma.announcementJob.update({
    where: { id: jobId },
    data: { sent: n('SENT'), failed: n('FAILED'), skipped: n('SKIPPED') },
  });
  return { pending: n('PENDING') + n('SENDING') };
}

async function runJob(jobId: string): Promise<void> {
  await ensureSettingsLoaded();
  // A send that was cut off by a restart: don't risk a duplicate, report it.
  await prisma.announcementDelivery.updateMany({
    where: { jobId, status: 'SENDING', claimedAt: { lt: new Date(Date.now() - STALE_SENDING_MS) } },
    data: { status: 'FAILED', reason: 'interrupted while sending (server restart) — may or may not have been delivered' },
  });
  const job = await prisma.announcementJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  const site = process.env.SITE_NAME || 'Labtodate';
  const base = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
  const link = job.href ? (job.href.startsWith('http') ? job.href : `${base}${job.href.startsWith('/') ? '' : '/'}${job.href}`) : `${base}/app/notifications`;
  const category = job.category === 'SERVICE' ? 'SERVICE' : 'MARKETING';

  for (;;) {
    const policy = await getSecurityPolicy();
    const gapMs = Math.max(20, Math.floor(60_000 / Math.max(1, policy.ANNOUNCEMENT_EMAILS_PER_MINUTE)));
    const batchSize = Math.max(1, Math.min(50, Math.ceil(LOCK_MS / 2 / gapMs)));
    const current = await prisma.announcementJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (!current || current.status === 'CANCELLED') break;
    await prisma.announcementJob.update({ where: { id: jobId }, data: { lockedUntil: new Date(Date.now() + LOCK_MS) } });
    const batch = await prisma.announcementDelivery.findMany({
      where: { jobId, status: 'PENDING' },
      orderBy: { id: 'asc' },
      take: batchSize,
      include: { job: false },
    });
    if (!batch.length) break;
    const users = await prisma.user.findMany({
      where: { id: { in: batch.map((d) => d.userId).filter((x): x is string => !!x) } },
      select: { id: true, name: true, suspendedAt: true, emailVerified: true, marketingOptIn: true },
    });
    const suppressed = new Set(
      (
        await prisma.emailSuppression.findMany({
          where: { scope: MARKETING_SCOPE, email: { in: batch.map((d) => d.email) } },
          select: { email: true },
        })
      ).map((s) => s.email),
    );
    for (const d of batch) {
      const claimed = await prisma.announcementDelivery.updateMany({
        where: { id: d.id, status: 'PENDING' },
        data: { status: 'SENDING', claimedAt: new Date() },
      });
      if (!claimed.count) continue;
      const u = users.find((x) => x.id === d.userId);
      // Re-checked at send time: someone may have unsubscribed or been
      // suspended after the broadcast was queued.
      const skip = !u
        ? 'account no longer exists'
        : u.suspendedAt
          ? 'account suspended'
          : !u.emailVerified
            ? 'e-mail not verified'
            : category === 'MARKETING' && suppressed.has(d.email)
              ? 'unsubscribed'
              : null;
      if (skip) {
        await prisma.announcementDelivery.update({ where: { id: d.id }, data: { status: 'SKIPPED', reason: skip } });
        continue;
      }
      const { html, text } = renderAnnouncementEmail({
        title: job.title,
        body: job.body,
        link,
        name: u!.name,
        email: d.email,
        category,
        reason: d.reason === 'opted-in' ? 'opted-in' : 'customer',
        site,
      });
      try {
        await sendEmail({
          to: d.email,
          trigger: 'marketing',
          subject: job.title,
          html,
          text,
          replyTo: policy.EMAIL_REPLY_TO || process.env.SUPPORT_EMAIL || undefined,
          headers: category === 'MARKETING' ? listUnsubscribeHeaders(d.email) : undefined,
        });
        await prisma.announcementDelivery.update({ where: { id: d.id }, data: { status: 'SENT', sentAt: new Date() } });
      } catch (e) {
        if (e instanceof EmailNotConfiguredError) {
          // Nothing can go out: put it back and stop the job with a clear reason.
          await prisma.announcementDelivery.update({ where: { id: d.id }, data: { status: 'PENDING', claimedAt: null } });
          await refreshCounters(jobId);
          await prisma.announcementJob.update({
            where: { id: jobId },
            data: { status: 'FAILED', lastError: e.message, lockedUntil: null },
          });
          return;
        }
        await prisma.announcementDelivery.update({
          where: { id: d.id },
          data: { status: 'FAILED', reason: emailErrorSummary(e).slice(0, 300) },
        });
        await prisma.announcementJob.update({ where: { id: jobId }, data: { lastError: emailErrorSummary(e).slice(0, 300) } });
      }
      await sleep(gapMs);
    }
    await refreshCounters(jobId);
  }
  const { pending } = await refreshCounters(jobId);
  const final = await prisma.announcementJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (final?.status === 'CANCELLED') {
    await prisma.announcementDelivery.updateMany({ where: { jobId, status: 'PENDING' }, data: { status: 'SKIPPED', reason: 'broadcast cancelled' } });
    await refreshCounters(jobId);
    await prisma.announcementJob.update({ where: { id: jobId }, data: { lockedUntil: null, finishedAt: new Date() } });
    return;
  }
  if (pending === 0) {
    await prisma.announcementJob.update({ where: { id: jobId }, data: { status: 'DONE', lockedUntil: null, finishedAt: new Date() } });
  }
}
