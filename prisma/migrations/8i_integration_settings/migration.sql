-- 8i_integration_settings (integration of s2e + s2c + s2f, stage 2 batch 2)
-- Data only — no schema change. Two teams introduced different setting keys
-- for the same concept; ONE key is kept (src/lib/settings/defs.ts) and a value
-- an owner already saved under the retired key is carried over (when the kept
-- key has no value of its own), with a SettingChange row as the audit trail.
-- Retired keys are then removed from "Setting" (never read again).
--
--   retired (team)                       kept
--   REFUND_EMAIL_REQUESTED_TEXT (s2c) -> EMAIL_REFUND_BANK_BODY (s2e)
--   REFUND_EMAIL_CARD_TEXT      (s2c) -> EMAIL_REFUND_CARD_BODY (s2e)
--   REFUND_EMAIL_SENT_TEXT      (s2c) -> EMAIL_REFUND_SENT_BODY (s2e)
--   CREDIT_NOTE_TEXT_UNPAID     (s2c) -> CREDIT_NOTE_TEXT_NOT_PAID (s2e)
--
--   SEO_RETURN_POLICY_DAYS      (base, retired by s2f) -> RETURN_WINDOW_DAYS
--                                  + SEO_ADVERTISE_RETURN_POLICY = true (a saved
--                                  number meant: advertise this many days)
--   RETURN_WINDOW_DAYS was defined by s2c (Returns & refunds, RMA window) and
--   s2f (Catalog & claims, Terms/FAQ/JSON-LD) under the SAME key: one definition
--   is kept (Returns & refunds); no data change needed for it.
--
-- Also: AUTO_RESTOCK_ON_REFUND lost its option ALWAYS (s2c, A10: a shipped unit
-- comes back to stock only through an inspected return) -> ONLY_IF_NOT_SHIPPED.
-- Idempotent: running it again changes nothing.

-- Carry a saved value over to the kept key (only where the kept key has none).
WITH alias(old_key, new_key) AS (VALUES
  ('REFUND_EMAIL_REQUESTED_TEXT', 'EMAIL_REFUND_BANK_BODY'),
  ('REFUND_EMAIL_CARD_TEXT', 'EMAIL_REFUND_CARD_BODY'),
  ('REFUND_EMAIL_SENT_TEXT', 'EMAIL_REFUND_SENT_BODY'),
  ('CREDIT_NOTE_TEXT_UNPAID', 'CREDIT_NOTE_TEXT_NOT_PAID'),
  ('SEO_RETURN_POLICY_DAYS', 'RETURN_WINDOW_DAYS')
)
INSERT INTO "SettingChange" ("id", "key", "oldValue", "newValue", "secret", "source", "actorEmail", "createdAt")
SELECT 'mig8i_' || replace(gen_random_uuid()::text, '-', ''), a.new_key, NULL, s."value", false, 'SYSTEM',
       'migration 8i_integration_settings (value of ' || a.old_key || ')', now()
  FROM "Setting" s JOIN alias a ON a.old_key = s."key"
 WHERE btrim(s."value") <> ''
   AND NOT EXISTS (SELECT 1 FROM "Setting" k WHERE k."key" = a.new_key AND btrim(k."value") <> '');

WITH alias(old_key, new_key) AS (VALUES
  ('REFUND_EMAIL_REQUESTED_TEXT', 'EMAIL_REFUND_BANK_BODY'),
  ('REFUND_EMAIL_CARD_TEXT', 'EMAIL_REFUND_CARD_BODY'),
  ('REFUND_EMAIL_SENT_TEXT', 'EMAIL_REFUND_SENT_BODY'),
  ('CREDIT_NOTE_TEXT_UNPAID', 'CREDIT_NOTE_TEXT_NOT_PAID'),
  ('SEO_RETURN_POLICY_DAYS', 'RETURN_WINDOW_DAYS')
)
INSERT INTO "Setting" ("key", "value", "updatedAt", "updatedById")
SELECT a.new_key, s."value", now(), s."updatedById"
  FROM "Setting" s JOIN alias a ON a.old_key = s."key"
 WHERE btrim(s."value") <> ''
   AND NOT EXISTS (SELECT 1 FROM "Setting" k WHERE k."key" = a.new_key AND btrim(k."value") <> '')
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now();

-- A saved SEO_RETURN_POLICY_DAYS meant “advertise the return policy”: keep advertising it.
INSERT INTO "SettingChange" ("id", "key", "oldValue", "newValue", "secret", "source", "actorEmail", "createdAt")
SELECT 'mig8i_' || replace(gen_random_uuid()::text, '-', ''), 'SEO_ADVERTISE_RETURN_POLICY', NULL, 'true', false, 'SYSTEM',
       'migration 8i_integration_settings (SEO_RETURN_POLICY_DAYS was set)', now()
  FROM "Setting" s
 WHERE s."key" = 'SEO_RETURN_POLICY_DAYS' AND btrim(s."value") ~ '^[0-9]+$'
   AND NOT EXISTS (SELECT 1 FROM "Setting" k WHERE k."key" = 'SEO_ADVERTISE_RETURN_POLICY' AND btrim(k."value") <> '');
INSERT INTO "Setting" ("key", "value", "updatedAt", "updatedById")
SELECT 'SEO_ADVERTISE_RETURN_POLICY', 'true', now(), s."updatedById"
  FROM "Setting" s
 WHERE s."key" = 'SEO_RETURN_POLICY_DAYS' AND btrim(s."value") ~ '^[0-9]+$'
   AND NOT EXISTS (SELECT 1 FROM "Setting" k WHERE k."key" = 'SEO_ADVERTISE_RETURN_POLICY' AND btrim(k."value") <> '')
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now();

DELETE FROM "Setting"
 WHERE "key" IN ('REFUND_EMAIL_REQUESTED_TEXT', 'REFUND_EMAIL_CARD_TEXT', 'REFUND_EMAIL_SENT_TEXT', 'CREDIT_NOTE_TEXT_UNPAID', 'SEO_RETURN_POLICY_DAYS');

-- AUTO_RESTOCK_ON_REFUND: ALWAYS is no longer an option.
INSERT INTO "SettingChange" ("id", "key", "oldValue", "newValue", "secret", "source", "actorEmail", "createdAt")
SELECT 'mig8i_' || replace(gen_random_uuid()::text, '-', ''), 'AUTO_RESTOCK_ON_REFUND', 'ALWAYS', 'ONLY_IF_NOT_SHIPPED', false, 'SYSTEM',
       'migration 8i_integration_settings (option ALWAYS removed)', now()
  FROM "Setting" WHERE "key" = 'AUTO_RESTOCK_ON_REFUND' AND "value" = 'ALWAYS';
UPDATE "Setting" SET "value" = 'ONLY_IF_NOT_SHIPPED', "updatedAt" = now()
 WHERE "key" = 'AUTO_RESTOCK_ON_REFUND' AND "value" = 'ALWAYS';
