-- Support tickets — slice A: customer intel, priority + SLA, assignment, soft
-- archive, linked commerce. Status enum expanded to a proper B2B-support
-- lifecycle. Existing PENDING rows migrate to WAITING_ON_CUSTOMER.

-- 1. Add new status values. PostgreSQL ALTER TYPE ... ADD VALUE is the safe,
--    non-rewriting path. Cannot be inside a transaction in vanilla psql, so
--    each value gets its own statement.
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'WAITING_ON_CUSTOMER';
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'WAITING_ON_SUPPORT';
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'SPAM';

-- 2. Migrate PENDING rows to WAITING_ON_CUSTOMER. PENDING was de-facto
--    "we're waiting on customer reply" — new lifecycle makes that explicit.
UPDATE "SupportTicket" SET status = 'WAITING_ON_CUSTOMER' WHERE status = 'PENDING';

-- 3. New columns on SupportTicket.
ALTER TABLE "SupportTicket"
  ADD COLUMN IF NOT EXISTS "priority"          TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS "dueAt"             TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "slaBreachAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "assignedToId"      TEXT,
  ADD COLUMN IF NOT EXISTS "customerType"      TEXT NOT NULL DEFAULT 'REGISTERED',
  ADD COLUMN IF NOT EXISTS "accessToken"       TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archivedById"      TEXT,
  ADD COLUMN IF NOT EXISTS "orderId"           TEXT,
  ADD COLUMN IF NOT EXISTS "sourcingRequestId" TEXT,
  ADD COLUMN IF NOT EXISTS "productId"         TEXT,
  ADD COLUMN IF NOT EXISTS "lastReplyAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastReplyByStaff"  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "tags"              TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 4. Unique accessToken (partial — only enforced when set; legacy rows have NULL).
CREATE UNIQUE INDEX IF NOT EXISTS "SupportTicket_accessToken_key"
  ON "SupportTicket" ("accessToken") WHERE "accessToken" IS NOT NULL;

-- 5. Indexes that the new admin queue + sidebar joins will hit.
CREATE INDEX IF NOT EXISTS "SupportTicket_priority_idx"        ON "SupportTicket" ("priority");
CREATE INDEX IF NOT EXISTS "SupportTicket_assignedToId_idx"    ON "SupportTicket" ("assignedToId") WHERE "assignedToId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "SupportTicket_archivedAt_idx"      ON "SupportTicket" ("archivedAt") WHERE "archivedAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "SupportTicket_dueAt_idx"           ON "SupportTicket" ("dueAt") WHERE "dueAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "SupportTicket_orderId_idx"         ON "SupportTicket" ("orderId") WHERE "orderId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "SupportTicket_sourcingRequestId_idx" ON "SupportTicket" ("sourcingRequestId") WHERE "sourcingRequestId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "SupportTicket_lastReplyAt_idx"     ON "SupportTicket" ("lastReplyAt") WHERE "lastReplyAt" IS NOT NULL;

-- 6. Internal-note flag on SupportMessage. Internal notes are admin-only;
--    customer never sees them in the magic-link viewer or email reply trail.
ALTER TABLE "SupportMessage"
  ADD COLUMN IF NOT EXISTS "isInternalNote" BOOLEAN NOT NULL DEFAULT FALSE;

-- 7. Backfill lastReplyAt + lastReplyByStaff from the latest SupportMessage so
--    the new "waiting for reply" SLA badge has real data on legacy tickets.
WITH latest AS (
  SELECT DISTINCT ON ("ticketId") "ticketId", "createdAt", "fromStaff"
  FROM "SupportMessage"
  ORDER BY "ticketId", "createdAt" DESC
)
UPDATE "SupportTicket" t
SET    "lastReplyAt" = l."createdAt",
       "lastReplyByStaff" = l."fromStaff"
FROM   latest l
WHERE  t.id = l."ticketId"
  AND  t."lastReplyAt" IS NULL;

-- 8. Backfill dueAt for OPEN/WAITING_ON_SUPPORT/WAITING_ON_CUSTOMER tickets
--    using NORMAL-tier (+24h from createdAt). New tickets get a precise due
--    based on priority via the createTicket action.
UPDATE "SupportTicket"
SET    "dueAt" = "createdAt" + INTERVAL '24 hours'
WHERE  "dueAt" IS NULL
  AND  status IN ('OPEN', 'WAITING_ON_SUPPORT', 'WAITING_ON_CUSTOMER');
