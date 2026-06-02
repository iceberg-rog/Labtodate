-- Phase 5: free-text admin notes on orders + createdAt index for date-range filtering.
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "adminNotes" TEXT;

CREATE INDEX IF NOT EXISTS "Order_createdAt_idx" ON "Order" ("createdAt");
