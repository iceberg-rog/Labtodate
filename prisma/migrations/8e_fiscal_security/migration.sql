-- 8e_fiscal_security (team: fiscal + security fixes from the stage-1 verification)
--  * hold reason INVOICE_PENDING: a paid order whose invoice could not be issued
--    (missing legal details / technical error) is really on hold, visibly;
--  * Product.purchaseCostCents: purchase cost of a margin-scheme unit (margin VAT);
--  * a corrected invoice may replace an invoice that a credit note credited in
--    full (legacy / wrong-VAT corrections: credit note + re-issue). It names
--    the invoice it replaces (originalDocumentId) — one replacement each — and
--    a trigger refuses it unless that invoice is credited in full;
--  * only a proforma can ever be marked superseded.
-- Additive except the partial index "one invoice per order", which becomes
-- "one ORIGINAL invoice per order".

ALTER TYPE "OrderHoldReason" ADD VALUE 'INVOICE_PENDING';

ALTER TABLE "Product" ADD COLUMN "purchaseCostCents" INTEGER;

DROP INDEX IF EXISTS "FiscalDocument_one_invoice_per_order";
CREATE UNIQUE INDEX "FiscalDocument_one_invoice_per_order"
  ON "FiscalDocument"("orderId") WHERE "kind" = 'INVOICE' AND "orderId" IS NOT NULL AND "originalDocumentId" IS NULL;
CREATE UNIQUE INDEX "FiscalDocument_one_replacement_per_invoice"
  ON "FiscalDocument"("originalDocumentId") WHERE "kind" = 'INVOICE' AND "originalDocumentId" IS NOT NULL;

CREATE OR REPLACE FUNCTION l2d_fiscal_document_insert_guard() RETURNS trigger AS $fn$
DECLARE
  orig RECORD;
  credited BIGINT;
BEGIN
  IF NEW."kind" = 'INVOICE' AND NEW."originalDocumentId" IS NOT NULL THEN
    SELECT "id", "kind", "orderId", "totalCents", "number" INTO orig FROM "FiscalDocument" WHERE "id" = NEW."originalDocumentId";
    IF orig."id" IS NULL OR orig."kind" <> 'INVOICE' OR orig."orderId" IS DISTINCT FROM NEW."orderId" THEN
      RAISE EXCEPTION 'A corrected invoice must replace an invoice of the same order.' USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT COALESCE(-SUM("totalCents"), 0) INTO credited FROM "FiscalDocument"
      WHERE "originalDocumentId" = orig."id" AND "kind" = 'CREDIT_NOTE';
    IF credited < orig."totalCents" THEN
      RAISE EXCEPTION 'Invoice % is not credited in full — issue the credit note first, then the corrected invoice.', orig."number"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."kind" = 'CREDIT_NOTE' AND NEW."originalDocumentId" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "FiscalDocument" WHERE "id" = NEW."originalDocumentId" AND "kind" = 'INVOICE') THEN
      RAISE EXCEPTION 'A credit note can only correct an invoice.' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER "FiscalDocument_guard_insert" BEFORE INSERT ON "FiscalDocument"
  FOR EACH ROW EXECUTE FUNCTION l2d_fiscal_document_insert_guard();

-- (1) of 4_business_core, plus: only a proforma can be superseded (by a revision).
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
  IF NEW."supersededById" IS NOT NULL AND OLD."supersededById" IS NULL AND OLD."kind" <> 'PROFORMA' THEN
    RAISE EXCEPTION 'Only a proforma can be replaced by a revision — correct % with a credit note.', OLD."number"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
