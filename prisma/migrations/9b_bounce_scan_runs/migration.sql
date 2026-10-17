-- 9b_bounce_scan_runs
-- Bounce reports (DSNs) read from the sending mailbox over IMAP by the
-- security sweep (src/lib/email-guard/bounce-mailbox.ts): one row per run,
-- shown on Admin -> Security -> E-mail protection; the next run continues
-- after "lastUid" of the same mailbox. Reports name the e-mail that bounced
-- by its Message-ID, so EmailLog gets an index on it.
-- Additive only (new table, new index): safe to run on live data.

CREATE TABLE IF NOT EXISTS "bounce_scan_run" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "mailbox" TEXT,
    "checked" INTEGER NOT NULL DEFAULT 0,
    "reports" INTEGER NOT NULL DEFAULT 0,
    "permanent" INTEGER NOT NULL DEFAULT 0,
    "suppressed" INTEGER NOT NULL DEFAULT 0,
    "ignored" INTEGER NOT NULL DEFAULT 0,
    "unmatched" INTEGER NOT NULL DEFAULT 0,
    "uidValidity" BIGINT,
    "lastUid" BIGINT,
    "error" TEXT,
    "items" JSONB,

    CONSTRAINT "bounce_scan_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "bounce_scan_run_startedAt_idx" ON "bounce_scan_run"("startedAt");
CREATE INDEX IF NOT EXISTS "EmailLog_messageId_idx" ON "EmailLog"("messageId");
