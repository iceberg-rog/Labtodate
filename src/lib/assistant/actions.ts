/**
 * Chat archive — read-only queries over the transcripts of the former on-site
 * chat (AssistantConversation / AssistantMessage) for Admin → Chat archive.
 *
 * The chat was removed (owner decision: support runs on tickets only), so
 * nothing here sends, claims, closes or rates a conversation, sets a cookie
 * or calls an AI provider. The tables stay as a read-only archive until the
 * retention review drops them.
 *
 * Deliberately not a 'use server' file: every export of one is a public
 * endpoint. These are plain server functions for the admin pages, which
 * check messages:view before calling them.
 */

import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';

export const ARCHIVE_PAGE_SIZE = 50;

/** How a conversation ended, from its last stored status. */
export type ArchiveOutcome = 'unanswered' | 'team' | 'ai' | 'closed' | 'ended';

export const ARCHIVE_OUTCOME_LABEL: Record<ArchiveOutcome, string> = {
  unanswered: 'Asked for a person — unanswered',
  team: 'Answered by the team',
  ai: 'AI only',
  closed: 'Closed by the team',
  ended: 'Ended',
};

/**
 * The stored status means: AI (only the AI answered — unless a team member
 * replied without the status moving, which the old reply action allowed),
 * AWAITING_HUMAN (the customer asked for a person and nobody joined),
 * WITH_HUMAN (a team member joined), CLOSED (the team closed it), ARCHIVED
 * (the customer rated it or started a new chat).
 */
export function archiveOutcome(c: { status: string; assignedToId: string | null }): ArchiveOutcome {
  switch (c.status) {
    case 'AWAITING_HUMAN':
      return 'unanswered';
    case 'WITH_HUMAN':
      return 'team';
    case 'CLOSED':
      return 'closed';
    case 'ARCHIVED':
      return 'ended';
    default:
      return c.assignedToId ? 'team' : 'ai';
  }
}

export const ARCHIVE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unanswered', label: 'Unanswered requests for a person' },
  { key: 'team', label: 'Answered by the team' },
  { key: 'ai', label: 'AI only' },
  { key: 'closed', label: 'Closed or ended' },
] as const;

export type ArchiveFilter = (typeof ARCHIVE_FILTERS)[number]['key'];

export function archiveFilterOf(value: string | undefined): ArchiveFilter {
  return ARCHIVE_FILTERS.find((f) => f.key === value)?.key ?? 'all';
}

/** The conversations of one filter — exactly those whose archiveOutcome it names. */
export function archiveFilterWhere(filter: ArchiveFilter): Prisma.AssistantConversationWhereInput {
  switch (filter) {
    case 'unanswered':
      return { status: 'AWAITING_HUMAN' };
    case 'team':
      return { OR: [{ status: 'WITH_HUMAN' }, { status: { notIn: ['AWAITING_HUMAN', 'WITH_HUMAN', 'CLOSED', 'ARCHIVED'] }, assignedToId: { not: null } }] };
    case 'ai':
      return { status: { notIn: ['AWAITING_HUMAN', 'WITH_HUMAN', 'CLOSED', 'ARCHIVED'] }, assignedToId: null };
    case 'closed':
      return { status: { in: ['CLOSED', 'ARCHIVED'] } };
    default:
      return {};
  }
}

/** Search over subject, the customer's name and e-mail and the message text. */
export function archiveSearchWhere(q: string): Prisma.AssistantConversationWhereInput {
  const s = q.trim();
  if (!s) return {};
  const contains = { contains: s, mode: 'insensitive' as const };
  return {
    OR: [
      { subject: contains },
      { guestName: contains },
      { guestEmail: contains },
      { user: { name: contains } },
      { user: { email: contains } },
      { messages: { some: { body: contains } } },
    ],
  };
}

/** Number of conversations per filter (for the filter chips). */
export async function archiveCounts(): Promise<Record<ArchiveFilter, number>> {
  const counts = await Promise.all(ARCHIVE_FILTERS.map((f) => prisma.assistantConversation.count({ where: archiveFilterWhere(f.key) })));
  return Object.fromEntries(ARCHIVE_FILTERS.map((f, i) => [f.key, counts[i]])) as Record<ArchiveFilter, number>;
}

/** One page of the archive, most recent first. */
export async function listArchive(opts: { filter: ArchiveFilter; q: string; page: number }) {
  const where: Prisma.AssistantConversationWhereInput = { AND: [archiveFilterWhere(opts.filter), archiveSearchWhere(opts.q)] };
  const [total, rows] = await Promise.all([
    prisma.assistantConversation.count({ where }),
    prisma.assistantConversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: (Math.max(1, opts.page) - 1) * ARCHIVE_PAGE_SIZE,
      take: ARCHIVE_PAGE_SIZE,
      select: {
        id: true, status: true, subject: true, rating: true,
        guestName: true, guestEmail: true, assignedToId: true,
        user: { select: { name: true, email: true } },
        startedAt: true, lastMessageAt: true,
        _count: { select: { messages: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { role: true, body: true } },
      },
    }),
  ]);
  return { total, rows };
}

/** Totals for the summary strip of the archive. */
export async function archiveSummary() {
  const [total, unanswered, team, range, ratings] = await Promise.all([
    prisma.assistantConversation.count(),
    prisma.assistantConversation.count({ where: archiveFilterWhere('unanswered') }),
    prisma.assistantConversation.count({ where: archiveFilterWhere('team') }),
    prisma.assistantConversation.aggregate({ _min: { startedAt: true }, _max: { lastMessageAt: true } }),
    prisma.assistantConversation.aggregate({ _avg: { rating: true }, _count: { rating: true }, where: { rating: { not: null } } }),
  ]);
  return {
    total,
    unanswered,
    team,
    firstAt: range._min.startedAt,
    lastAt: range._max.lastMessageAt,
    rated: ratings._count.rating,
    avgRating: ratings._avg.rating,
  };
}

/**
 * The mailto: link to follow up a transcript, or null when the address is not
 * one well-formed e-mail address. A guest typed it at escalation and it was
 * never validated, so it may be a name, a list or carry ?bcc=/&body= that
 * would pre-fill the staff member’s mail.
 */
export function followUpMailto(email: string | null | undefined): string | null {
  if (!email || !z.string().email().safeParse(email).success) return null;
  return `mailto:${encodeURIComponent(email).replace(/%40/g, '@')}`;
}

/** One transcript with the names of the team members who wrote in it, joined or closed it. */
export async function getArchivedConversation(id: string) {
  const conv = await prisma.assistantConversation.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, createdAt: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, authorId: true, body: true, attachments: true, createdAt: true },
      },
    },
  });
  if (!conv) return null;
  // assignedToId / closedById / authorId are loose user ids (no relations on the model).
  const staffIds = [
    ...new Set(
      [conv.assignedToId, conv.closedById, ...conv.messages.filter((m) => m.role === 'admin').map((m) => m.authorId)].filter(
        (x): x is string => !!x,
      ),
    ),
  ];
  const staff = staffIds.length
    ? await prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } })
    : [];
  const staffNames: Record<string, string> = Object.fromEntries(staff.map((u) => [u.id, u.name]));
  return { conv, staffNames };
}
