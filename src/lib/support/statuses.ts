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
