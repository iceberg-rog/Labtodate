-- 4_business_core — foundation for every business rule (Stage 1, wave 1).
-- ---------------------------------------------------------------------------
-- Adds: settings change history; fiscal documents with gap-free number series
-- (immutable, enforced by trigger); tax fields on Order/OrderItem; offer
-- snapshot on SourcingRequest; billing profiles + VIES cache; stock
-- reservations; shipping zones/rates/shipments; country policy (seeded with
-- SUGGESTED defaults); refunds, returns (RMA) and the payments ledger.
-- Enforces A05: Order.sourcingRequestId FK ON DELETE RESTRICT, and triggers
-- that refuse hard-deleting paid/invoiced orders, accepted quotes and any
-- issued fiscal document.
--
-- Purely additive (no column dropped or retyped). Wrapped in one transaction:
-- any error rolls the whole migration back.
BEGIN;

-- Orphan guard for the new Order.sourcingRequestId FK: an order pointing at a
-- quote that no longer exists keeps the old id in its admin notes and is
-- unlinked (it cannot be linked to anything real).
UPDATE "Order" o
   SET "adminNotes" = left(coalesce(o."adminNotes" || E'\n', '') || '[4_business_core] Unlinked from deleted quote ' || o."sourcingRequestId" || '.', 4000),
       "sourcingRequestId" = NULL
 WHERE o."sourcingRequestId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "SourcingRequest" s WHERE s."id" = o."sourcingRequestId");

-- CreateEnum
CREATE TYPE "VatTreatment" AS ENUM ('DOMESTIC_STANDARD', 'EU_ICS_ZERO', 'EU_B2C_HOME', 'EU_B2C_OSS', 'EXPORT_ZERO', 'MARGIN_SCHEME', 'REVIEW_REQUIRED', 'LEGACY_UNSPECIFIED');

-- CreateEnum
CREATE TYPE "ProductVatScheme" AS ENUM ('STANDARD', 'MARGIN');

-- CreateEnum
CREATE TYPE "FiscalDocumentKind" AS ENUM ('PROFORMA', 'INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "FinancialStatus" AS ENUM ('UNPAID', 'UNDER_REVIEW', 'PARTIALLY_PAID', 'PAID', 'INVOICED_ON_TERMS', 'CREDIT_APPROVED', 'OVERDUE', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOID');

-- CreateEnum
CREATE TYPE "OrderHoldReason" AS ENUM ('VAT_REVIEW', 'COMPLIANCE', 'ADDRESS_REVIEW', 'SHIPPING_PENDING', 'SUPPLIER_CONFIRMATION', 'FRAUD');

-- CreateEnum
CREATE TYPE "CountryShipPolicy" AS ENUM ('ALLOW', 'REVIEW', 'BLOCK');

-- CreateEnum
CREATE TYPE "ShippingClass" AS ENUM ('PARCEL', 'PALLET', 'FREIGHT_QUOTE');

-- CreateEnum
CREATE TYPE "ShippingRateBasis" AS ENUM ('FLAT', 'PER_ITEM', 'PER_KG');

-- CreateEnum
CREATE TYPE "StockReservationSource" AS ENUM ('ORDER', 'QUOTE', 'CART');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'SENT', 'CONFIRMED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ReturnType" AS ENUM ('RETURN', 'TRANSPORT_DAMAGE', 'NOT_AS_DESCRIBED', 'WARRANTY', 'WITHDRAWAL', 'CANCELLATION');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DENIED', 'LABEL_SENT', 'IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('MANUAL', 'STRIPE', 'LEGACY');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('BUSINESS', 'INSTITUTION', 'CONSUMER');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "amountRefundedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "buyerVatId" TEXT,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "financialStatus" "FinancialStatus" NOT NULL DEFAULT 'UNPAID',
ADD COLUMN     "holdAt" TIMESTAMP(3),
ADD COLUMN     "holdNote" TEXT,
ADD COLUMN     "holdReason" "OrderHoldReason",
ADD COLUMN     "paymentTerms" JSONB,
ADD COLUMN     "proformaNumber" TEXT,
ADD COLUMN     "shippingTaxed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "supplyDate" TIMESTAMP(3),
ADD COLUMN     "vatDecidedAt" TIMESTAMP(3),
ADD COLUMN     "vatNote" TEXT,
ADD COLUMN     "vatRateBp" INTEGER,
ADD COLUMN     "vatTreatment" "VatTreatment",
ADD COLUMN     "viesCheck" JSONB;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "appliedMarkupBp" INTEGER,
ADD COLUMN     "basePriceCents" INTEGER,
ADD COLUMN     "lineType" TEXT NOT NULL DEFAULT 'GOODS',
ADD COLUMN     "taxCents" INTEGER,
ADD COLUMN     "vatRateBp" INTEGER;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "shippingClass" "ShippingClass",
ADD COLUMN     "vatScheme" "ProductVatScheme" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "weightKg" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Setting" ADD COLUMN     "updatedById" TEXT;

-- AlterTable
ALTER TABLE "SourcingRequest" ADD COLUMN     "offerRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "offerShippingCents" INTEGER,
ADD COLUMN     "offerSubtotalCents" INTEGER,
ADD COLUMN     "offerTerms" JSONB,
ADD COLUMN     "offerTotalCents" INTEGER,
ADD COLUMN     "offerVatCents" INTEGER,
ADD COLUMN     "offerVatRateBp" INTEGER,
ADD COLUMN     "offerVatTreatment" "VatTreatment";

-- CreateTable
CREATE TABLE "SettingChange" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "secret" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'ADMIN',
    "actorId" TEXT,
    "actorEmail" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettingChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceSequence" (
    "id" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalDocument" (
    "id" TEXT NOT NULL,
    "kind" "FiscalDocumentKind" NOT NULL,
    "number" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "seq" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "orderId" TEXT,
    "sourcingRequestId" TEXT,
    "originalDocumentId" TEXT,
    "supersededById" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "supplyDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "currency" TEXT NOT NULL,
    "vatTreatment" "VatTreatment" NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "pdfKey" TEXT,
    "sha256" TEXT,
    "pdfBytes" INTEGER,
    "sentAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "legacy" BOOLEAN NOT NULL DEFAULT false,
    "issuedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerType" "CustomerType" NOT NULL DEFAULT 'BUSINESS',
    "legalName" TEXT NOT NULL,
    "contactName" TEXT,
    "vatId" TEXT,
    "vatValidationId" TEXT,
    "kvkNumber" TEXT,
    "address" JSONB NOT NULL,
    "country" TEXT NOT NULL,
    "invoiceEmail" TEXT,
    "phone" TEXT,
    "poRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VatValidation" (
    "id" TEXT NOT NULL,
    "vatId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "name" TEXT,
    "address" TEXT,
    "consultationNumber" TEXT,
    "source" TEXT NOT NULL DEFAULT 'VIES',
    "checkedById" TEXT,
    "raw" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VatValidation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "source" "StockReservationSource" NOT NULL,
    "refId" TEXT NOT NULL,
    "orderId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingZone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countries" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingRate" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shippingClass" "ShippingClass" NOT NULL,
    "basis" "ShippingRateBasis" NOT NULL DEFAULT 'FLAT',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "freeAboveCents" INTEGER,
    "handlingCents" INTEGER NOT NULL DEFAULT 0,
    "minKg" DOUBLE PRECISION,
    "maxKg" DOUBLE PRECISION,
    "leadTimeText" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "parcels" INTEGER NOT NULL DEFAULT 1,
    "grossKg" DOUBLE PRECISION,
    "insured" BOOLEAN NOT NULL DEFAULT false,
    "insuredValueCents" INTEGER,
    "incoterm" TEXT,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "podKey" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CountryPolicy" (
    "country" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isEu" BOOLEAN NOT NULL DEFAULT false,
    "vatStandardRateBp" INTEGER,
    "mode" "CountryShipPolicy" NOT NULL DEFAULT 'REVIEW',
    "note" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CountryPolicy_pkey" PRIMARY KEY ("country")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "creditNoteId" TEXT,
    "restock" BOOLEAN NOT NULL DEFAULT false,
    "stripeRefundId" TEXT,
    "bankRef" TEXT,
    "executedAt" TIMESTAMP(3),
    "proofKey" TEXT,
    "overrideReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRequest" (
    "id" TEXT NOT NULL,
    "rmaNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "ReturnType" NOT NULL DEFAULT 'RETURN',
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "reasonCode" TEXT,
    "description" TEXT NOT NULL,
    "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decisionReason" TEXT,
    "receivedAt" TIMESTAMP(3),
    "inspectionGrade" TEXT,
    "outcome" TEXT,
    "ticketId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnItem" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "serial" TEXT,

    CONSTRAINT "ReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "payerName" TEXT,
    "proofKey" TEXT,
    "source" "PaymentSource" NOT NULL DEFAULT 'MANUAL',
    "stripePaymentIntentId" TEXT,
    "verifiedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettingChange_key_createdAt_idx" ON "SettingChange"("key", "createdAt");

-- CreateIndex
CREATE INDEX "SettingChange_createdAt_idx" ON "SettingChange"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceSequence_series_fiscalYear_key" ON "InvoiceSequence"("series", "fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalDocument_number_key" ON "FiscalDocument"("number");

-- CreateIndex
CREATE INDEX "FiscalDocument_orderId_idx" ON "FiscalDocument"("orderId");

-- CreateIndex
CREATE INDEX "FiscalDocument_kind_issueDate_idx" ON "FiscalDocument"("kind", "issueDate");

-- CreateIndex
CREATE INDEX "FiscalDocument_sourcingRequestId_idx" ON "FiscalDocument"("sourcingRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalDocument_series_fiscalYear_seq_key" ON "FiscalDocument"("series", "fiscalYear", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "BillingProfile_userId_key" ON "BillingProfile"("userId");

-- CreateIndex
CREATE INDEX "VatValidation_vatId_checkedAt_idx" ON "VatValidation"("vatId", "checkedAt");

-- CreateIndex
CREATE INDEX "StockReservation_productId_idx" ON "StockReservation"("productId");

-- CreateIndex
CREATE INDEX "StockReservation_source_refId_idx" ON "StockReservation"("source", "refId");

-- CreateIndex
CREATE INDEX "StockReservation_expiresAt_idx" ON "StockReservation"("expiresAt");

-- CreateIndex
CREATE INDEX "ShippingRate_zoneId_idx" ON "ShippingRate"("zoneId");

-- CreateIndex
CREATE INDEX "Shipment_orderId_idx" ON "Shipment"("orderId");

-- CreateIndex
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequest_rmaNumber_key" ON "ReturnRequest"("rmaNumber");

-- CreateIndex
CREATE INDEX "ReturnRequest_orderId_idx" ON "ReturnRequest"("orderId");

-- CreateIndex
CREATE INDEX "ReturnRequest_status_idx" ON "ReturnRequest"("status");

-- CreateIndex
CREATE INDEX "ReturnItem_returnId_idx" ON "ReturnItem"("returnId");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Order_proformaNumber_idx" ON "Order"("proformaNumber");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_sourcingRequestId_fkey" FOREIGN KEY ("sourcingRequestId") REFERENCES "SourcingRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalDocument" ADD CONSTRAINT "FiscalDocument_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalDocument" ADD CONSTRAINT "FiscalDocument_originalDocumentId_fkey" FOREIGN KEY ("originalDocumentId") REFERENCES "FiscalDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingProfile" ADD CONSTRAINT "BillingProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingProfile" ADD CONSTRAINT "BillingProfile_vatValidationId_fkey" FOREIGN KEY ("vatValidationId") REFERENCES "VatValidation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingRate" ADD CONSTRAINT "ShippingRate_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "ShippingZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "FiscalDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ReturnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- Partial unique indexes (not expressible in schema.prisma — managed here,
-- like the other partial indexes of the baseline).
-- ═══════════════════════════════════════════════════════════════════════════
-- One invoice per order (corrections are credit notes, never a 2nd invoice).
CREATE UNIQUE INDEX "FiscalDocument_one_invoice_per_order"
  ON "FiscalDocument"("orderId") WHERE "kind" = 'INVOICE' AND "orderId" IS NOT NULL;
-- One CURRENT proforma per order (older revisions carry supersededById / voidedAt).
CREATE UNIQUE INDEX "FiscalDocument_one_current_proforma_per_order"
  ON "FiscalDocument"("orderId")
  WHERE "kind" = 'PROFORMA' AND "orderId" IS NOT NULL AND "supersededById" IS NULL AND "voidedAt" IS NULL;
-- One active hold per (source, ref, product): reserve() is idempotent.
CREATE UNIQUE INDEX "StockReservation_one_active_hold"
  ON "StockReservation"("source", "refId", "productId")
  WHERE "releasedAt" IS NULL AND "consumedAt" IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Backfill (existing rows)
-- ═══════════════════════════════════════════════════════════════════════════
-- Every order priced before the VAT engine existed is explicitly LEGACY: its
-- tax is whatever the old flat DEFAULT_TAX_PERCENT produced. History is never
-- recomputed.
UPDATE "Order" SET "vatTreatment" = 'LEGACY_UNSPECIFIED' WHERE "vatTreatment" IS NULL;

-- Money state, from the old single status. A manual "INVOICE" payment method
-- never proved that money arrived (A06), so those orders are INVOICED_ON_TERMS
-- (the owner reviews them), not PAID.
UPDATE "Order" SET "financialStatus" = (CASE
    WHEN "status" = 'CANCELED' THEN 'VOID'
    WHEN "status" = 'REFUNDED' THEN 'REFUNDED'
    WHEN "status" IN ('PAID','PROCESSING','SHIPPED','DELIVERED') AND upper(coalesce("paymentMethodManual", '')) = 'INVOICE' THEN 'INVOICED_ON_TERMS'
    WHEN "status" IN ('PAID','PROCESSING','SHIPPED','DELIVERED') THEN 'PAID'
    WHEN "status" = 'PENDING_PAYMENT' AND "paymentSubmittedAt" IS NOT NULL THEN 'UNDER_REVIEW'
    ELSE 'UNPAID' END)::"FinancialStatus";

-- Ledger: one LEGACY payment per order that was paid by card or by a verified
-- transfer (amount = the order total, value date = paidAt).
INSERT INTO "Payment" ("id", "orderId", "amountCents", "currency", "method", "receivedAt", "reference", "source", "stripePaymentIntentId", "verifiedById", "note")
SELECT 'legacy_pay_' || o."id", o."id", o."totalCents", o."currency",
       CASE WHEN o."stripePaymentIntentId" IS NOT NULL THEN 'STRIPE' ELSE coalesce(nullif(upper(o."paymentMethodManual"), ''), 'BANK_TRANSFER') END,
       coalesce(o."paidAt", o."paymentVerifiedAt", o."updatedAt"), o."orderNumber", 'LEGACY', o."stripePaymentIntentId",
       coalesce(o."paymentVerifiedById", o."paidByAdminId"),
       'Backfilled by 4_business_core from the order status (amount = order total).'
FROM "Order" o
WHERE o."status" IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED')
  AND upper(coalesce(o."paymentMethodManual", '')) <> 'INVOICE';
UPDATE "Order" o SET "amountPaidCents" = p.s
FROM (SELECT "orderId", sum("amountCents")::int AS s FROM "Payment" GROUP BY "orderId") p
WHERE p."orderId" = o."id";

-- Refund ledger for orders already refunded (amount = order total; the old
-- flow only did full refunds). No credit note existed for them — the
-- accountant decides on retro credit notes (see the deploy notes).
INSERT INTO "Refund" ("id", "orderId", "amountCents", "currency", "method", "status", "reason", "restock", "executedAt", "createdAt", "updatedAt")
SELECT 'legacy_ref_' || o."id", o."id", o."totalCents", o."currency",
       CASE WHEN o."stripePaymentIntentId" IS NOT NULL THEN 'STRIPE' ELSE 'BANK_TRANSFER' END,
       'CONFIRMED', 'Backfilled by 4_business_core (legacy refund; no credit note was issued at the time).', false,
       o."updatedAt", o."updatedAt", CURRENT_TIMESTAMP
FROM "Order" o WHERE o."status" = 'REFUNDED';
UPDATE "Order" SET "amountRefundedCents" = "totalCents" WHERE "status" = 'REFUNDED';

-- The proforma number the buyer used as bank reference, on the order itself.
UPDATE "Order" o SET "proformaNumber" = s."proformaNumber"
FROM "SourcingRequest" s
WHERE o."sourcingRequestId" = s."id" AND s."proformaNumber" IS NOT NULL;
-- Payment due date of open quote orders = the proforma due date already printed.
UPDATE "Order" o SET "dueAt" = s."validUntilAt"
FROM "SourcingRequest" s
WHERE o."sourcingRequestId" = s."id" AND o."status" = 'PENDING_PAYMENT' AND s."status" = 'ACCEPTED' AND o."dueAt" IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Triggers
-- ═══════════════════════════════════════════════════════════════════════════
-- (1) Issued documents are immutable and undeletable.
CREATE OR REPLACE FUNCTION l2d_fiscal_document_guard() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Fiscal document % is issued and can never be deleted (retention).', OLD."number"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."series" IS DISTINCT FROM OLD."series" OR NEW."fiscalYear" IS DISTINCT FROM OLD."fiscalYear"
     OR NEW."seq" IS DISTINCT FROM OLD."seq" OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."sourcingRequestId" IS DISTINCT FROM OLD."sourcingRequestId"
     OR NEW."originalDocumentId" IS DISTINCT FROM OLD."originalDocumentId"
     OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate" OR NEW."supplyDate" IS DISTINCT FROM OLD."supplyDate"
     OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate" OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."vatTreatment" IS DISTINCT FROM OLD."vatTreatment"
     OR NEW."subtotalCents" IS DISTINCT FROM OLD."subtotalCents" OR NEW."taxCents" IS DISTINCT FROM OLD."taxCents"
     OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents" OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
     OR NEW."legacy" IS DISTINCT FROM OLD."legacy" OR NEW."issuedById" IS DISTINCT FROM OLD."issuedById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Fiscal document % is immutable: number, dates, amounts and content cannot change.', OLD."number"
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- The stored PDF is written exactly once.
  IF OLD."pdfKey" IS NOT NULL AND (NEW."pdfKey" IS DISTINCT FROM OLD."pdfKey"
       OR NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."pdfBytes" IS DISTINCT FROM OLD."pdfBytes") THEN
    RAISE EXCEPTION 'The stored PDF of % cannot be replaced.', OLD."number" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."sentAt" IS NOT NULL AND NEW."sentAt" IS DISTINCT FROM OLD."sentAt" THEN
    NEW."sentAt" := OLD."sentAt"; -- the first send time is kept
  END IF;
  IF OLD."voidedAt" IS NOT NULL AND (NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt" OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason") THEN
    RAISE EXCEPTION 'Document % is already void.', OLD."number" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."voidedAt" IS NOT NULL AND OLD."voidedAt" IS NULL AND OLD."kind" <> 'PROFORMA' THEN
    RAISE EXCEPTION 'Only a proforma can be voided — correct invoice % with a credit note.', OLD."number"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."supersededById" IS NOT NULL AND NEW."supersededById" IS DISTINCT FROM OLD."supersededById" THEN
    RAISE EXCEPTION 'Document % was already superseded.', OLD."number" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER "FiscalDocument_guard_update" BEFORE UPDATE ON "FiscalDocument"
  FOR EACH ROW EXECUTE FUNCTION l2d_fiscal_document_guard();
CREATE TRIGGER "FiscalDocument_guard_delete" BEFORE DELETE ON "FiscalDocument"
  FOR EACH ROW EXECUTE FUNCTION l2d_fiscal_document_guard();

CREATE OR REPLACE FUNCTION l2d_refuse_truncate() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'TRUNCATE of % is not allowed (retained financial records).', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER "FiscalDocument_no_truncate" BEFORE TRUNCATE ON "FiscalDocument"
  FOR EACH STATEMENT EXECUTE FUNCTION l2d_refuse_truncate();
CREATE TRIGGER "InvoiceSequence_no_truncate" BEFORE TRUNCATE ON "InvoiceSequence"
  FOR EACH STATEMENT EXECUTE FUNCTION l2d_refuse_truncate();

-- (2) A number series never goes backwards (gap-free numbering).
CREATE OR REPLACE FUNCTION l2d_invoice_sequence_guard() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Number series %/% cannot be deleted.', OLD."series", OLD."fiscalYear"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."series" IS DISTINCT FROM OLD."series" OR NEW."fiscalYear" IS DISTINCT FROM OLD."fiscalYear"
     OR NEW."nextValue" < OLD."nextValue" THEN
    RAISE EXCEPTION 'Number series %/% can only move forward.', OLD."series", OLD."fiscalYear"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER "InvoiceSequence_guard" BEFORE UPDATE OR DELETE ON "InvoiceSequence"
  FOR EACH ROW EXECUTE FUNCTION l2d_invoice_sequence_guard();

-- (3) Paid / invoiced / refunded orders are never hard-deleted (A05). The FKs
-- from FiscalDocument, Payment, Refund, Shipment (ON DELETE RESTRICT) cover
-- rows with documents; this also covers rows paid before the ledger existed.
CREATE OR REPLACE FUNCTION l2d_order_delete_guard() RETURNS trigger AS $fn$
BEGIN
  IF OLD."paidAt" IS NOT NULL
     OR OLD."status" IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED')
     OR OLD."financialStatus" IN ('PAID','PARTIALLY_PAID','INVOICED_ON_TERMS','OVERDUE','PARTIALLY_REFUNDED','REFUNDED')
     OR OLD."amountPaidCents" > 0 THEN
    RAISE EXCEPTION 'Order % has payment history and must be retained (archive it instead).', OLD."orderNumber"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER "Order_delete_guard" BEFORE DELETE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION l2d_order_delete_guard();

-- (4) An accepted quote (offer accepted / proforma issued) is never hard-deleted.
CREATE OR REPLACE FUNCTION l2d_quote_delete_guard() RETURNS trigger AS $fn$
BEGIN
  IF OLD."status" = 'ACCEPTED' OR OLD."proformaNumber" IS NOT NULL THEN
    RAISE EXCEPTION 'Quote % was accepted / has a proforma and must be retained (archive it instead).', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER "SourcingRequest_delete_guard" BEFORE DELETE ON "SourcingRequest"
  FOR EACH ROW EXECUTE FUNCTION l2d_quote_delete_guard();

-- (5) financialStatus follows `status` for every write that changes status
-- (or the payment-proof flag) WITHOUT setting financialStatus itself — so the
-- existing order code paths keep it right, while new code can still set it
-- explicitly (INVOICED_ON_TERMS, PARTIALLY_PAID, …).
CREATE OR REPLACE FUNCTION l2d_order_financial_status_sync() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."financialStatus" = 'UNPAID' THEN
      NEW."financialStatus" := (CASE
        WHEN NEW."status" = 'CANCELED' THEN 'VOID'
        WHEN NEW."status" = 'REFUNDED' THEN 'REFUNDED'
        WHEN NEW."status" IN ('PAID','PROCESSING','SHIPPED','DELIVERED') THEN 'PAID'
        WHEN NEW."paymentSubmittedAt" IS NOT NULL THEN 'UNDER_REVIEW'
        ELSE 'UNPAID' END)::"FinancialStatus";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."financialStatus" IS DISTINCT FROM OLD."financialStatus" THEN
    RETURN NEW; -- set explicitly by the writer
  END IF;
  IF NEW."status" IS NOT DISTINCT FROM OLD."status"
     AND NEW."paymentSubmittedAt" IS NOT DISTINCT FROM OLD."paymentSubmittedAt" THEN
    RETURN NEW;
  END IF;
  NEW."financialStatus" := (CASE
    WHEN NEW."status" = 'CANCELED' THEN 'VOID'
    WHEN NEW."status" = 'REFUNDED' THEN 'REFUNDED'
    WHEN NEW."status" IN ('PAID','PROCESSING','SHIPPED','DELIVERED') THEN
      CASE WHEN OLD."financialStatus" IN ('PAID','INVOICED_ON_TERMS','CREDIT_APPROVED','OVERDUE','PARTIALLY_REFUNDED')
           THEN OLD."financialStatus"::text ELSE 'PAID' END
    WHEN NEW."status" = 'PENDING_PAYMENT' AND NEW."paymentSubmittedAt" IS NOT NULL THEN 'UNDER_REVIEW'
    WHEN NEW."status" = 'PENDING_PAYMENT' THEN
      CASE WHEN OLD."financialStatus" IN ('PARTIALLY_PAID','CREDIT_APPROVED') THEN OLD."financialStatus"::text ELSE 'UNPAID' END
    ELSE OLD."financialStatus"::text END)::"FinancialStatus";
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER "Order_financial_status_sync" BEFORE INSERT OR UPDATE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION l2d_order_financial_status_sync();

-- (6) A canceled order's open proforma is void (no payment is due for it) —
-- whichever code path cancels the order (admin, bulk, sweep, Stripe expiry).
CREATE OR REPLACE FUNCTION l2d_order_void_proformas() RETURNS trigger AS $fn$
BEGIN
  IF NEW."status" = 'CANCELED' AND OLD."status" IS DISTINCT FROM 'CANCELED' THEN
    UPDATE "FiscalDocument"
       SET "voidedAt" = (now() AT TIME ZONE 'UTC'), "voidReason" = 'Order canceled.'
     WHERE "orderId" = NEW."id" AND "kind" = 'PROFORMA' AND "voidedAt" IS NULL AND "supersededById" IS NULL;
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER "Order_void_proformas_on_cancel" AFTER UPDATE OF "status" ON "Order"
  FOR EACH ROW EXECUTE FUNCTION l2d_order_void_proformas();

-- ═══════════════════════════════════════════════════════════════════════════
-- Country policy seed. EU membership + standard VAT rates are facts the VAT
-- engine needs (verify the rates yearly). The ship-to MODE values are
-- SUGGESTED defaults only — the owner confirms them in Admin → Settings →
-- Compliance & countries. Countries not listed fall back to the
-- COMPLIANCE_UNKNOWN_COUNTRY_POLICY setting (default REVIEW).
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO "CountryPolicy" ("country", "name", "isEu", "vatStandardRateBp", "mode", "note", "updatedAt") VALUES
  ('AT','Austria',true,2000,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('BE','Belgium',true,2100,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('BG','Bulgaria',true,2000,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('HR','Croatia',true,2500,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('CY','Cyprus',true,1900,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('CZ','Czechia',true,2100,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('DK','Denmark',true,2500,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('EE','Estonia',true,2400,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('FI','Finland',true,2550,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('FR','France',true,2000,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('DE','Germany',true,1900,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('GR','Greece',true,2400,'ALLOW','VAT IDs use the prefix EL.',CURRENT_TIMESTAMP),
  ('HU','Hungary',true,2700,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('IE','Ireland',true,2300,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('IT','Italy',true,2200,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('LV','Latvia',true,2100,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('LT','Lithuania',true,2100,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('LU','Luxembourg',true,1700,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('MT','Malta',true,1800,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('NL','Netherlands',true,2100,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('PL','Poland',true,2300,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('PT','Portugal',true,2300,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('RO','Romania',true,2100,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('SK','Slovakia',true,2300,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('SI','Slovenia',true,2200,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('ES','Spain',true,2100,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('SE','Sweden',true,2500,'ALLOW',NULL,CURRENT_TIMESTAMP),
  ('GB','United Kingdom',false,NULL,'ALLOW','Suggested default — confirm.',CURRENT_TIMESTAMP),
  ('CH','Switzerland',false,NULL,'ALLOW','Suggested default — confirm.',CURRENT_TIMESTAMP),
  ('NO','Norway',false,NULL,'ALLOW','Suggested default — confirm.',CURRENT_TIMESTAMP),
  ('IS','Iceland',false,NULL,'ALLOW','Suggested default — confirm.',CURRENT_TIMESTAMP),
  ('LI','Liechtenstein',false,NULL,'ALLOW','Suggested default — confirm.',CURRENT_TIMESTAMP),
  ('US','United States',false,NULL,'ALLOW','Suggested default — confirm.',CURRENT_TIMESTAMP),
  ('CA','Canada',false,NULL,'ALLOW','Suggested default — confirm.',CURRENT_TIMESTAMP),
  ('AU','Australia',false,NULL,'ALLOW','Suggested default — confirm.',CURRENT_TIMESTAMP),
  ('AE','United Arab Emirates',false,NULL,'ALLOW','Suggested default — confirm.',CURRENT_TIMESTAMP),
  ('TR','Türkiye',false,NULL,'REVIEW','Suggested default: review each order (re-export risk).',CURRENT_TIMESTAMP),
  ('IR','Iran',false,NULL,'REVIEW','Suggested default: EU restrictive measures — screen goods and end user before every sale.',CURRENT_TIMESTAMP),
  ('RU','Russia',false,NULL,'BLOCK','Suggested default: EU sanctions (Reg. 833/2014).',CURRENT_TIMESTAMP),
  ('BY','Belarus',false,NULL,'BLOCK','Suggested default: EU sanctions (Reg. 765/2006).',CURRENT_TIMESTAMP),
  ('KP','North Korea',false,NULL,'BLOCK','Suggested default: EU/UN embargo.',CURRENT_TIMESTAMP),
  ('SY','Syria',false,NULL,'BLOCK','Suggested default: EU restrictive measures.',CURRENT_TIMESTAMP),
  ('CU','Cuba',false,NULL,'REVIEW','Suggested default: review (US-origin goods restrictions).',CURRENT_TIMESTAMP)
ON CONFLICT ("country") DO NOTHING;

COMMIT;
