-- 8c_fulfilment_returns (team: fulfilment, cancellation, returns & refunds)
-- Shipments with the lines they carry (partial shipments, A27 notification
-- stamps), the refund ledger REQUESTED -> SENT -> CONFIRMED (A28), the RMA
-- workflow fields (B14), payout-bank change history for acquisitions (A23), and
-- one trigger fix: a PAID order that is canceled before shipping keeps its money
-- state (the refund is still owed) instead of turning VOID. Additive only.

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" TEXT,
ADD COLUMN     "payeeIban" TEXT,
ADD COLUMN     "requestedEmailAt" TIMESTAMP(3),
ADD COLUMN     "returnId" TEXT,
ADD COLUMN     "sentById" TEXT,
ADD COLUMN     "sentEmailAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "inspectedAt" TIMESTAMP(3),
ADD COLUMN     "inspectedById" TEXT,
ADD COLUMN     "inspectionNote" TEXT,
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "labelKey" TEXT,
ADD COLUMN     "noReturnNeeded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "openedBy" TEXT NOT NULL DEFAULT 'BUYER',
ADD COLUMN     "receivedById" TEXT,
ADD COLUMN     "resolutionNote" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT,
ADD COLUMN     "restockedQty" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "returnCarrier" TEXT,
ADD COLUMN     "returnTracking" TEXT;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "deliveredBy" TEXT,
ADD COLUMN     "deliveredEmailAt" TIMESTAMP(3),
ADD COLUMN     "podUploadedAt" TIMESTAMP(3),
ADD COLUMN     "seq" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "shippedEmailAt" TIMESTAMP(3),
ADD COLUMN     "trackingEmailAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ShipmentItem" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "serial" TEXT,

    CONSTRAINT "ShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankDetailsChange" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "stageAtRequest" TEXT,
    "ibanValid" BOOLEAN NOT NULL DEFAULT false,
    "holderMatches" BOOLEAN NOT NULL DEFAULT false,
    "requestedById" TEXT,
    "requestedByEmail" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "callbackConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankDetailsChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShipmentItem_shipmentId_idx" ON "ShipmentItem"("shipmentId");

-- CreateIndex
CREATE INDEX "ShipmentItem_orderItemId_idx" ON "ShipmentItem"("orderItemId");

-- CreateIndex
CREATE INDEX "BankDetailsChange_submissionId_idx" ON "BankDetailsChange"("submissionId");

-- CreateIndex
CREATE INDEX "BankDetailsChange_status_idx" ON "BankDetailsChange"("status");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ReturnRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankDetailsChange" ADD CONSTRAINT "BankDetailsChange_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SellSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── financialStatus sync (replaces the 4_business_core function) ─────────────
-- Only change: CANCELED keeps a paid order's money state (PAID / PARTIALLY_PAID /
-- PARTIALLY_REFUNDED) — the refund is owed until it is sent; the refund ledger
-- moves it to REFUNDED. An unpaid order still becomes VOID.
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
    WHEN NEW."status" = 'CANCELED' THEN
      CASE WHEN OLD."financialStatus" IN ('PAID','PARTIALLY_PAID','PARTIALLY_REFUNDED')
                AND NEW."amountPaidCents" + (CASE WHEN NEW."paidAt" IS NOT NULL AND NEW."amountPaidCents" = 0 THEN NEW."totalCents" ELSE 0 END) > NEW."amountRefundedCents"
           THEN OLD."financialStatus"::text ELSE 'VOID' END
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

-- ── Shipment / ShipmentItem / BankDetailsChange are records: never deleted ──
CREATE OR REPLACE FUNCTION l2d_refuse_delete_record() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION '% rows are part of the order / payout record and are never deleted.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER "Shipment_no_delete" BEFORE DELETE ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION l2d_refuse_delete_record();
CREATE TRIGGER "ShipmentItem_no_delete" BEFORE DELETE ON "ShipmentItem"
  FOR EACH ROW EXECUTE FUNCTION l2d_refuse_delete_record();
CREATE TRIGGER "Refund_no_delete" BEFORE DELETE ON "Refund"
  FOR EACH ROW EXECUTE FUNCTION l2d_refuse_delete_record();
CREATE TRIGGER "BankDetailsChange_no_delete" BEFORE DELETE ON "BankDetailsChange"
  FOR EACH ROW EXECUTE FUNCTION l2d_refuse_delete_record();

-- ── Backfill: one Shipment (all lines) per order that was shipped before 8c ──
-- Keeps the Order.tracking* / shippedAt / deliveredAt columns as they are (the
-- "latest" denormalised copy); from now on shipments are the record.
INSERT INTO "Shipment" ("id", "orderId", "seq", "carrier", "trackingNumber", "parcels", "shippedAt", "deliveredAt", "deliveredBy", "note", "createdAt", "updatedAt", "shippedEmailAt")
SELECT 'mig8c' || replace(gen_random_uuid()::text, '-', ''), o."id", 1, o."trackingCarrier", o."trackingNumber", 1,
       COALESCE(o."shippedAt", o."deliveredAt", o."updatedAt"), o."deliveredAt",
       CASE WHEN o."deliveredAt" IS NOT NULL THEN 'LEGACY' ELSE NULL END,
       'Recorded before shipments existed (8c backfill).', now(), now(), COALESCE(o."shippedAt", o."updatedAt")
  FROM "Order" o
 WHERE (o."shippedAt" IS NOT NULL OR o."status" IN ('SHIPPED', 'DELIVERED'))
   AND NOT EXISTS (SELECT 1 FROM "Shipment" s WHERE s."orderId" = o."id");

INSERT INTO "ShipmentItem" ("id", "shipmentId", "orderItemId", "qty")
SELECT 'mig8c' || replace(gen_random_uuid()::text, '-', ''), s."id", i."id", i."quantity"
  FROM "Shipment" s
  JOIN "OrderItem" i ON i."orderId" = s."orderId"
 WHERE s."note" = 'Recorded before shipments existed (8c backfill).'
   AND NOT EXISTS (SELECT 1 FROM "ShipmentItem" x WHERE x."shipmentId" = s."id");
