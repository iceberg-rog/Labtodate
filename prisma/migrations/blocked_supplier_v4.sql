-- Blocklist for AI shop discovery. Applied 2026-05-25. Idempotent.
CREATE TABLE IF NOT EXISTS "BlockedSupplier" (
  "id"        TEXT PRIMARY KEY,
  "hostname"  TEXT NOT NULL,
  "reason"    TEXT,
  "blockedBy" TEXT,
  "blockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "BlockedSupplier_hostname_key" ON "BlockedSupplier" ("hostname");
CREATE INDEX        IF NOT EXISTS "BlockedSupplier_blockedAt_idx" ON "BlockedSupplier" ("blockedAt");
