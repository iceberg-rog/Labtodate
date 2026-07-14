-- Phase 3b: suspendable user accounts (soft ban). Reversible — distinct from
-- hard DELETE which removes the row entirely.

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "suspendedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "suspendedReason" TEXT;
