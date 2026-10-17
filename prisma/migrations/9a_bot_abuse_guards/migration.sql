-- 9a_bot_abuse_guards
-- Anonymous e-mail guards (src/lib/email-guard): every EmailLog row records
-- what triggered it, the recipient domain and the requester's IP, so the
-- per-domain caps and the admin "E-mail protection" view can use them.
-- Bounced / admin-stopped addresses reuse "email_suppression" (5_security_
-- platform) with scope 'ALL' — no schema change needed there.
-- Additive only (nullable columns, indexes): safe to run on live data.

ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "trigger" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "toDomain" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "ip" TEXT;

CREATE INDEX IF NOT EXISTS "EmailLog_trigger_createdAt_idx" ON "EmailLog"("trigger", "createdAt");
CREATE INDEX IF NOT EXISTS "EmailLog_toDomain_createdAt_idx" ON "EmailLog"("toDomain", "createdAt");

-- Older rows: derive the domain so the admin view groups them too.
UPDATE "EmailLog"
SET "toDomain" = lower(split_part("toAddr", '@', 2))
WHERE "toDomain" IS NULL AND position('@' in "toAddr") > 0;
