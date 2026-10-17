import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Abandoned unverified accounts: the e-mail address was never confirmed, so
 * the account never signed in (sessions need a verified address) and holds
 * nothing. In October 2026 scripts created ~90 of them through Tor with
 * SMS-gateway addresses. Admin → Users → Unverified accounts previews and
 * deletes them; the security sweep can do it automatically
 * (UNVERIFIED_AUTO_PURGE). Only plain buyer accounts with no activity of
 * any kind qualify — the rule is in {@link abandonedWhere}.
 */

export type AbandonedFilter = {
  /** Created at least this many days ago. */
  olderThanDays: number;
  /** …and on or after this moment (e.g. the start of an attack). */
  createdFrom?: Date | null;
  /** Only addresses on this domain (or its subdomains). */
  domain?: string | null;
};

/** Normalise what an admin typed into a filter (pure; unit-tested). Null when the days are invalid. */
export function parseAbandonedFilter(raw: { days?: unknown; from?: unknown; domain?: unknown }, fallbackDays: number): AbandonedFilter | null {
  const daysRaw = raw.days === undefined || raw.days === '' || raw.days === null ? fallbackDays : Number(raw.days);
  if (!Number.isInteger(daysRaw) || daysRaw < 0 || daysRaw > 3650) return null;
  let createdFrom: Date | null = null;
  if (typeof raw.from === 'string' && raw.from.trim()) {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw.from.trim()) ? `${raw.from.trim()}T00:00:00Z` : raw.from.trim());
    if (Number.isNaN(d.getTime())) return null;
    createdFrom = d;
  }
  const domain =
    typeof raw.domain === 'string' && raw.domain.trim()
      ? raw.domain.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9.-]/g, '') || null
      : null;
  return { olderThanDays: daysRaw, createdFrom, domain };
}

/** Accounts created before this moment qualify. Pure. */
export function cutoffFor(f: AbandonedFilter, now = new Date()): Date {
  return new Date(now.getTime() - f.olderThanDays * 24 * 3600_000);
}

/**
 * The rule (pure). Unverified, a buyer (never staff or a supplier), not
 * linked to a company, created before the cut-off, and NOTHING attached:
 * no order, quote, ticket, listing, message thread, sell submission, review,
 * blog/wiki post or billing profile, and no session.
 */
export function abandonedWhere(f: AbandonedFilter, now = new Date()): Prisma.UserWhereInput {
  const cutoff = cutoffFor(f, now);
  return {
    emailVerified: false,
    role: 'BUYER',
    companyId: null,
    createdAt: { lt: cutoff, ...(f.createdFrom ? { gte: f.createdFrom } : {}) },
    ...(f.domain ? { OR: [{ email: { endsWith: `@${f.domain}` } }, { email: { endsWith: `.${f.domain}` } }] } : {}),
    sessions: { none: {} },
    ordersAsBuyer: { none: {} },
    sourcingRequestsSubmitted: { none: {} },
    sourcingRequestsAssigned: { none: {} },
    quoteMessagesAuthored: { none: {} },
    supportTickets: { none: {} },
    assignedTickets: { none: {} },
    productsOwned: { none: {} },
    threadsAsBuyer: { none: {} },
    threadsAsSeller: { none: {} },
    messagesSent: { none: {} },
    sellSubmissions: { none: {} },
    reviews: { none: {} },
    blogPosts: { none: {} },
    wikiArticles: { none: {} },
    billingProfile: { is: null },
  };
}

export type AbandonedRow = { id: string; email: string; name: string; createdAt: Date; mails: number; lastMail: string | null };
export type AbandonedPreview = {
  total: number;
  /** Unverified accounts in the same date range that are kept (activity attached, or staff / supplier). */
  keptUnverified: number;
  rows: AbandonedRow[];
  domains: { domain: string; count: number }[];
  mailsSent: number;
};

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** What a purge with this filter would delete (nothing is changed). */
export async function previewAbandoned(f: AbandonedFilter, take = 200): Promise<AbandonedPreview> {
  const now = new Date();
  const where = abandonedWhere(f, now);
  const cutoff = cutoffFor(f, now);
  const [total, all, keptUnverified] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, select: { id: true, email: true, name: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 5000 }),
    prisma.user.count({
      where: {
        emailVerified: false,
        createdAt: { lt: cutoff, ...(f.createdFrom ? { gte: f.createdFrom } : {}) },
        NOT: where,
      },
    }),
  ]);
  const emails = all.map((u) => u.email);
  const logs = emails.length
    ? await prisma.emailLog.groupBy({ by: ['toAddr', 'status'], where: { toAddr: { in: emails } }, _count: { _all: true } })
    : [];
  const sentBy = new Map<string, number>();
  const lastStatus = new Map<string, string>();
  let mailsSent = 0;
  for (const l of logs) {
    if (l.status === 'sent') {
      sentBy.set(l.toAddr, (sentBy.get(l.toAddr) ?? 0) + l._count._all);
      mailsSent += l._count._all;
    } else lastStatus.set(l.toAddr, l.status);
  }
  const byDomain = new Map<string, number>();
  for (const u of all) byDomain.set(domainOf(u.email), (byDomain.get(domainOf(u.email)) ?? 0) + 1);
  return {
    total,
    keptUnverified,
    rows: all.slice(0, take).map((u) => ({ ...u, mails: sentBy.get(u.email) ?? 0, lastMail: lastStatus.get(u.email) ?? null })),
    domains: [...byDomain.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count).slice(0, 15),
    mailsSent,
  };
}

/**
 * Delete what {@link previewAbandoned} lists. The rule is re-applied inside
 * the delete itself, so an account that verified or placed an order since the
 * preview is skipped. `expected` (the count the admin confirmed) guards
 * against a filter that suddenly matches far more than was previewed.
 */
export async function purgeAbandoned(
  f: AbandonedFilter,
  opts: { expected?: number; actor: { email: string; id?: string | null }; source: 'admin' | 'sweep' },
): Promise<{ deleted: number; emails: string[]; refused?: string }> {
  const where = abandonedWhere(f);
  const now = await prisma.user.count({ where });
  if (opts.expected !== undefined && now > opts.expected) {
    return { deleted: 0, emails: [], refused: `The filter now matches ${now} accounts, more than the ${opts.expected} you confirmed. Preview again.` };
  }
  const emails: string[] = [];
  let deleted = 0;
  for (;;) {
    const batch = await prisma.user.findMany({ where, select: { id: true, email: true }, take: 200 });
    if (!batch.length) break;
    const ids = batch.map((b) => b.id);
    const r = await prisma.$transaction(async (tx) => {
      const gone = await tx.user.deleteMany({ where: { AND: [where, { id: { in: ids } }] } });
      // Pending codes / links for those addresses are useless now.
      await tx.verification.deleteMany({
        where: { identifier: { in: batch.map((b) => `email-verification-otp-${b.email.toLowerCase()}`) } },
      });
      return gone.count;
    });
    deleted += r;
    emails.push(...batch.map((b) => b.email));
    if (r === 0) break;
  }
  // The sweep runs every 5 minutes: only runs that deleted something are logged.
  if (!deleted && opts.source === 'sweep') return { deleted, emails };
  await prisma.auditLog
    .create({
      data: {
        actorEmail: opts.actor.email,
        actorId: opts.actor.id ?? null,
        action: 'users.purge-unverified',
        target: `${deleted} account${deleted === 1 ? '' : 's'}`,
        meta: `${opts.source}: older than ${f.olderThanDays} d${f.createdFrom ? `, created from ${f.createdFrom.toISOString().slice(0, 10)}` : ''}${f.domain ? `, domain ${f.domain}` : ''} — ${emails.join(', ')}`.slice(0, 8000),
      },
    })
    .catch(() => {});
  return { deleted, emails };
}
