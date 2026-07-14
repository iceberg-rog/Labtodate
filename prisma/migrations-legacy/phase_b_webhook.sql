-- Phase B: outbound webhooks (Slack/Discord/Telegram).
-- All-or-nothing in one transaction; safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS "WebhookConfig" (
  "id"        TEXT PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "kind"      TEXT NOT NULL,
  "url"       TEXT NOT NULL,
  "chatId"    TEXT,
  "events"    TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[],
  "isActive"  BOOLEAN NOT NULL DEFAULT TRUE,
  "lastError" TEXT,
  "lastOkAt"  TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "WebhookConfig_isActive_idx" ON "WebhookConfig" ("isActive");
