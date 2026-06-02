-- Slice A: order soft-archive + two-step payment verification.
--
-- Soft archive: archived orders are hidden from default operator views but
-- retained forever (compliance, dispute defence, audit). Reversible.
--
-- Payment verification: distinct from the existing admin-only mark-paid path.
-- Two distinct DB events:
--   1) buyer uploads receipt + note  → paymentSubmittedAt + status AWAITING_VERIFICATION
--   2) admin verifies or rejects     → status VERIFIED / REJECTED + verifiedAt + verifiedById
-- OrderStatus enum is intentionally NOT extended (would force every status
-- consumer to re-compile); we model verification state in a dedicated nullable
-- column so the canonical status field keeps its existing semantics.

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "archivedAt"                 TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archivedById"               TEXT,
  ADD COLUMN IF NOT EXISTS "paymentSubmittedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "paymentVerificationStatus"  TEXT,
  ADD COLUMN IF NOT EXISTS "paymentVerifiedAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "paymentVerifiedById"        TEXT,
  ADD COLUMN IF NOT EXISTS "paymentRejectionReason"     TEXT;

CREATE INDEX IF NOT EXISTS "Order_archivedAt_idx"
  ON "Order" ("archivedAt") WHERE "archivedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Order_paymentVerificationStatus_idx"
  ON "Order" ("paymentVerificationStatus") WHERE "paymentVerificationStatus" IS NOT NULL;
