-- How many units each order line actually took off the listing's stock.
-- Nullable with no backfill: existing lines read as `quantity`, which is how
-- the stock code treated them so far. Adds one column; no data changes.
ALTER TABLE "OrderItem" ADD COLUMN "stockTaken" INTEGER;
