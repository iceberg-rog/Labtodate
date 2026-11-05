-- 3b_documents: editable documents, e-mails and site content. Additive only:
-- three nullable columns and four new tables; no existing row is changed.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "docLanguage" TEXT;

-- AlterTable
ALTER TABLE "SourcingRequest" ADD COLUMN     "quoteDetails" JSONB;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "docLanguage" TEXT,
ADD COLUMN     "vatRateBp" INTEGER,
ADD COLUMN     "vatTreatment" TEXT;

-- CreateTable
CREATE TABLE "ContentEntry" (
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ContentEntry_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ContentVersion" (
    "id" TEXT NOT NULL,
    "entryKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdByEmail" TEXT,

    CONSTRAINT "ContentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocNumberSeries" (
    "series" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "nextValue" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocNumberSeries_pkey" PRIMARY KEY ("series","period")
);

-- CreateTable
CREATE TABLE "IssuedDocument" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "sourcingRequestId" TEXT,
    "orderId" TEXT,
    "lang" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "pdf" BYTEA,
    "pdfSha256" TEXT,
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "vatTreatment" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),

    CONSTRAINT "IssuedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentVersion_entryKey_createdAt_idx" ON "ContentVersion"("entryKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentVersion_entryKey_version_key" ON "ContentVersion"("entryKey", "version");

-- CreateIndex
CREATE INDEX "IssuedDocument_sourcingRequestId_idx" ON "IssuedDocument"("sourcingRequestId");

-- CreateIndex
CREATE INDEX "IssuedDocument_orderId_idx" ON "IssuedDocument"("orderId");

-- CreateIndex
CREATE INDEX "IssuedDocument_kind_issuedAt_idx" ON "IssuedDocument"("kind", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedDocument_kind_number_revision_key" ON "IssuedDocument"("kind", "number", "revision");

-- AddForeignKey
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_entryKey_fkey" FOREIGN KEY ("entryKey") REFERENCES "ContentEntry"("key") ON DELETE CASCADE ON UPDATE CASCADE;

