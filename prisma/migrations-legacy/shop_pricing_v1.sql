-- Per-shop pricing rules + import-source tracking on Company.
-- Applied 2026-05-24. Idempotent.

DO $$ BEGIN
  CREATE TYPE "ShopPricingMode" AS ENUM ('PASS_THROUGH', 'MARKUP_PERCENT', 'FORCE_QUOTE', 'HIDE_PRICE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "pricingMode"     "ShopPricingMode" NOT NULL DEFAULT 'PASS_THROUGH',
  ADD COLUMN IF NOT EXISTS "pricingMarkupBp" INTEGER          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "importSourceUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "lastImportedAt"  TIMESTAMP(3);
