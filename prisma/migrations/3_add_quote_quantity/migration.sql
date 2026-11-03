-- Quantity on a proforma. Both columns are nullable with no backfill: an
-- existing quote has no quantity recorded and is read as 1 unit at
-- "quotedPriceCents", which is exactly how it was issued.
ALTER TABLE "SourcingRequest" ADD COLUMN "quotedUnitCents" INTEGER;
ALTER TABLE "SourcingRequest" ADD COLUMN "quotedQuantity" INTEGER;
