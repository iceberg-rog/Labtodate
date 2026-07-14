-- Outbound email audit table. See prisma/schema.prisma model EmailLog.
CREATE TABLE IF NOT EXISTS "EmailLog" (
  id         TEXT NOT NULL,
  "toAddr"   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT,
  "messageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailLog_pkey" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS "EmailLog_toAddr_idx" ON "EmailLog" ("toAddr");
CREATE INDEX IF NOT EXISTS "EmailLog_createdAt_idx" ON "EmailLog" ("createdAt");
