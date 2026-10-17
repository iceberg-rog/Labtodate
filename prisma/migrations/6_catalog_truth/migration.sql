-- 6_catalog_truth (team: catalog)
-- Catalog & content truthfulness: per-item warranty/inspection evidence, condition
-- grades, supplier sync identity + field ownership, import run log, supplier
-- verification/agreement, consent records, order-line warranty snapshot.
-- Additive only; the data steps at the end are idempotent.

-- CreateEnum
CREATE TYPE "ImportSyncPolicy" AS ENUM ('PRICE_STOCK_ONLY', 'CONTENT_TOO');

-- CreateEnum
CREATE TYPE "SyncStockMode" AS ENUM ('SUBTRACT_LOCAL_SALES', 'SOURCE_IS_TRUTH');

-- CreateEnum
CREATE TYPE "SupplierAgreementStatus" AS ENUM ('NONE', 'SENT', 'SIGNED', 'OWN_SHOP', 'TERMINATED');

-- AlterTable
ALTER TABLE "CaseStudy" ADD COLUMN     "consentAt" TIMESTAMP(3),
ADD COLUMN     "consentBy" TEXT,
ADD COLUMN     "consentNote" TEXT;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "agreementNote" TEXT,
ADD COLUMN     "agreementSignedAt" TIMESTAMP(3),
ADD COLUMN     "agreementStatus" "SupplierAgreementStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "archiveMissingAtSource" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "autoPublishImports" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "importCondition" "ProductCondition" NOT NULL DEFAULT 'USED',
ADD COLUMN     "importDefaultQuantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "syncIntervalMinutes" INTEGER,
ADD COLUMN     "syncPolicy" "ImportSyncPolicy" NOT NULL DEFAULT 'PRICE_STOCK_ONLY',
ADD COLUMN     "syncStockMode" "SyncStockMode" NOT NULL DEFAULT 'SUBTRACT_LOCAL_SALES',
ADD COLUMN     "verificationNote" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedByEmail" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "conditionSnapshot" TEXT,
ADD COLUMN     "warrantyMonthsSnapshot" INTEGER,
ADD COLUMN     "warrantySnapshot" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "conditionNotes" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "externalSource" TEXT,
ADD COLUMN     "inspectedAt" TIMESTAMP(3),
ADD COLUMN     "inspectionNotes" TEXT,
ADD COLUMN     "inspectionReportUrl" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "lockedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mpn" TEXT,
ADD COLUMN     "removedAtSourceAt" TIMESTAMP(3),
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "sourceAvailability" TEXT,
ADD COLUMN     "sourceImageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sourceSlug" TEXT,
ADD COLUMN     "warrantyMonths" INTEGER;

-- AlterTable
ALTER TABLE "Testimonial" ADD COLUMN     "consentAt" TIMESTAMP(3),
ADD COLUMN     "consentBy" TEXT,
ADD COLUMN     "consentNote" TEXT;

-- CreateTable
CREATE TABLE "ConditionGrade" (
    "code" "ProductCondition" NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "schemaOrgCondition" TEXT NOT NULL,
    "defaultWarrantyMonths" INTEGER,
    "warrantyScope" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConditionGrade_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actorEmail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "counts" JSONB,
    "items" JSONB,
    "error" TEXT,

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportRun_companyId_startedAt_idx" ON "ImportRun"("companyId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Product_companyId_externalSource_externalId_key" ON "Product"("companyId", "externalSource", "externalId");

-- AddForeignKey
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Data ────────────────────────────────────────────────────────────────
-- Condition grades: labels + schema.org mapping. No default warranty is
-- assumed for any condition: until the owner sets one in Admin → Catalog →
-- Conditions & warranty, an item without its own warranty shows the
-- configured "no warranty" text instead of an invented promise.
INSERT INTO "ConditionGrade" ("code", "label", "description", "schemaOrgCondition", "defaultWarrantyMonths", "warrantyScope", "sortOrder", "updatedAt")
VALUES
  ('NEW',         'New',         NULL, 'NewCondition',         NULL, NULL, 0, CURRENT_TIMESTAMP),
  ('REFURBISHED', 'Refurbished', NULL, 'RefurbishedCondition', NULL, NULL, 1, CURRENT_TIMESTAMP),
  ('USED',        'Used',        NULL, 'UsedCondition',        NULL, NULL, 2, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- "Verified" used to be the default for every new shop. It is now a recorded
-- decision (verifiedAt + who + what was checked); shops nobody verified that
-- way lose the flag until an admin verifies them with a note.
UPDATE "Company" SET "isVerified" = false WHERE "verifiedAt" IS NULL AND "isVerified" = true;
