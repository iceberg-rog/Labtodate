-- 9c_release_v2_backlog (release v2 foundations, fix package PKG-00)
-- Columns and tables the release-v2 fix packages read and write:
--  * Order: the General Terms of Sale the buyer accepted (link, sha256 of the
--    text, when, IP) — until now only the payment terms were kept;
--  * SourcingRequest: the currency of the supplier cost behind an offer, and
--    the listing a "Source a similar unit" request refers to (not anchored to
--    that unit, so it can be offered while the listing is sold or reserved);
--  * QuotationDocument: the quotation (offer) PDF of each offer revision.
--    Commercial, not fiscal: the FiscalDocument series and their immutability
--    trigger are untouched;
--  * PaymentProof: every payment receipt of an order (uploads, rejections,
--    part payments, staff-attached), not only the latest one;
--  * attachmentNames on quote, support and sell messages (stored keys are
--    hashes; the original file names are shown);
--  * Category: SEO title/description, homepage image, show-on-home and order;
--    Product: SEO title/description;
--  * Redirect: 301 / 410 rules of the redirect manager;
--  * hold reason STOCK_SHORTAGE (paid, but the unit is gone);
--  * SellSubmission: seller VAT ID / KvK, ISO country, and when the sell terms,
--    the ownership and the decontamination declarations were accepted.
-- Additive only: every new column is nullable or has a default, nothing is
-- backfilled, no existing row changes meaning. Safe to deploy before the code.
-- Named 9c (after 9b) so a fresh database applies it after 4_business_core,
-- which creates "OrderHoldReason".

-- AlterEnum
ALTER TYPE "OrderHoldReason" ADD VALUE 'STOCK_SHORTAGE';

-- AlterTable
ALTER TABLE "SupportMessage" ADD COLUMN     "attachmentNames" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "homeOrder" INTEGER,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "seoDescription" TEXT,
ADD COLUMN     "seoTitle" TEXT,
ADD COLUMN     "showOnHome" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "seoDescription" TEXT,
ADD COLUMN     "seoTitle" TEXT;

-- AlterTable
ALTER TABLE "SourcingRequest" ADD COLUMN     "offerSupplierCostCurrency" TEXT,
ADD COLUMN     "similarToProductId" TEXT;

-- AlterTable
ALTER TABLE "QuoteMessage" ADD COLUMN     "attachmentNames" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsAcceptedIp" TEXT,
ADD COLUMN     "termsUrl" TEXT,
ADD COLUMN     "termsVersion" TEXT;

-- AlterTable
ALTER TABLE "SellSubmission" ADD COLUMN     "countryCode" TEXT,
ADD COLUMN     "decontaminationDeclaredAt" TIMESTAMP(3),
ADD COLUMN     "decontaminationNote" TEXT,
ADD COLUMN     "ownershipDeclaredAt" TIMESTAMP(3),
ADD COLUMN     "sellerKvk" TEXT,
ADD COLUMN     "sellerVatId" TEXT,
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SellMessage" ADD COLUMN     "attachmentNames" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "QuotationDocument" (
    "id" TEXT NOT NULL,
    "sourcingRequestId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "pdfKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuotationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProof" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT,
    "amountCents" INTEGER,
    "uploadedById" TEXT,
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redirect" (
    "id" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT,
    "statusCode" INTEGER NOT NULL DEFAULT 301,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Redirect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuotationDocument_number_key" ON "QuotationDocument"("number");

-- CreateIndex
CREATE UNIQUE INDEX "QuotationDocument_sourcingRequestId_revision_key" ON "QuotationDocument"("sourcingRequestId", "revision");

-- CreateIndex
CREATE INDEX "PaymentProof_orderId_idx" ON "PaymentProof"("orderId");

-- CreateIndex
CREATE INDEX "PaymentProof_key_idx" ON "PaymentProof"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Redirect_fromPath_key" ON "Redirect"("fromPath");

-- CreateIndex
CREATE INDEX "SourcingRequest_similarToProductId_idx" ON "SourcingRequest"("similarToProductId");

-- AddForeignKey
ALTER TABLE "SourcingRequest" ADD CONSTRAINT "SourcingRequest_similarToProductId_fkey" FOREIGN KEY ("similarToProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationDocument" ADD CONSTRAINT "QuotationDocument_sourcingRequestId_fkey" FOREIGN KEY ("sourcingRequestId") REFERENCES "SourcingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProof" ADD CONSTRAINT "PaymentProof_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

