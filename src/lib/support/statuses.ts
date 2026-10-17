import type { TicketStatus } from '@prisma/client';

/**
 * Ticket statuses where support owes the next reply — the admin "Open" tab.
 * Every new ticket and every customer reply lands in WAITING_ON_SUPPORT, so a
 * filter on OPEN alone misses nearly all live tickets.
 */
export const TICKETS_AWAITING_SUPPORT: TicketStatus[] = ['OPEN', 'WAITING_ON_SUPPORT'];

/** Every not-yet-finished status, whoever's move it is (PENDING is the legacy
 *  alias of WAITING_ON_CUSTOMER). */
export const ACTIVE_TICKET_STATUSES: TicketStatus[] = ['OPEN', 'WAITING_ON_SUPPORT', 'WAITING_ON_CUSTOMER', 'PENDING'];

/**
 * SLA tier defaults (hours). Customer-configurable later via Settings, but
 * these are the baked defaults that drive `dueAt` + the "overdue" badge.
 * URGENT / VIP share the same tightest tier (2h response).
 */
export const SLA_HOURS: Record<string, number> = {
  URGENT: 2,
  VIP: 2,
  HIGH: 8,
  NORMAL: 24,
  LOW: 72,
};

export function computeDueAt(createdAt: Date, priority: string): Date {
  const h = SLA_HOURS[priority] ?? SLA_HOURS.NORMAL;
  return new Date(createdAt.getTime() + h * 3600e3);
}
